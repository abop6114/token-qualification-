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

async function makeReport(mintAddress, poolCount = 1) {
  const quote = encodeSolanaPublicKey(Buffer.alloc(32, 90));
  const owner = encodeSolanaPublicKey(Buffer.alloc(32, 71));
  const accountAddress = encodeSolanaPublicKey(Buffer.alloc(32, 72));
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
      return { status: "available", completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20,
        requestedPageSize: 5000, pages: [{ accounts: [{ address: accountAddress, programOwner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"],
          dataBase64: tokenAccountData(mintAddress, owner, 1_000_000), reportedSpace: 165 }], paginationKey: null, contextSlot: 101 }] };
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
async function fixture(mintAddress = OTHER_MINT, poolCount = 1, restrictionRows = null) {
  const report = await makeReport(mintAddress, poolCount);
  const c = makeCase(report);
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
    return calls === 1 ? original(...args) : { schemaVersion: "public-report-validation-result-v1", valid: false,
      error: { code: "metric_ledger_mismatch", message: "secret report content" } };
  };
  try {
    await withConfig(value.config, async () => assertFailure(await resolve(value), "composition_validation_failed", "secret report content"));
  } finally { validatorModule.validatePublicReportCompositionInput = original; }
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

test("combined resolution and D17-D1 validation performance: synthetic report sizes", async () => {
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
  console.log(`D17-D2-B2 benchmark node=${process.version} platform=${process.platform}/${process.arch} rssStartMiB=${(rssStart / 1024 / 1024).toFixed(1)} rssEndMiB=${(rssEnd / 1024 / 1024).toFixed(1)} rssDeltaMiB=${((rssEnd - rssStart) / 1024 / 1024).toFixed(1)} ${JSON.stringify(results)}`);
});
