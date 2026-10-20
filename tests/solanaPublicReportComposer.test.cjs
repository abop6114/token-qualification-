const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");

const configModule = require("../dist/application/solanaPublicReportCompositionConfiguration.js");
const service = require("../dist/application/solanaPublicReportCompositionService.js");
const { composeSolanaPublicReport } = require("../dist/application/solanaPublicReportComposer.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");
const { aggregateSolanaReportOperationalTelemetry } = require("../dist/application/solanaReportOperationalTelemetry.js");
const { canonicalizeSolanaReferenceCaseValue } = require("../dist/application/solanaReferenceCase.js");
const { encodeSolanaPublicKey, decodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");

const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const MINT = encodeSolanaPublicKey(Buffer.alloc(32, 2));
const CASE = "12121212-2323-4343-8585-565656565656";
const NOW = "2026-10-20T12:00:00.000Z";
const PYUSD_RESTRICTIONS = [
  { metricId: "market.primary_pool.market_cap_usd", claimId: "market.market_cap_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
  { metricId: "market.primary_pool.fdv_usd", claimId: "market.fdv_usd", action: "provider_reported_only", explanationCode: "valuation_scope_and_denominator_unestablished" },
];
let fixtureProviderCalls = 0;

function key(byte) { return encodeSolanaPublicKey(Buffer.alloc(32, byte)); }
function tokenAccountData(mint, owner, amount) {
  const data = Buffer.alloc(165);
  Buffer.from(decodeSolanaPublicKey(mint)).copy(data, 0);
  Buffer.from(decodeSolanaPublicKey(owner)).copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = 1;
  return data.toString("base64");
}

async function makeReport(mintAddress = MINT, options = {}) {
  const quote = key(90);
  const pools = options.noPool ? [] : Array.from({ length: options.poolCount ?? 1 }, (_, index) => ({
    chainId: "solana", poolAddress: key(100 + index), dexId: "synthetic-dex",
    baseTokenAddress: options.unsupportedOrientation ? quote : mintAddress,
    quoteTokenAddress: options.unsupportedOrientation ? mintAddress : quote,
    priceUsd: "1.25", marketCapUsd: "1250000", fdvUsd: "1500000", liquidityUsd: "500000",
    volumeUsd: { h24: "75000" }, poolCreatedAt: null,
  }));
  const tokenProgram = options.token2022 ? "token-2022" : "spl-token";
  const mintData = Buffer.alloc(options.token2022 ? 170 : 82);
  mintData.writeBigUInt64LE(100_000_000n, 36);
  mintData[44] = 6; mintData[45] = 1;
  if (options.token2022) { mintData[165] = 1; mintData.writeUInt16LE(1, 166); mintData.writeUInt16LE(0, 168); }
  return generateSolanaTokenEvidenceReport({ chain: "solana", assetAddress: mintAddress,
    historicalTransactions: { status: "not_requested" } }, {
    getAccount: async (address) => {
      fixtureProviderCalls += 1;
      return { requestedAddress: address, owner: SOLANA_TOKEN_PROGRAM_IDS[tokenProgram], dataBase64: mintData.toString("base64") };
    },
    getMarkets: async () => { fixtureProviderCalls += 1; return pools; },
    getTokenAccountPages: async () => {
      fixtureProviderCalls += 1;
      if (options.partialHolders) return { status: "available", completeness: "partial", stopReason: "request_timeout",
        configuredMaxPages: 20, requestedPageSize: 5000, pages: [{ accounts: [], paginationKey: "2", contextSlot: 101 }] };
      const rows = options.holderRows ?? 1;
      const accounts = Array.from({ length: rows }, (_, index) => {
        const owner = key((index % 120) + 1);
        return { address: key((index % 120) + 121), programOwner: SOLANA_TOKEN_PROGRAM_IDS[tokenProgram],
          dataBase64: tokenAccountData(mintAddress, owner, index === 0 ? 50_000_000 : 1_000_000), reportedSpace: 165 };
      });
      return { status: "available", completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20,
        requestedPageSize: 5000, pages: [{ accounts, paginationKey: null, contextSlot: 101 }] };
    },
    now: () => new Date(NOW),
  });
}

function makeCase(report, caseId) {
  const value = { schemaVersion: "solana-reference-case-v1", caseId,
    identity: { chain: "solana", mintAddress: report.assetAddress },
    capture: { startedAt: NOW, completedAt: NOW,
      request: { chain: "solana", assetAddress: report.assetAddress, historicalTransactions: { status: "not_requested" } },
      executionBoundary: "protected_public_execution", captureOrigin: "protected_application_composition", requestBudgetEnvelope: 22,
      operationalTelemetry: aggregateSolanaReportOperationalTelemetry({ requestObservations: [], stageObservations: [], reportElapsedMs: null }) },
    evidenceReport: report, limitations: ["history_not_requested", "report_not_atomic"] };
  const digestHex = createHash("sha256").update(canonicalizeSolanaReferenceCaseValue(value), "utf8").digest("hex");
  const withHash = { ...value, contentHash: { algorithm: "sha256", canonicalization: "tqe-canonical-json-v1", digestHex } };
  return { value: withHash, json: canonicalizeSolanaReferenceCaseValue(withHash) };
}
function sha(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }
function makeNote(caseValue) {
  return JSON.stringify({ schemaVersion: "solana-reference-case-analyst-note-v1", caseId: caseValue.caseId,
    caseHash: caseValue.contentHash.digestHex, reviewerPseudonym: "Synthetic Reviewer", reviewedAt: NOW,
    evidenceReferences: [], observations: [], uncertainties: [], alternativeExplanations: [], disagreements: [], openQuestions: [] });
}
function makeRecord(caseValue, note, restrictions = []) {
  return { recordId: `record-${caseValue.caseId}`, recordVersion: 1, caseId: caseValue.caseId, chain: "solana", mintAddress: caseValue.identity.mintAddress,
    caseContentSha256: caseValue.contentHash.digestHex, analystNoteSha256: sha(note),
    disposition: restrictions.length ? "case_bound_restrictions_applied" : "case_bound_no_restrictions_confirmed", restrictions,
    reviewerPseudonym: "Synthetic Reviewer", reviewedAt: NOW };
}
function configFor(record, caseValue, note) {
  return { registry: { schemaVersion: "public-report-review-registry-v1", records: [record] },
    readCaseArtifactJson: async () => caseValue.json, readAnalystNoteJson: async () => note };
}
async function withConfig(config, callback) {
  const original = configModule.getSolanaPublicReportCompositionConfiguration;
  configModule.getSolanaPublicReportCompositionConfiguration = () => config;
  try { return await callback(); } finally { configModule.getSolanaPublicReportCompositionConfiguration = original; }
}
async function resolvedContext(mint = MINT, reportOptions = {}, restrictions = null) {
  const report = await makeReport(mint, reportOptions);
  const saved = makeCase(report, CASE);
  const note = makeNote(saved.value);
  const restrictionRows = restrictions ?? (mint === PYUSD ? PYUSD_RESTRICTIONS : []);
  const record = makeRecord(saved.value, note, restrictionRows);
  const config = configFor(record, saved, note);
  return withConfig(config, async () => {
    const result = await service.resolveSolanaSavedCaseForPublicReport({ caseId: CASE });
    assert.equal(result.valid, true, result.valid ? "" : result.error.message);
    return { handle: result.context, report, context: service.readValidatedSolanaPublicReportContext(result.context) };
  });
}
function field(report, id, section) {
  const rows = section ? report.sections.find((item) => item.id === section).fields : report.summary;
  return rows.find((item) => item.id === id);
}

test("composes deterministic plain-language report from opaque validated context and prints a complete example", async () => {
  const before = fixtureProviderCalls;
  const { handle, context } = await resolvedContext();
  const callsAfterResolution = fixtureProviderCalls;
  const snapshot = JSON.stringify(context);
  const first = composeSolanaPublicReport(handle);
  const second = composeSolanaPublicReport(handle);
  assert.equal(first.valid, true, JSON.stringify(first));
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(context), snapshot, "internal context is unchanged");
  assert.equal(callsAfterResolution - before, 3, "only injected fixture acquisition ran");
  assert.equal(fixtureProviderCalls, callsAfterResolution, "composition made no provider calls");
  const json = JSON.stringify(first.report);
  console.log(`SYNTHETIC_PUBLIC_REPORT_EXAMPLE=${json}`);
  assert.equal(first.report.schemaVersion, "token-public-report-v1");
  for (const [id, value] of [["market.market_cap", "1250000"], ["market.fdv", "1500000"]]) {
    assert.equal(first.report.summary.some((item) => item.id === id), false, `${id} is excluded from the default summary`);
    const detail = first.report.technicalDetails.find((item) => item.id === id);
    assert.equal(detail.visibility, "technical_details");
    assert.equal(detail.value, value);
  }
  const summaryJson = JSON.stringify(first.report.summary);
  assert.equal(summaryJson.includes("1250000"), false);
  assert.equal(summaryJson.includes("1500000"), false);
  assert.equal(first.report.token.chain, "solana");
  assert.equal(field(first.report, "identity.chain").evidenceState, "available");
  assert.equal(field(first.report, "identity.asset").value, MINT);
  assert.equal(first.report.summary.some((item) => typeof item.label === "string" && typeof item.explanation === "string"), true);
  assert.equal(field(first.report, "market.liquidity").value, "500000");
  assert.equal(field(first.report, "historical.sampled_activity", "historical").evidenceState, "not_requested");
  assert.equal(first.report.sections.find((item) => item.id === "holders").completeness, "complete");
});

test("partial holder enumeration remains explicit and does not expose concentration values", async () => {
  const { handle } = await resolvedContext(MINT, { partialHolders: true });
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  const holders = result.report.sections.find((item) => item.id === "holders");
  assert.equal(holders.completeness, "partial");
  assert.ok(holders.limitationCodes.includes("partial_enumeration"));
  for (const id of ["holders.concentration_top1", "holders.concentration_top5", "holders.concentration_top10", "holders.concentration_top20"]) {
    const item = field(result.report, id, "holders");
    assert.equal(item.visibility, "withheld");
    assert.equal(Object.hasOwn(item, "value"), false);
  }
});

test("complete positive holder population publishes eligible concentration without raw numerator or denominator", async () => {
  const { handle } = await resolvedContext(MINT, { holderRows: 2 });
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  const top1 = field(result.report, "holders.concentration_top1", "holders");
  assert.equal(top1.visibility, "summary");
  assert.match(top1.value, /^\d+\.\d{6}$/);
  const serialized = JSON.stringify(result.report);
  assert.equal(serialized.includes("numeratorRaw"), false);
  assert.equal(serialized.includes("denominatorRaw"), false);
});

test("empty observed population with positive supply uses the approved unavailable explanation", async () => {
  const { handle } = await resolvedContext(MINT, { holderRows: 0 });
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  const top1 = field(result.report, "holders.concentration_top1", "holders");
  assert.equal(top1.visibility, "withheld");
  assert.equal(top1.explanation, "Largest-holder concentration is unavailable. The reported token supply is positive, but no positive token balances were found in the retrieved records.");
  assert.equal(Object.hasOwn(top1, "value"), false);
});

test("PYUSD provider_reported_only valuations appear only in technical details and retain unchanged D10 decisions", async () => {
  const { handle, context } = await resolvedContext(PYUSD);
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  for (const [id, claimId] of [["market.market_cap", "market.market_cap_usd"], ["market.fdv", "market.fdv_usd"]]) {
    assert.equal(field(result.report, id), undefined, "valuation is excluded from default summary");
    const detail = result.report.technicalDetails.find((item) => item.id === id);
    assert.equal(detail.visibility, "technical_details");
    assert.equal(detail.explanationCode, "valuation_scope_and_denominator_unestablished");
    assert.ok(detail.limitationCodes.includes("provider_valuation_scope_unverified"));
    assert.equal(detail.claimOutcome, "permitted");
    assert.equal(context.claims.claims.find((claim) => claim.id === claimId).outcome, "permitted");
  }
  const summaryJson = JSON.stringify(result.report.summary);
  assert.equal(summaryJson.includes("1250000"), false);
  assert.equal(summaryJson.includes("1500000"), false);
  assert.equal(result.report.analystReview.restrictions.length, 2);
});

test("D10-withheld valuations remain absent from summary, sections and technical details", async () => {
  const { handle, context } = await resolvedContext(MINT, { noPool: true });
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  for (const [id, claimId] of [["market.market_cap", "market.market_cap_usd"], ["market.fdv", "market.fdv_usd"]]) {
    const claim = context.claims.claims.find((item) => item.id === claimId);
    assert.notEqual(claim.outcome, "permitted");
    assert.equal(result.report.summary.some((item) => item.id === id), false);
    assert.equal(result.report.technicalDetails.some((item) => item.id === id && Object.hasOwn(item, "value")), false);
    assert.equal(result.report.sections.flatMap((section) => section.fields)
      .some((item) => item.id === id && Object.hasOwn(item, "value")), false);
  }
  const serialized = JSON.stringify(result.report);
  assert.equal(serialized.includes("1250000"), false);
  assert.equal(serialized.includes("1500000"), false);
});

test("suppress_value hides the restricted value from sections, summary and technical details", async () => {
  const restrictions = [{ metricId: "market.primary_pool.market_cap_usd", claimId: "market.market_cap_usd", action: "suppress_value", explanationCode: "valuation_scope_and_denominator_unestablished" }];
  const { handle } = await resolvedContext(MINT, {}, restrictions);
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  const serialized = JSON.stringify(result.report);
  assert.equal(serialized.includes('"value":"1250000"'), false);
  assert.equal(serialized.includes("1250000"), false, "suppressed value is absent from every output field and explanation");
  const hidden = field(result.report, "market.market_cap", "market");
  assert.equal(hidden.visibility, "withheld");
  assert.equal(Object.hasOwn(hidden, "value"), false);
  assert.equal(result.report.technicalDetails.some((item) => item.id === "market.market_cap" && Object.hasOwn(item, "value")), false);
});

test("malformed internal restriction metadata fails closed without a partial report", async () => {
  const { context } = await resolvedContext();
  const original = service.readValidatedSolanaPublicReportContext;
  service.readValidatedSolanaPublicReportContext = () => ({ ...context, review: { ...context.review,
    disposition: "case_bound_restrictions_applied", restrictions: [{ metricId: "unknown.metric", claimId: "market.market_cap_usd", action: "suppress_value", explanationCode: "valuation_scope_and_denominator_unestablished" }] } });
  try {
    const result = composeSolanaPublicReport(Object.freeze({}));
    assert.deepEqual(result, { valid: false, error: { code: "restriction_invalid", message: "The validated analyst restrictions are inconsistent with the evidence." } });
    assert.equal(Object.hasOwn(result, "report"), false);
  } finally {
    service.readValidatedSolanaPublicReportContext = original;
  }
});

test("unsupported pool orientation is withheld with a safe explanation and no source text", async () => {
  const { handle } = await resolvedContext(MINT, { unsupportedOrientation: true });
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  const price = field(result.report, "market.price", "market");
  assert.equal(price.visibility, "withheld");
  assert.equal(price.explanation, "The selected pool orientation does not support a token-oriented value.");
  assert.equal(JSON.stringify(result.report).includes("poolAddress"), false);
});

test("Token-2022 controls are presence-only and never expose extension IDs or payloads", async () => {
  const { handle } = await resolvedContext(MINT, { token2022: true, holderRows: 1 });
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  const controls = result.report.sections.find((item) => item.id === "token_controls");
  assert.equal(controls.fields.find((item) => item.id === "token_controls.token_program").value, "token-2022");
  const inventory = controls.fields.find((item) => item.id === "token_controls.extension_inventory_summary");
  assert.equal(inventory.value, "1 recognized mint extension recorded; presence only.");
  assert.equal(JSON.stringify(result.report).includes("extensionTypeId"), false);
  assert.equal(result.report.sections.find((item) => item.id === "holders").completeness, "partial",
    "balance-affecting extension prevents complete amount coverage from being claimed");
  assert.equal(field(result.report, "holders.concentration_top1", "holders").visibility, "withheld");
});

test("fabricated and copied context handles fail closed", async () => {
  const { handle } = await resolvedContext();
  assert.deepEqual(composeSolanaPublicReport({ ...handle }), { valid: false, error: { code: "invalid_context", message: "A validated evidence context is required." } });
  assert.deepEqual(composeSolanaPublicReport(Object.create(Object.getPrototypeOf(handle))), { valid: false, error: { code: "invalid_context", message: "A validated evidence context is required." } });
});

test("leakage sentinels, holder/account and operational fields never enter the public serialization", async () => {
  const { handle } = await resolvedContext();
  const result = composeSolanaPublicReport(handle);
  assert.equal(result.valid, true);
  const serialized = JSON.stringify(result.report);
  for (const forbidden of ["numeratorRaw", "denominatorRaw", "ownerAddress", "rawOwnerAuthorities", "operationalTelemetry", "requestObservations", "Authorization", "Bearer ", "https://", "dataBase64", "provider_error", "Error: "]) {
    assert.equal(serialized.includes(forbidden), false, `does not leak ${forbidden}`);
  }
});

test("composition benchmark reports median and p95 independently of validation", async () => {
  const { handle } = await resolvedContext();
  for (let i = 0; i < 25; i += 1) assert.equal(composeSolanaPublicReport(handle).valid, true);
  const durations = [];
  for (let i = 0; i < 250; i += 1) {
    const start = performance.now();
    composeSolanaPublicReport(handle);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const report = composeSolanaPublicReport(handle);
  assert.equal(report.valid, true);
  const bytes = Buffer.byteLength(JSON.stringify(report.report), "utf8");
  const contextBytes = Buffer.byteLength(JSON.stringify(service.readValidatedSolanaPublicReportContext(handle)), "utf8");
  console.log(`COMPOSER_BENCHMARK iterations=${durations.length} contextBytes=${contextBytes} outputBytes=${bytes} medianMs=${median.toFixed(4)} p95Ms=${p95.toFixed(4)}`);
});
