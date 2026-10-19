const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");

const { deriveSolanaQualificationMetricEvidence } = require("../dist/analysis/solanaQualificationMetricEvidence.js");
const { evaluateSolanaClaimPermissions } = require("../dist/analysis/solanaClaimPermission.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");
const { canonicalizeSolanaReferenceCaseValue } = require("../dist/application/solanaReferenceCase.js");
const { aggregateSolanaReportOperationalTelemetry } = require("../dist/application/solanaReportOperationalTelemetry.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { validatePublicReportCompositionInput } = require("../dist/validation/publicReportComposition.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const OTHER_MINT = key(2);
const NOW = "2026-10-19T15:00:00.000Z";
const PYUSD_RESTRICTIONS = [
  { metricId: "market.primary_pool.market_cap_usd", claimId: "market.market_cap_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
  { metricId: "market.primary_pool.fdv_usd", claimId: "market.fdv_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
];
let fakeProviderCalls = 0;

function mintAccount(address) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(100_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  return { requestedAddress: address, owner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], dataBase64: data.toString("base64") };
}

async function makeInput(mintAddress = MINT) {
  const quote = key(9);
  const poolAddress = key(10);
  const report = await generateSolanaTokenEvidenceReport({
    chain: "solana", assetAddress: mintAddress, historicalTransactions: { status: "not_requested" },
  }, {
    getAccount: async (address) => { fakeProviderCalls += 1; return mintAccount(address); },
    getMarkets: async () => {
      fakeProviderCalls += 1;
      return [{ chainId: "solana", poolAddress, dexId: "synthetic-dex", baseTokenAddress: mintAddress, quoteTokenAddress: quote,
        priceUsd: "1.25", marketCapUsd: "1250000", fdvUsd: "1500000", liquidityUsd: "500000", volumeUsd: { h24: "75000" }, poolCreatedAt: null }];
    },
    getTokenAccountPages: async () => {
      fakeProviderCalls += 1;
      return { status: "available", completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20,
        requestedPageSize: 5000, pages: [{ accounts: [], paginationKey: null, contextSlot: 101 }] };
    },
    now: () => new Date(NOW),
  });
  const metrics = deriveSolanaQualificationMetricEvidence(report);
  const claims = evaluateSolanaClaimPermissions(report);
  return { schemaVersion: "public-report-composition-input-v1", report, metrics, claims };
}

function note(caseValue) {
  return JSON.stringify({
    schemaVersion: "solana-reference-case-analyst-note-v1", caseId: caseValue.caseId,
    caseHash: caseValue.contentHash.digestHex, reviewerPseudonym: "Synthetic reviewer",
    reviewedAt: NOW, evidenceReferences: [], observations: [], uncertainties: [], alternativeExplanations: [],
    disagreements: [], openQuestions: [],
  });
}

function makeCase(report) {
  const payload = {
    schemaVersion: "solana-reference-case-v1", caseId: "11111111-2222-4333-8444-555555555555",
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
  const caseValue = { ...payload, contentHash: { algorithm: "sha256", canonicalization: "tqe-canonical-json-v1", digestHex } };
  return canonicalizeSolanaReferenceCaseValue(caseValue);
}

async function makeCaseInput(mintAddress = OTHER_MINT) {
  const input = await makeInput(mintAddress);
  const caseJson = makeCase(input.report);
  const caseValue = JSON.parse(caseJson);
  const analystNoteJson = note(caseValue);
  return { input, caseValue, caseJson, analystNoteJson };
}

function overlayFor(caseValue, analystNoteJson, restrictions = PYUSD_RESTRICTIONS) {
  return {
    schemaVersion: "token-analyst-restriction-overlay-v1", caseId: caseValue.caseId,
    caseContentHash: caseValue.contentHash.digestHex,
    analystNoteSha256: createHash("sha256").update(analystNoteJson, "utf8").digest("hex"),
    reviewerPseudonym: "Synthetic reviewer", reviewedAt: NOW, restrictions,
  };
}

function assertInvalid(input, review, code) {
  const result = validatePublicReportCompositionInput(input, review);
  assert.equal(result.valid, false);
  assert.equal(result.error.code, code);
  assert.equal("report" in result, false, "invalid validation must not return a partial report");
  assert.equal(result.error.message.includes(JSON.stringify(input)), false);
  return result;
}

test("valid ordinary report is accepted while labeling its review assertion unverified", async () => {
  const input = await makeInput(OTHER_MINT);
  const result = validatePublicReportCompositionInput(input, { disposition: "not_applicable" });
  assert.deepEqual(result, { schemaVersion: "public-report-validation-result-v1", valid: true,
    review: { assertedDisposition: "not_applicable", authority: "unverified_assertion" }, restrictionCount: 0 });
});

test("valid case-bound report accepts explicit no-restrictions disposition", async () => {
  const { input, caseJson, analystNoteJson } = await makeCaseInput(OTHER_MINT);
  const result = validatePublicReportCompositionInput(input, { disposition: "case_bound_no_restrictions_confirmed", referenceCaseArtifactJson: caseJson, analystNoteJson });
  assert.equal(result.valid, true);
  assert.deepEqual(result.review, { assertedDisposition: "case_bound_no_restrictions_confirmed", authority: "unverified_assertion" });
});

test("valid PYUSD-like provider_reported_only overlay is accepted without changing D10", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(MINT);
  const originalClaims = structuredClone(input.claims);
  const overlay = overlayFor(caseValue, analystNoteJson);
  const result = validatePublicReportCompositionInput(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson, overlay });
  assert.equal(result.valid, true);
  assert.equal(result.restrictionCount, 2);
  assert.deepEqual(input.claims, originalClaims);
});

test("suppress_value is accepted for allowlisted valuation targets", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(OTHER_MINT);
  const suppressions = PYUSD_RESTRICTIONS.map((item) => ({ ...item, action: "suppress_value" }));
  assert.equal(validatePublicReportCompositionInput(input, {
    disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson,
    overlay: overlayFor(caseValue, analystNoteJson, suppressions),
  }).valid, true);
});

test("missing or unresolved review disposition fails closed", async () => {
  const input = await makeInput(OTHER_MINT);
  assertInvalid(input, undefined, "review_disposition_unresolved");
  assertInvalid(input, { disposition: "unresolved" }, "review_disposition_unresolved");
});

test("caller-controlled review dispositions remain explicitly unverified", async () => {
  const input = await makeInput(OTHER_MINT);
  const valid = validatePublicReportCompositionInput(input, { disposition: "not_applicable" });
  assert.equal(valid.valid, true);
  if (valid.valid) assert.equal(valid.review.authority, "unverified_assertion");
  const { input: caseInput, caseValue, caseJson, analystNoteJson } = await makeCaseInput(MINT);
  const callerFabricatedReview = validatePublicReportCompositionInput(caseInput, {
    disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson,
    overlay: overlayFor(caseValue, analystNoteJson),
  });
  assert.equal(callerFabricatedReview.valid, true, "this API validates structure but has no caller authentication");
  if (callerFabricatedReview.valid) {
    assert.equal(callerFabricatedReview.review.assertedDisposition, "case_bound_restrictions_applied");
    assert.equal(callerFabricatedReview.review.authority, "unverified_assertion");
  }
});

test("unsupported input schema is rejected with a stable code", async () => {
  const input = await makeInput(OTHER_MINT);
  input.schemaVersion = "future-v9";
  assertInvalid(input, { disposition: "not_applicable" }, "unsupported_schema");
  const sourceSchema = await makeInput(OTHER_MINT);
  sourceSchema.metrics.schemaVersion = "future-ledger-v2";
  assertInvalid(sourceSchema, { disposition: "not_applicable" }, "unsupported_schema");
});

test("chain and mint identity mismatch are rejected", async () => {
  const input = await makeInput(OTHER_MINT);
  input.claims.mintAddress = MINT;
  assertInvalid(input, { disposition: "not_applicable" }, "identity_mismatch");
  const other = await makeInput(OTHER_MINT);
  other.report.chain = "base";
  assertInvalid(other, { disposition: "not_applicable" }, "identity_mismatch");
});

test("metric-ledger mismatch is rejected", async () => {
  const input = await makeInput(OTHER_MINT);
  input.metrics.entries[0].value = "999";
  assertInvalid(input, { disposition: "not_applicable" }, "metric_ledger_mismatch");
});

test("metric ledger rejects missing, duplicate, reordered, and evidence-reference changes", async () => {
  const mutations = [
    (input) => { input.metrics.entries.pop(); },
    (input) => { input.metrics.entries.push(structuredClone(input.metrics.entries[0])); },
    (input) => { input.metrics.entries.reverse(); },
    (input) => { input.metrics.entries[0].source.fieldPath += ".changed"; },
  ];
  for (const mutate of mutations) {
    const input = await makeInput(OTHER_MINT);
    mutate(input);
    assertInvalid(input, { disposition: "not_applicable" }, "metric_ledger_mismatch");
  }
});

test("source-ledger timestamps must link exactly to report generation time", async () => {
  const input = await makeInput(OTHER_MINT);
  input.metrics.sourceReportGeneratedAt = "2026-10-18T15:00:00.000Z";
  assertInvalid(input, { disposition: "not_applicable" }, "source_linkage_mismatch");
});

test("D10 claim-result mismatch is rejected", async () => {
  const input = await makeInput(OTHER_MINT);
  input.claims.claims.find((claim) => claim.id === "market.market_cap_usd").value = "999";
  assertInvalid(input, { disposition: "not_applicable" }, "claim_permission_mismatch");
});

test("D10 claim ledger rejects missing, duplicate, reordered, and evidence-reference changes", async () => {
  const mutations = [
    (input) => { input.claims.claims.pop(); },
    (input) => { input.claims.claims.push(structuredClone(input.claims.claims[0])); },
    (input) => { input.claims.claims.reverse(); },
    (input) => { input.claims.claims[0].evidence[0].fieldPath += ".changed"; },
  ];
  for (const mutate of mutations) {
    const input = await makeInput(OTHER_MINT);
    mutate(input);
    assertInvalid(input, { disposition: "not_applicable" }, "claim_permission_mismatch");
  }
});

test("case ID, report binding, and canonical case hash are checked", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(OTHER_MINT);
  const changedId = JSON.parse(caseJson);
  changedId.caseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assertInvalid(input, { disposition: "case_bound_no_restrictions_confirmed", referenceCaseArtifactJson: canonicalizeSolanaReferenceCaseValue(changedId), analystNoteJson }, "case_binding_invalid");
  const badHash = JSON.parse(caseJson);
  badHash.contentHash.digestHex = "0".repeat(64);
  assertInvalid(input, { disposition: "case_bound_no_restrictions_confirmed", referenceCaseArtifactJson: canonicalizeSolanaReferenceCaseValue(badHash), analystNoteJson }, "case_binding_invalid");
  assertInvalid(input, { disposition: "case_bound_no_restrictions_confirmed", referenceCaseArtifactJson: caseJson, analystNoteJson: note({ ...caseValue, caseId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) }, "analyst_note_invalid");
});

test("analyst-note raw byte hash is bound to overlay", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(MINT);
  const overlay = overlayFor(caseValue, analystNoteJson);
  assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson,
    analystNoteJson: `${analystNoteJson} `, overlay }, "restriction_overlay_invalid");
  overlay.analystNoteSha256 = "0".repeat(64);
  assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson, overlay }, "restriction_overlay_invalid");
});

test("invalid analyst-note JSON and duplicate root or nested keys fail with sanitized errors", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(MINT);
  const overlayForNote = (raw) => overlayFor(caseValue, raw);
  for (const raw of [
    "{not-json}",
    analystNoteJson.replace('"schemaVersion":"solana-reference-case-analyst-note-v1"', '"schemaVersion":"bad","schemaVersion":"solana-reference-case-analyst-note-v1"'),
  ]) {
    const result = validatePublicReportCompositionInput(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson,
      analystNoteJson: raw, overlay: overlayForNote(raw) });
    assert.equal(result.valid, false);
    assert.equal(result.error.code, "analyst_note_invalid");
    assert.equal(JSON.stringify(result).includes(raw), false);
  }
  const nestedDuplicate = `{"schemaVersion":"solana-reference-case-analyst-note-v1","caseId":"${caseValue.caseId}","caseHash":"${caseValue.contentHash.digestHex}","reviewerPseudonym":"Synthetic reviewer","reviewedAt":"${NOW}","evidenceReferences":[],"observations":[],"uncertainties":[],"alternativeExplanations":[],"disagreements":[{"topic":"a","topic":"b","position":"p","rationale":"r"}],"openQuestions":[]}`;
  const nestedResult = validatePublicReportCompositionInput(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson,
    analystNoteJson: nestedDuplicate, overlay: overlayForNote(nestedDuplicate) });
  assert.equal(nestedResult.valid, false);
  assert.equal(nestedResult.error.code, "analyst_note_invalid");
});

test("missing or malformed reviewer provenance is rejected", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(OTHER_MINT);
  const badNote = JSON.parse(analystNoteJson);
  badNote.reviewerPseudonym = " ";
  assertInvalid(input, { disposition: "case_bound_no_restrictions_confirmed", referenceCaseArtifactJson: caseJson, analystNoteJson: JSON.stringify(badNote) }, "analyst_note_invalid");
  badNote.reviewerPseudonym = "reviewer";
  badNote.reviewedAt = "yesterday";
  const invalidTimeNote = JSON.stringify(badNote);
  const overlay = overlayFor(caseValue, invalidTimeNote);
  assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson: invalidTimeNote, overlay }, "analyst_note_invalid");
});

test("duplicate, conflicting, unknown, and invalid-explanation restrictions fail", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(OTHER_MINT);
  for (const [rows, code] of [
    [[...PYUSD_RESTRICTIONS, PYUSD_RESTRICTIONS[0]], "restriction_conflict"],
    [[PYUSD_RESTRICTIONS[0], { ...PYUSD_RESTRICTIONS[0], action: "suppress_value" }], "restriction_conflict"],
    [[{ ...PYUSD_RESTRICTIONS[0], claimId: "market.fdv_usd" }], "restriction_target_invalid"],
    [[{ ...PYUSD_RESTRICTIONS[0], metricId: "holders.concentration_top1" }], "restriction_target_invalid"],
    [[{ ...PYUSD_RESTRICTIONS[0], explanationCode: "free text" }], "restriction_target_invalid"],
  ]) {
    assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson, overlay: overlayFor(caseValue, analystNoteJson, rows) }, code);
  }
});

test("provider_reported_only is rejected when supplied evidence is not that basis", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(OTHER_MINT);
  input.report.market.evidence.pools[0].marketCapUsd = { status: "available", value: "1250000", basis: "calculated" };
  input.metrics = deriveSolanaQualificationMetricEvidence(input.report);
  input.claims = evaluateSolanaClaimPermissions(input.report);
  const restricted = [{ ...PYUSD_RESTRICTIONS[0] }];
  const changedCaseJson = makeCase(input.report);
  const changedCaseValue = JSON.parse(changedCaseJson);
  const changedNote = note(changedCaseValue);
  assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: changedCaseJson, analystNoteJson: changedNote,
    overlay: overlayFor(changedCaseValue, changedNote, restricted) }, "restriction_basis_unsupported");
});

test("case-bound overlay rejects a different reviewer or review timestamp", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(MINT);
  const overlay = overlayFor(caseValue, analystNoteJson);
  overlay.reviewedAt = "2026-10-18T15:00:00.000Z";
  assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson, overlay }, "restriction_overlay_invalid");
});

test("case-bound PYUSD report fails closed without its required valuation overlay", async () => {
  const { input, caseJson, analystNoteJson } = await makeCaseInput(MINT);
  assertInvalid(input, { disposition: "case_bound_no_restrictions_confirmed", referenceCaseArtifactJson: caseJson, analystNoteJson }, "review_disposition_unresolved");
  assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson, overlay: {} }, "restriction_overlay_invalid");
});

test("public evidence input cannot carry caller-selected analyst disposition or overlay", async () => {
  const input = await makeInput(OTHER_MINT);
  input.analystReview = { disposition: "case_bound_no_restrictions_confirmed" };
  assertInvalid(input, { disposition: "not_applicable" }, "malformed_input");
});

test("reviewer note schema and case hash are both required", async () => {
  const { input, caseValue, caseJson, analystNoteJson } = await makeCaseInput(MINT);
  const wrongNote = JSON.parse(analystNoteJson);
  wrongNote.caseHash = "0".repeat(64);
  const wrongNoteJson = JSON.stringify(wrongNote);
  assertInvalid(input, { disposition: "case_bound_restrictions_applied", referenceCaseArtifactJson: caseJson, analystNoteJson: wrongNoteJson,
    overlay: overlayFor(caseValue, wrongNoteJson) }, "analyst_note_invalid");
});

test("withheld and not-requested claim values remain exactly as D10 derived them", async () => {
  const input = await makeInput(OTHER_MINT);
  const withheld = input.claims.claims.find((claim) => claim.id === "holders.full_population_count");
  const notRequested = input.claims.claims.find((claim) => claim.id === "historical.sampled_activity");
  assert.equal(withheld.value, null);
  assert.ok(withheld.evidence.every((ref) => ref.value === null && ref.numeratorRaw === null && ref.denominatorRaw === null));
  assert.equal(notRequested.outcome, "not_evaluated_not_requested");
  assert.equal(notRequested.value, null);
  assert.ok(notRequested.evidence.every((ref) => ref.value === null && ref.numeratorRaw === null && ref.denominatorRaw === null));
  assert.equal(validatePublicReportCompositionInput(input, { disposition: "not_applicable" }).valid, true);
});

test("validation failures are sanitized and never include input, provider text, or secrets", async () => {
  const input = await makeInput(OTHER_MINT);
  const secret = "SENTINEL-authenticated-provider-secret";
  input.report.assetAddress = secret;
  const result = assertInvalid(input, { disposition: "not_applicable" }, "identity_mismatch");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("http"), false);
});

test("repeated validation is deterministic and performs no provider calls", async () => {
  const input = await makeInput(OTHER_MINT);
  const before = fakeProviderCalls;
  const first = validatePublicReportCompositionInput(input, { disposition: "not_applicable" });
  const second = validatePublicReportCompositionInput(input, { disposition: "not_applicable" });
  assert.deepEqual(first, second);
  assert.equal(fakeProviderCalls, before);
});

test("validator benchmark records bounded synthetic input and latency distribution", async () => {
  const input = await makeInput(OTHER_MINT);
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  const samples = [];
  const iterations = 120;
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    const result = validatePublicReportCompositionInput(input, { disposition: "not_applicable" });
    samples.push(performance.now() - start);
    assert.equal(result.valid, true);
  }
  samples.sort((a, b) => a - b);
  const median = (samples[59] + samples[60]) / 2;
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const caseFixture = await makeCaseInput(OTHER_MINT);
  const review = { disposition: "case_bound_no_restrictions_confirmed", referenceCaseArtifactJson: caseFixture.caseJson, analystNoteJson: caseFixture.analystNoteJson };
  const caseBytes = Buffer.byteLength(JSON.stringify(caseFixture.input), "utf8")
    + Buffer.byteLength(caseFixture.caseJson, "utf8") + Buffer.byteLength(caseFixture.analystNoteJson, "utf8");
  const caseSamples = [];
  const caseIterations = 60;
  for (let i = 0; i < caseIterations; i += 1) {
    const start = performance.now();
    const result = validatePublicReportCompositionInput(caseFixture.input, review);
    caseSamples.push(performance.now() - start);
    assert.equal(result.valid, true);
  }
  caseSamples.sort((a, b) => a - b);
  const caseMedian = (caseSamples[29] + caseSamples[30]) / 2;
  const caseP95 = caseSamples[Math.ceil(caseSamples.length * 0.95) - 1];
  console.log(`D17-D1 validator benchmark ordinary: bytes=${bytes}; iterations=${iterations}; medianMs=${median.toFixed(3)}; p95Ms=${p95.toFixed(3)}; case-bound: bytes=${caseBytes}; iterations=${caseIterations}; medianMs=${caseMedian.toFixed(3)}; p95Ms=${caseP95.toFixed(3)}; runtime=${process.version}; platform=${process.platform}/${process.arch}`);
  assert.ok(Number.isFinite(median) && Number.isFinite(p95) && Number.isFinite(caseMedian) && Number.isFinite(caseP95));
});
