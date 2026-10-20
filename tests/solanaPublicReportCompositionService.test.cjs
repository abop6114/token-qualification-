const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const os = require("node:os");
const { test } = require("node:test");

const configModule = require("../dist/application/solanaPublicReportCompositionConfiguration.js");
const service = require("../dist/application/solanaPublicReportCompositionService.js");
const validatorModule = require("../dist/validation/publicReportComposition.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");
const { aggregateSolanaReportOperationalTelemetry } = require("../dist/application/solanaReportOperationalTelemetry.js");
const { deriveSolanaQualificationMetricEvidence } = require("../dist/analysis/solanaQualificationMetricEvidence.js");
const { evaluateSolanaClaimPermissions } = require("../dist/analysis/solanaClaimPermission.js");
const { canonicalizeSolanaReferenceCaseValue } = require("../dist/application/solanaReferenceCase.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");

const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const OTHER_MINT = encodeSolanaPublicKey(Buffer.alloc(32, 2));
const CASE_ID = "11111111-2222-4333-8444-555555555555";
const NOW = "2026-10-19T15:00:00.000Z";
const PYUSD_RESTRICTIONS = [
  { metricId: "market.primary_pool.market_cap_usd", claimId: "market.market_cap_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
  { metricId: "market.primary_pool.fdv_usd", claimId: "market.fdv_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
];
let fakeTransportCalls = 0;

function tokenAccountData(mint, owner, amount) {
  const bytes = Buffer.alloc(165);
  // Solana public keys are base58 rather than base64. Use the existing decoder for fixture bytes.
  const { decodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
  Buffer.from(decodeSolanaPublicKey(mint)).copy(bytes, 0);
  Buffer.from(decodeSolanaPublicKey(owner)).copy(bytes, 32);
  bytes.writeBigUInt64LE(BigInt(amount), 64);
  bytes.writeUInt32LE(0, 72);
  bytes[108] = 1;
  bytes.writeUInt32LE(0, 109);
  bytes.writeUInt32LE(0, 129);
  return bytes.toString("base64");
}

async function makeReport(mintAddress, poolCount = 1, holderRows = 1) {
  const quote = encodeSolanaPublicKey(Buffer.alloc(32, 90));
  const pools = Array.from({ length: poolCount }, (_, i) => {
    const poolBytes = Buffer.alloc(32);
    poolBytes.writeUInt32LE(100 + i, 0);
    return {
      chainId: "solana",
      poolAddress: encodeSolanaPublicKey(poolBytes),
      dexId: "synthetic-dex",
      baseTokenAddress: mintAddress,
      quoteTokenAddress: quote,
      priceUsd: "1.25",
      marketCapUsd: "1250000",
      fdvUsd: "1500000",
      liquidityUsd: String(500000 + i),
      volumeUsd: { h24: "75000" },
      poolCreatedAt: null,
    };
  });
  return generateSolanaTokenEvidenceReport({
    chain: "solana", assetAddress: mintAddress, historicalTransactions: { status: "not_requested" },
  }, {
    getAccount: async (address) => {
      fakeTransportCalls += 1;
      const data = Buffer.alloc(82);
      data.writeBigUInt64LE(100_000_000n, 36);
      data[44] = 6;
      data[45] = 1;
      return { requestedAddress: address, owner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], dataBase64: data.toString("base64") };
    },
    getMarkets: async () => { fakeTransportCalls += 1; return pools; },
    getTokenAccountPages: async () => {
      fakeTransportCalls += 1;
      const pages = [];
      for (let start = 0; start < holderRows; start += 5000) {
        const count = Math.min(5000, holderRows - start);
        const accounts = Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          const addressBytes = Buffer.alloc(32);
          addressBytes.writeUInt32LE(index + 1, 0);
          addressBytes.writeUInt32LE(73, 4);
          const ownerBytes = Buffer.alloc(32);
          ownerBytes.writeUInt32LE(index + 500_000, 0);
          return { address: encodeSolanaPublicKey(addressBytes), programOwner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"],
            dataBase64: tokenAccountData(mintAddress, encodeSolanaPublicKey(ownerBytes), holderRows === 1 ? 1_000_000 : 1), reportedSpace: 165 };
        });
        const cursorBytes = Buffer.alloc(32);
        cursorBytes.writeUInt32LE(start + count + 1000, 0);
        pages.push({ accounts, paginationKey: start + count < holderRows ? encodeSolanaPublicKey(cursorBytes) : null, contextSlot: 101 + pages.length });
      }
      if (holderRows === 0) pages.push({ accounts: [], paginationKey: null, contextSlot: 101 });
      return { status: "available", completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20,
        requestedPageSize: 5000, pages };
    },
    now: () => new Date(NOW),
  });
}

function makeCase(report, caseId = CASE_ID) {
  const payload = {
    schemaVersion: "solana-reference-case-v1", caseId,
    identity: { chain: "solana", mintAddress: report.assetAddress },
    capture: {
      startedAt: NOW, completedAt: NOW,
      request: { chain: "solana", assetAddress: report.assetAddress, historicalTransactions: { status: "not_requested" } },
      executionBoundary: "protected_public_execution", captureOrigin: "protected_application_composition",
      requestBudgetEnvelope: 22,
      operationalTelemetry: aggregateSolanaReportOperationalTelemetry({ requestObservations: [], stageObservations: [], reportElapsedMs: null }),
    },
    evidenceReport: report, limitations: ["history_not_requested", "report_not_atomic"],
  };
  const digestHex = createHash("sha256").update(canonicalizeSolanaReferenceCaseValue(payload), "utf8").digest("hex");
  const value = { ...payload, contentHash: { algorithm: "sha256", canonicalization: "tqe-canonical-json-v1", digestHex } };
  return { value, json: canonicalizeSolanaReferenceCaseValue(value) };
}

function makeNote(caseValue) {
  return JSON.stringify({ schemaVersion: "solana-reference-case-analyst-note-v1", caseId: caseValue.caseId,
    caseHash: caseValue.contentHash.digestHex, reviewerPseudonym: "Synthetic Reviewer", reviewedAt: NOW,
    evidenceReferences: [], observations: [], uncertainties: [], alternativeExplanations: [], disagreements: [], openQuestions: [] });
}
function sha256(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }
function makeRecord(caseValue, note, overrides = {}) {
  return { recordId: `record-${caseValue.caseId}`, recordVersion: 1, caseId: caseValue.caseId, chain: "solana",
    mintAddress: caseValue.identity.mintAddress, caseContentSha256: caseValue.contentHash.digestHex,
    analystNoteSha256: sha256(note), disposition: "case_bound_no_restrictions_confirmed", restrictions: [],
    reviewerPseudonym: "Synthetic Reviewer", reviewedAt: NOW, ...overrides };
}
function configFor(records, artifacts, overrides = {}) {
  return { registry: { schemaVersion: "public-report-review-registry-v1", records },
    readCaseArtifactJson: async (caseId) => artifacts.get(caseId)?.caseJson ?? null,
    readAnalystNoteJson: async (caseId) => artifacts.get(caseId)?.noteJson ?? null,
    ...overrides };
}
async function fixture(mintAddress = OTHER_MINT, poolCount = 1, restrictionRows = null, caseId = CASE_ID, holderRows = 1) {
  const report = await makeReport(mintAddress, poolCount, holderRows);
  const c = makeCase(report, caseId);
  const noteJson = makeNote(c.value);
  const restrictions = restrictionRows ?? (mintAddress === PYUSD ? PYUSD_RESTRICTIONS : []);
  const record = makeRecord(c.value, noteJson, restrictions.length ? {
    disposition: "case_bound_restrictions_applied", restrictions,
  } : {});
  return { report, caseValue: c.value, caseJson: c.json, noteJson, record,
    config: configFor([record], new Map([[c.value.caseId, { caseJson: c.json, noteJson }]])) };
}
async function withConfig(config, callback) {
  const original = configModule.getSolanaPublicReportCompositionConfiguration;
  configModule.getSolanaPublicReportCompositionConfiguration = () => config;
  try { return await callback(); }
  finally { configModule.getSolanaPublicReportCompositionConfiguration = original; }
}
async function resolve(value) {
  return service.resolveSolanaSavedCaseForPublicReport({ caseId: value.caseValue.caseId });
}
function assertFailure(result, code, secret) {
  assert.equal(result.valid, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.message.includes("C:\\"), false);
  assert.equal(Object.hasOwn(result, "context"), false);
  if (secret) assert.equal(JSON.stringify(result).includes(secret), false);
}

test("valid configured saved case resolves into an opaque, bounded frozen context", async () => {
  const value = await fixture();
  const callsBefore = fakeTransportCalls;
  await withConfig(value.config, async () => {
    const first = await resolve(value);
    const second = await resolve(value);
    assert.equal(first.valid, true);
    assert.deepEqual(first, second);
    assert.equal(service.isValidatedSolanaPublicReportContextHandle(first.context), true);
    const context = service.readValidatedSolanaPublicReportContext(first.context);
    assert.ok(context);
    assert.equal(context.review.resolutionSucceeded, true);
    assert.equal(context.review.registrySource, "application_configuration_source_unverified");
    assert.equal(context.review.validatorAuthority, "unverified_assertion");
    assert.equal(context.identity.assetId, value.caseValue.identity.mintAddress);
    assert.equal(context.metrics.entries.length > 0, true);
    assert.equal(context.claims.claims.length > 0, true);
    assert.deepEqual(context.metrics, deriveSolanaQualificationMetricEvidence(value.report));
    assert.deepEqual(context.claims, evaluateSolanaClaimPermissions(value.report));
    assert.equal(context.provenance.holderCoverage.enumeration, "complete");
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.metrics.entries), true);
    assert.equal(JSON.stringify(context).includes("Synthetic Reviewer"), false);
    assert.equal(JSON.stringify(context).includes(encodeSolanaPublicKey(Buffer.alloc(32, 71))), false, "holder owner rows are absent");
    assert.equal(JSON.stringify(context).includes("operationalTelemetry"), false);
    assert.equal("report" in context, false);
  });
  assert.equal(fakeTransportCalls, callsBefore, "composition performs no acquisition or provider dispatch");
});

test("no-restrictions disposition is preserved without overlay metadata", async () => {
  const value = await fixture(OTHER_MINT);
  await withConfig(value.config, async () => {
    const result = await resolve(value);
    assert.equal(result.valid, true);
    const context = service.readValidatedSolanaPublicReportContext(result.context);
    assert.equal(context.review.disposition, "case_bound_no_restrictions_confirmed");
    assert.deepEqual(context.review.restrictions, []);
  });
});

test("PYUSD-like provider_reported_only restrictions survive validation as metadata", async () => {
  const value = await fixture(PYUSD);
  await withConfig(value.config, async () => {
    const result = await resolve(value);
    assert.equal(result.valid, true);
    const context = service.readValidatedSolanaPublicReportContext(result.context);
    assert.equal(context.review.disposition, "case_bound_restrictions_applied");
    assert.deepEqual(context.review.restrictions, PYUSD_RESTRICTIONS);
    assert.equal(context.claims.claims.find((claim) => claim.id === "market.market_cap_usd").outcome, "permitted",
      "D10 decision remains unchanged; overlay is metadata for the future composer");
  });
});

test("unavailable concentration and not-requested history claim outcomes are reused exactly", async () => {
  const value = await fixture(OTHER_MINT, 1, null, CASE_ID, 0);
  await withConfig(value.config, async () => {
    const result = await resolve(value);
    assert.equal(result.valid, true);
    const context = service.readValidatedSolanaPublicReportContext(result.context);
    assert.deepEqual(context.claims, evaluateSolanaClaimPermissions(value.report));
    assert.equal(context.claims.claims.find((claim) => claim.id === "holders.concentration_top1").outcome, "withheld_insufficient");
    assert.equal(context.claims.claims.find((claim) => claim.id === "historical.sampled_activity").outcome, "not_evaluated_not_requested");
  });
});

test("alternating cases remain isolated and repeated composition is deterministic", async () => {
  const firstCase = await fixture(OTHER_MINT, 1, null, CASE_ID);
  const secondCaseId = "22222222-3333-4444-8555-666666666666";
  const secondCase = await fixture(PYUSD, 2, null, secondCaseId);
  const callsBefore = fakeTransportCalls;
  await withConfig(firstCase.config, async () => {
    const first = await resolve(firstCase);
    const repeated = await resolve(firstCase);
    assert.equal(first.valid, true);
    assert.equal(repeated.valid, true);
    assert.deepEqual(service.readValidatedSolanaPublicReportContext(first.context),
      service.readValidatedSolanaPublicReportContext(repeated.context));
    assert.equal(service.readValidatedSolanaPublicReportContext(first.context).identity.caseId, CASE_ID);
  });
  await withConfig(secondCase.config, async () => {
    const second = await resolve(secondCase);
    assert.equal(second.valid, true);
    const context = service.readValidatedSolanaPublicReportContext(second.context);
    assert.equal(context.identity.caseId, secondCaseId);
    assert.equal(context.identity.assetId, PYUSD);
    assert.deepEqual(context.review.restrictions, PYUSD_RESTRICTIONS);
    assert.deepEqual(context.claims, evaluateSolanaClaimPermissions(secondCase.report));
  });
  assert.equal(fakeTransportCalls, callsBefore, "resolution reuses saved evidence and performs no provider calls");
});

test("suppress_value restriction propagates for a non-PYUSD case when D17-D1 accepts it", async () => {
  const restrictions = [{ metricId: "market.primary_pool.market_cap_usd", claimId: "market.market_cap_usd",
    action: "suppress_value", explanationCode: "valuation_scope_and_denominator_unestablished" }];
  const value = await fixture(OTHER_MINT, 1, restrictions);
  await withConfig(value.config, async () => {
    const result = await resolve(value);
    assert.equal(result.valid, true);
    const context = service.readValidatedSolanaPublicReportContext(result.context);
    assert.deepEqual(context.review.restrictions, restrictions);
  });
});

test("missing registry configuration and missing registry entries fail closed", async () => {
  const value = await fixture();
  await withConfig(null, async () => assertFailure(await resolve(value), "application_configuration_unavailable"));
  let reads = 0;
  await withConfig(configFor([], new Map(), {
    readCaseArtifactJson: async () => { reads += 1; return null; },
    readAnalystNoteJson: async () => { reads += 1; return null; },
  }), async () => assertFailure(await resolve(value), "registry_entry_missing"));
  assert.equal(reads, 0, "unregistered case IDs are rejected before any saved-file lookup");
});

test("caller cannot substitute registry, disposition, overlay, note, or file paths", async () => {
  const value = await fixture();
  await withConfig(value.config, async () => {
    for (const input of [
      { caseId: CASE_ID, registry: value.config.registry },
      { caseId: CASE_ID, disposition: "case_bound_no_restrictions_confirmed" },
      { caseId: CASE_ID, overlay: {} },
      { caseId: CASE_ID, analystNotePath: "C:\\private\\note.json" },
      { caseId: CASE_ID, analystNoteJson: value.noteJson },
    ]) {
      assertFailure(await service.resolveSolanaSavedCaseForPublicReport(input),
        input.analystNotePath || input.analystNoteJson ? "invalid_request" : "caller_authority_rejected");
    }
  });
});

test("saved case cannot be relabeled as live evidence", async () => {
  const value = await fixture();
  await withConfig(value.config, async () => {
    for (const input of [{ caseId: CASE_ID, live: true }, { caseId: CASE_ID, source: "live" }, { caseId: CASE_ID, liveRequest: {} }]) {
      assertFailure(await service.resolveSolanaSavedCaseForPublicReport(input), "saved_case_reclassification_rejected");
    }
  });
});

test("missing case or note bytes fail without partial context", async () => {
  const value = await fixture();
  await withConfig(configFor([value.record], new Map(), {
    readCaseArtifactJson: async () => null, readAnalystNoteJson: async () => value.noteJson,
  }), async () => assertFailure(await resolve(value), "saved_evidence_unavailable"));
  await withConfig(configFor([value.record], new Map(), {
    readCaseArtifactJson: async () => value.caseJson, readAnalystNoteJson: async () => null,
  }), async () => assertFailure(await resolve(value), "saved_evidence_unavailable"));
});

test("invalid case and analyst-note byte hashes are rejected", async () => {
  const value = await fixture();
  const tamperedCase = value.caseJson.replace("synthetic-dex", "altered-dex");
  await withConfig(configFor([value.record], new Map([[CASE_ID, { caseJson: tamperedCase, noteJson: value.noteJson }]]), {
    readCaseArtifactJson: async () => tamperedCase, readAnalystNoteJson: async () => value.noteJson,
  }), async () => assertFailure(await resolve(value), "saved_evidence_invalid"));
  await withConfig(configFor([{ ...value.record, analystNoteSha256: "a".repeat(64) }],
    new Map([[CASE_ID, { caseJson: value.caseJson, noteJson: value.noteJson }]])),
  async () => assertFailure(await resolve(value), "saved_evidence_invalid"));
});

test("invalid or incomplete structured overlays fail closed", async () => {
  const value = await fixture(PYUSD);
  const incomplete = [PYUSD_RESTRICTIONS[0]];
  const badValue = { ...value, config: configFor([makeRecord(value.caseValue, value.noteJson, {
    disposition: "case_bound_restrictions_applied", restrictions: incomplete,
  })], new Map([[CASE_ID, { caseJson: value.caseJson, noteJson: value.noteJson }]])) };
  await withConfig(badValue.config, async () => assertFailure(await resolve(value), "review_resolution_failed"));
});

test("unsupported configuration schema and malformed analyst-note JSON fail sanitized", async () => {
  const value = await fixture();
  await withConfig({ ...value.config, registry: { schemaVersion: "unsupported-v9", records: [] } },
    async () => assertFailure(await resolve(value), "registry_invalid"));
  const badNote = "{\"note-secret\":\"do-not-leak\"}";
  const badRecord = makeRecord(value.caseValue, badNote);
  await withConfig(configFor([badRecord], new Map([[CASE_ID, { caseJson: value.caseJson, noteJson: badNote }]]), {
    readCaseArtifactJson: async () => value.caseJson, readAnalystNoteJson: async () => badNote,
  }), async () => assertFailure(await resolve(value), "saved_evidence_invalid", "do-not-leak"));
});

test("duplicate or conflicting configured records are rejected before case access", async () => {
  const value = await fixture();
  const duplicateCase = { ...value.record, recordId: "second-record" };
  await withConfig(configFor([value.record, duplicateCase], new Map([[CASE_ID, { caseJson: value.caseJson, noteJson: value.noteJson }]])),
    async () => assertFailure(await resolve(value), "registry_invalid"));
  const duplicateId = { ...duplicateCase, recordId: value.record.recordId, caseId: "22222222-2222-4333-8444-555555555555" };
  await withConfig(configFor([value.record, duplicateId], new Map()), async () => assertFailure(await resolve(value), "registry_invalid"));
});

test("D17-D1 validation failure returns a sanitized failure and no context", async () => {
  const value = await fixture();
  const original = validatorModule.validatePublicReportCompositionInput;
  let calls = 0;
  validatorModule.validatePublicReportCompositionInput = (...args) => {
    calls += 1;
    return { schemaVersion: "public-report-validation-result-v1", valid: false,
      error: { code: "metric_ledger_mismatch", message: "secret report content" } };
  };
  try {
    await withConfig(value.config, async () => assertFailure(await resolve(value), "saved_evidence_invalid", "secret report content"));
    assert.equal(calls, 1, "resolver validation runs once; invalid validated evidence is rejected before context construction");
  } finally { validatorModule.validatePublicReportCompositionInput = original; }
});

test("a fabricated successful resolver result is rejected without partial context", async () => {
  const value = await fixture();
  const resolverModule = require("../dist/application/publicReportReviewResolver.js");
  // The service deliberately exposes no injection seam; a structurally forged result cannot
  // acquire the module-private WeakMap snapshot even when it copies valid public metadata.
  const forged = { valid: true, resolution: { caseId: CASE_ID } };
  assert.equal(resolverModule.readInternalValidatedPublicReportSnapshot(forged), null);
  assert.equal(resolverModule.readInternalValidatedPublicReportSnapshot({ ...forged }), null);
  const originalFactory = resolverModule.createApplicationControlledPublicReportReviewResolver;
  resolverModule.createApplicationControlledPublicReportReviewResolver = () => ({ valid: true, resolve: () => forged });
  try {
    await withConfig(value.config, async () => assertFailure(await resolve(value), "review_resolution_failed"));
  } finally { resolverModule.createApplicationControlledPublicReportReviewResolver = originalFactory; }
});

test("untrusted handles and caller-controlled review metadata cannot reveal internal context", async () => {
  assert.equal(service.readValidatedSolanaPublicReportContext({}), null);
  assert.equal(service.isValidatedSolanaPublicReportContextHandle({}), false);
  const value = await fixture();
  await withConfig(value.config, async () => {
    const result = await resolve(value);
    assert.equal(result.valid, true);
    const context = service.readValidatedSolanaPublicReportContext(result.context);
    assert.ok(context);
    assert.equal(Object.hasOwn(context.review, "reviewerPseudonym"), false);
    assert.equal(Object.hasOwn(context, "analystNote"), false);
  });
});

test("application default configuration is controlled and empty rather than caller-populated", async () => {
  const original = configModule.getSolanaPublicReportCompositionConfiguration;
  try {
    configModule.getSolanaPublicReportCompositionConfiguration = original;
    const result = await service.resolveSolanaSavedCaseForPublicReport({ caseId: CASE_ID });
    assertFailure(result, "registry_entry_missing");
  } finally { configModule.getSolanaPublicReportCompositionConfiguration = original; }
});

test("combined resolution and composition performance: synthetic market-pool sizes", async () => {
  const sizes = [1, 40, 300];
  const iterations = 12;
  const rssStart = process.memoryUsage().rss;
  const results = [];
  for (const poolCount of sizes) {
    const value = await fixture(OTHER_MINT, poolCount);
    const bytes = Buffer.byteLength(value.caseJson, "utf8") + Buffer.byteLength(value.noteJson, "utf8");
    const samples = [];
    await withConfig(value.config, async () => {
      for (let i = 0; i < 3; i += 1) assert.equal((await resolve(value)).valid, true);
      for (let i = 0; i < iterations; i += 1) {
        const start = performance.now();
        const result = await resolve(value);
        samples.push(performance.now() - start);
        assert.equal(result.valid, true);
      }
    });
    samples.sort((a, b) => a - b);
    results.push({ pools: poolCount, bytes, iterations, medianMs: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] });
  }
  const rssEnd = process.memoryUsage().rss;
  console.log(`D17-P3 pool benchmark node=${process.version} platform=${process.platform}/${process.arch} rssStartMiB=${(rssStart / 1024 / 1024).toFixed(1)} rssEndMiB=${(rssEnd / 1024 / 1024).toFixed(1)} rssDeltaMiB=${((rssEnd - rssStart) / 1024 / 1024).toFixed(1)} ${JSON.stringify(results)}`);
});

test("holder-row scaling benchmark with bounded synthetic reports", { skip: process.env.TQE_PERF_HOLDER !== "1" }, async () => {
  const sizes = [1, 1000, 10000, 100000];
  const results = [];
  for (const rows of sizes) {
    const rssBefore = process.memoryUsage().rss;
    const heapBefore = process.memoryUsage().heapUsed;
    const value = await fixture(OTHER_MINT, 1, null, CASE_ID, rows);
    const bytes = Buffer.byteLength(value.caseJson, "utf8") + Buffer.byteLength(value.noteJson, "utf8");
    const samples = [];
    let accepted = false;
    let failureCode = null;
    if (bytes <= 20 * 1024 * 1024) {
      await withConfig(value.config, async () => {
        const warmup = await resolve(value);
        accepted = warmup.valid;
        if (!warmup.valid) failureCode = warmup.error.code;
        if (accepted) {
          const iterations = rows >= 10000 ? 1 : 8;
          for (let index = 0; index < iterations; index += 1) {
            const start = performance.now();
            const result = await resolve(value);
            samples.push(performance.now() - start);
            if (!result.valid) { accepted = false; failureCode = result.error.code; break; }
          }
        }
      });
    }
    samples.sort((left, right) => left - right);
    const medianMs = samples.length ? (samples[Math.floor((samples.length - 1) / 2)] + samples[Math.ceil((samples.length - 1) / 2)]) / 2 : null;
    const p95Ms = samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null;
    results.push({ requestedHolderRows: rows, observedTokenAccounts: value.report.holders.evidence.holderStructure.tokenAccountCount,
      observedOwnerAuthorities: value.report.holders.evidence.holderStructure.rawOwnerCount,
      caseAndNoteBytes: bytes, iterations: samples.length, acceptedByExistingValidation: accepted, failureCode,
      skippedAboveExisting20MiBCap: bytes > 20 * 1024 * 1024,
      medianMs: medianMs === null ? null : Number(medianMs.toFixed(3)), p95Ms: p95Ms === null ? null : Number(p95Ms.toFixed(3)),
      rssDeltaMiB: Number(((process.memoryUsage().rss - rssBefore) / 1024 / 1024).toFixed(1)),
      heapDeltaMiB: Number(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(1)) });
  }
  console.log(`D17-P3 holder benchmark node=${process.version} platform=${process.platform}/${process.arch} ${JSON.stringify(results)}`);
});
