const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");

const { deriveSolanaQualificationMetricEvidence } = require("../dist/analysis/solanaQualificationMetricEvidence.js");
const { evaluateSolanaClaimPermissions } = require("../dist/analysis/solanaClaimPermission.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");
const { aggregateSolanaReportOperationalTelemetry } = require("../dist/application/solanaReportOperationalTelemetry.js");
const { canonicalizeSolanaReferenceCaseValue } = require("../dist/application/solanaReferenceCase.js");
const { createApplicationControlledPublicReportReviewResolver, readInternalValidatedPublicReportSnapshot } = require("../dist/application/publicReportReviewResolver.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");

const MINT = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const OTHER_MINT = encodeSolanaPublicKey(Buffer.alloc(32, 2));
const NOW = "2026-10-19T15:00:00.000Z";
const PYUSD_RESTRICTIONS = [
  { metricId: "market.primary_pool.market_cap_usd", claimId: "market.market_cap_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
  { metricId: "market.primary_pool.fdv_usd", claimId: "market.fdv_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
];
let injectedMockCalls = 0;

function mintAccount(address) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(100_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  return { requestedAddress: address, owner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], dataBase64: data.toString("base64") };
}

async function makeReport(mintAddress) {
  const quote = encodeSolanaPublicKey(Buffer.alloc(32, 9));
  const poolAddress = encodeSolanaPublicKey(Buffer.alloc(32, 10));
  return generateSolanaTokenEvidenceReport({
    chain: "solana", assetAddress: mintAddress, historicalTransactions: { status: "not_requested" },
  }, {
    getAccount: async (address) => { injectedMockCalls += 1; return mintAccount(address); },
    getMarkets: async () => {
      injectedMockCalls += 1;
      return [{ chainId: "solana", poolAddress, dexId: "synthetic-dex", baseTokenAddress: mintAddress, quoteTokenAddress: quote,
        priceUsd: "1.25", marketCapUsd: "1250000", fdvUsd: "1500000", liquidityUsd: "500000", volumeUsd: { h24: "75000" }, poolCreatedAt: null }];
    },
    getTokenAccountPages: async () => {
      injectedMockCalls += 1;
      return { status: "available", completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20,
        requestedPageSize: 5000, pages: [{ accounts: [], paginationKey: null, contextSlot: 101 }] };
    },
    now: () => new Date(NOW),
  });
}

function makeCase(report, caseId = "11111111-2222-4333-8444-555555555555") {
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

function makeNote(caseValue, overrides = {}) {
  return JSON.stringify({
    schemaVersion: "solana-reference-case-analyst-note-v1", caseId: caseValue.caseId,
    caseHash: caseValue.contentHash.digestHex, reviewerPseudonym: "TQE-Synthetic-Reviewer", reviewedAt: NOW,
    evidenceReferences: [], observations: [], uncertainties: [], alternativeExplanations: [], disagreements: [], openQuestions: [],
    ...overrides,
  });
}

function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function registryRecord(caseValue, analystNoteJson, overrides = {}) {
  return {
    recordId: "review-record-1", recordVersion: 1, caseId: caseValue.caseId, chain: "solana",
    mintAddress: caseValue.identity.mintAddress, caseContentSha256: caseValue.contentHash.digestHex,
    analystNoteSha256: sha256(analystNoteJson), disposition: "case_bound_no_restrictions_confirmed", restrictions: [],
    reviewerPseudonym: "TQE-Synthetic-Reviewer", reviewedAt: NOW,
    ...overrides,
  };
}

function registry(records) { return { schemaVersion: "public-report-review-registry-v1", records }; }

async function fixture(mintAddress = OTHER_MINT) {
  const report = await makeReport(mintAddress);
  const { value: caseValue, json: caseArtifactJson } = makeCase(report);
  const analystNoteJson = makeNote(caseValue);
  const record = registryRecord(caseValue, analystNoteJson);
  return { report, caseValue, caseArtifactJson, analystNoteJson, record, input: { caseArtifactJson, analystNoteJson } };
}

function resolverFor(records) {
  const created = createApplicationControlledPublicReportReviewResolver(registry(records));
  assert.equal(created.valid, true, created.valid ? "" : created.error.message);
  return created.resolve;
}

function assertError(result, code, secretText) {
  assert.equal(result.valid, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.message.includes("{"), false, "errors are fixed and sanitized");
  if (secretText) assert.equal(JSON.stringify(result).includes(secretText), false);
  assert.equal(Object.hasOwn(result, "resolution"), false, "failure returns no partial resolution");
}

test("valid app-configured no-restrictions record resolves deterministically with bounded metadata", async () => {
  const value = await fixture();
  const resolve = resolverFor([value.record]);
  const callsBefore = injectedMockCalls;
  const first = resolve(value.input);
  const second = resolve(value.input);
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.equal(first.resolution.disposition, "case_bound_no_restrictions_confirmed");
  assert.equal(first.resolution.authority, "application_configuration_source_unverified");
  assert.equal(first.resolution.caseContentSha256, value.caseValue.contentHash.digestHex);
  assert.equal(first.resolution.analystNoteSha256, sha256(value.analystNoteJson));
  assert.deepEqual(first.resolution.restrictions, []);
  assert.equal(first.resolution.restrictionOverlay, null);
  assert.equal("caseArtifactJson" in first.resolution, false);
  assert.equal("analystNoteJson" in first.resolution, false);
  assert.equal(injectedMockCalls, callsBefore, "resolver performs no acquisition/provider operations");
  const snapshot = readInternalValidatedPublicReportSnapshot(first);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.referenceCase, value.caseValue);
  assert.deepEqual(snapshot.report, value.report);
  assert.equal(snapshot.registryRecord.recordId, value.record.recordId);
  assert.equal(snapshot.registrySchemaVersion, "public-report-review-registry-v1");
  assert.equal(snapshot.caseArtifactBytesSha256, sha256(value.caseArtifactJson));
  assert.equal(snapshot.analystNoteBytesSha256, sha256(value.analystNoteJson));
  assert.deepEqual(snapshot.metrics, deriveSolanaQualificationMetricEvidence(value.report));
  assert.deepEqual(snapshot.claims, evaluateSolanaClaimPermissions(value.report));
  assert.equal(snapshot.validation.valid, true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.registryRecord.restrictions), true);
  assert.equal(readInternalValidatedPublicReportSnapshot({ ...first }), null, "copied/fabricated results cannot access the private snapshot");
  assert.equal(readInternalValidatedPublicReportSnapshot({ valid: true, resolution: first.resolution }), null);
});

test("valid structured PYUSD restrictions are bound to case and raw note bytes", async () => {
  const value = await fixture(MINT);
  const restrictions = PYUSD_RESTRICTIONS.map((row) => ({ ...row }));
  const record = registryRecord(value.caseValue, value.analystNoteJson, {
    disposition: "case_bound_restrictions_applied", restrictions,
  });
  const result = resolverFor([record])(value.input);
  assert.equal(result.valid, true);
  assert.equal(result.resolution.disposition, "case_bound_restrictions_applied");
  assert.deepEqual(result.resolution.restrictionOverlay, {
    schemaVersion: "token-analyst-restriction-overlay-v1", caseId: record.caseId,
    caseContentHash: record.caseContentSha256, analystNoteSha256: record.analystNoteSha256,
    reviewerPseudonym: record.reviewerPseudonym, reviewedAt: record.reviewedAt, restrictions,
  });
  assert.equal(result.resolution.restrictions.length, 2);
});

test("missing and ambiguous registry case entries fail closed", async () => {
  const value = await fixture();
  assertError(resolverFor([])(value.input), "registry_entry_missing");
  const duplicate = { ...value.record, recordId: "review-record-2" };
  const created = createApplicationControlledPublicReportReviewResolver(registry([value.record, duplicate]));
  assert.equal(created.valid, false);
  assert.equal(created.error.code, "registry_entry_ambiguous");
  const duplicateId = createApplicationControlledPublicReportReviewResolver(registry([value.record, { ...duplicate, recordId: value.record.recordId, caseId: "22222222-2222-4333-8444-555555555555" }]));
  assert.equal(duplicateId.valid, false);
  assert.equal(duplicateId.error.code, "duplicate_registry_record");
});

test("case identity, chain, mint, and canonical hash mismatches are rejected", async () => {
  const value = await fixture();
  assertError(resolverFor([{ ...value.record, caseId: "22222222-2222-4333-8444-555555555555" }])(value.input), "registry_entry_missing");
  for (const overrides of [{ mintAddress: MINT }, { caseContentSha256: "a".repeat(64) }]) {
    assertError(resolverFor([{ ...value.record, ...overrides }])(value.input), "identity_mismatch");
  }
  const wrongChain = createApplicationControlledPublicReportReviewResolver(registry([{ ...value.record, chain: "ethereum" }]));
  assert.equal(wrongChain.valid, false);
  assert.equal(wrongChain.error.code, "malformed_registry", "this Solana-only registry schema rejects unsupported chain values");
});

test("invalid saved artifact and note bytes fail with sanitized codes", async () => {
  const value = await fixture();
  const resolve = resolverFor([value.record]);
  assertError(resolve({ ...value.input, caseArtifactJson: value.caseArtifactJson.replace("synthetic-dex", "tampered-dex") }), "case_integrity_invalid");
  assertError(resolve({ ...value.input, analystNoteJson: "not-json {note-secret}" }), "note_binding_mismatch", "note-secret");

  const duplicateKeyNote = value.analystNoteJson.replace('"observations":[]', '"observations":[],"observations":[]');
  const duplicateKeyRecord = registryRecord(value.caseValue, duplicateKeyNote);
  assertError(resolverFor([duplicateKeyRecord])({ ...value.input, analystNoteJson: duplicateKeyNote }), "analyst_note_invalid");
});

test("wrong note hash and note-to-case linkage are rejected", async () => {
  const value = await fixture();
  assertError(resolverFor([{ ...value.record, analystNoteSha256: "b".repeat(64) }])(value.input), "note_binding_mismatch");
  const wrongNote = makeNote(value.caseValue, { caseHash: "c".repeat(64) });
  const wrongNoteRecord = registryRecord(value.caseValue, wrongNote);
  assertError(resolverFor([wrongNoteRecord])({ ...value.input, analystNoteJson: wrongNote }), "analyst_note_invalid");
  const wrongReviewerNote = makeNote(value.caseValue, { reviewerPseudonym: "Different-Reviewer" });
  const wrongReviewerRecord = registryRecord(value.caseValue, wrongReviewerNote);
  assertError(resolverFor([wrongReviewerRecord])({ ...value.input, analystNoteJson: wrongReviewerNote }), "review_metadata_invalid");
});

test("required overlay, target integrity, and duplicate restriction targets are enforced", async () => {
  const value = await fixture(MINT);
  const omitted = registryRecord(value.caseValue, value.analystNoteJson);
  assertError(resolverFor([omitted])(value.input), "overlay_invalid");
  const duplicateRestrictions = [...PYUSD_RESTRICTIONS, { ...PYUSD_RESTRICTIONS[0] }];
  const duplicate = createApplicationControlledPublicReportReviewResolver(registry([registryRecord(value.caseValue, value.analystNoteJson, {
    disposition: "case_bound_restrictions_applied", restrictions: duplicateRestrictions,
  })]));
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.error.code, "malformed_registry");
  const unsupported = createApplicationControlledPublicReportReviewResolver(registry([registryRecord(value.caseValue, value.analystNoteJson, {
    disposition: "case_bound_restrictions_applied", restrictions: [{ ...PYUSD_RESTRICTIONS[0], claimId: "market.fdv_usd" }],
  })]));
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.error.code, "malformed_registry");
});

test("unsupported schema, unknown disposition, and invalid reviewer metadata fail closed", async () => {
  const value = await fixture();
  assert.equal(createApplicationControlledPublicReportReviewResolver({ schemaVersion: "future-v2", records: [] }).error.code, "unsupported_registry_schema");
  for (const overrides of [
    { disposition: "unresolved" },
    { reviewerPseudonym: "reviewer\nsecret" },
    { reviewedAt: "not-a-time" },
  ]) {
    const result = createApplicationControlledPublicReportReviewResolver(registry([{ ...value.record, ...overrides }]));
    assert.equal(result.valid, false);
    assert.equal(result.error.code, "malformed_registry");
  }
});

test("caller-supplied review authority and saved-case-to-live relabeling are rejected", async () => {
  const value = await fixture();
  const resolve = resolverFor([value.record]);
  assertError(resolve({ ...value.input, disposition: "case_bound_no_restrictions_confirmed" }), "caller_authority_rejected");
  assertError(resolve({ ...value.input, overlay: {} }), "caller_authority_rejected");
  assertError(resolve({ ...value.input, liveReport: value.report }), "saved_case_reclassification_rejected");
  assertError(resolve({ ...value.input, report: value.report }), "saved_case_reclassification_rejected");
});

test("registry source mutation after resolver creation cannot change resolved metadata", async () => {
  const value = await fixture();
  const source = registry([value.record]);
  const created = createApplicationControlledPublicReportReviewResolver(source);
  assert.equal(created.valid, true);
  source.records[0].disposition = "case_bound_restrictions_applied";
  source.records[0].reviewerPseudonym = "mutated";
  const result = created.resolve(value.input);
  assert.equal(result.valid, true);
  assert.equal(result.resolution.disposition, "case_bound_no_restrictions_confirmed");
  assert.equal(result.resolution.reviewerPseudonym, "TQE-Synthetic-Reviewer");
});

test("offline resolver latency across synthetic registry sizes", async (t) => {
  const value = await fixture();
  const sizes = [1, 100, 1000];
  const iterations = 60;
  const measurements = [];
  for (const size of sizes) {
    const records = [];
    for (let index = 0; index < size - 1; index += 1) {
      records.push(registryRecord(value.caseValue, value.analystNoteJson, {
        recordId: `synthetic-${index}`,
        caseId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      }));
    }
    records.push({ ...value.record, recordId: `synthetic-target-${size}` });
    const created = createApplicationControlledPublicReportReviewResolver(registry(records));
    assert.equal(created.valid, true);
    for (let warmup = 0; warmup < 10; warmup += 1) assert.equal(created.resolve(value.input).valid, true);
    const samples = [];
    for (let run = 0; run < iterations; run += 1) {
      const start = performance.now();
      const result = created.resolve(value.input);
      samples.push(performance.now() - start);
      assert.equal(result.valid, true);
    }
    samples.sort((left, right) => left - right);
    const median = (samples[Math.floor((samples.length - 1) / 2)] + samples[Math.ceil((samples.length - 1) / 2)]) / 2;
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    measurements.push({ size, iterations, medianMs: Number(median.toFixed(3)), p95Ms: Number(p95.toFixed(3)) });
  }
  console.log(`Resolver benchmark: Node ${process.version}, ${JSON.stringify(measurements)}`);
  t.assert.ok(measurements.every((item) => Number.isFinite(item.medianMs) && Number.isFinite(item.p95Ms)));
});

test("fixture construction uses only injected offline mocks and resolver does not acquire evidence", async () => {
  const beforeFixture = injectedMockCalls;
  const value = await fixture();
  assert.ok(injectedMockCalls > beforeFixture, "fixture report used controlled local mocks");
  const afterFixture = injectedMockCalls;
  assert.equal(resolverFor([value.record])(value.input).valid, true);
  assert.equal(injectedMockCalls, afterFixture, "resolver made no provider or network call");
});
