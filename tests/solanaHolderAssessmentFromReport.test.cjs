const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { deriveSolanaHolderAssessmentFromReport: derive } = require("../dist/application/solanaHolderAssessmentFromReport.js");
const { composeSolanaHolderAssessment } = require("../dist/application/solanaHolderAssessment.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");
const { DexScreenerProviderError } = require("../dist/providers/market/dexScreener.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const key = n => encodeSolanaPublicKey(Buffer.alloc(32, n));
const MINT = key(1);

async function fixture({ partial = false, balance = 80n, supply = 100n, marketFailure } = {}) {
  const calls = [];
  const mint = Buffer.alloc(82);
  mint.writeBigUInt64LE(supply, 36); mint[44] = 6; mint[45] = 1;
  const account = Buffer.alloc(165);
  account.set(Buffer.alloc(32, 1), 0); account.set(Buffer.alloc(32, 2), 32);
  account.writeBigUInt64LE(balance, 64); account[108] = 1;
  const report = await generateSolanaTokenEvidenceReport({ chain: "solana", assetAddress: MINT, historicalTransactions: { status: "not_requested" } }, {
    getAccount: async () => { calls.push("mint"); return { requestedAddress: MINT, owner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], dataBase64: mint.toString("base64") }; },
    getMarkets: async () => { calls.push("market"); if (marketFailure) throw new DexScreenerProviderError(marketFailure); return []; },
    getTokenAccountPages: async () => { calls.push("holders"); return {
      status: "available", completeness: partial ? "partial" : "complete", stopReason: partial ? "request_timeout" : "provider_terminated",
      configuredMaxPages: 20, requestedPageSize: 5000,
      pages: [{ accounts: [{ address: key(3), programOwner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], dataBase64: account.toString("base64"), reportedSpace: 165 }], paginationKey: partial ? "next" : null, contextSlot: 100 }],
    }; },
    now: () => new Date("2026-10-23T12:00:00.000Z"),
  });
  return { report, calls };
}

test("generated report bridges exactly to composition, with no acquisition or mutation", async () => {
  const { report, calls } = await fixture({ balance: 9007199254740993n, supply: 10000000000000000n });
  const before = structuredClone(report);
  function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(report);
  const result = derive(report);
  assert.deepEqual(result, { status: "present", assessment: composeSolanaHolderAssessment({ mintResolution: report.mint.evidence.resolution, holderSnapshot: report.holders.evidence.snapshotRecord, marketInput: { status: "available", snapshot: report.market.evidence } }) });
  assert.deepEqual(derive(report), result);
  assert.equal(result.assessment.population.notExcluded.observedBalanceRaw, "9007199254740993");
  assert.deepEqual(report, before);
  assert.deepEqual(calls, ["mint", "market", "holders"]);
  result.assessment.population.subjects[0].balanceRaw = "1";
  assert.deepEqual(report, before);
});

test("partial and supply-inconsistent reports preserve existing concentration limitations", async () => {
  for (const [options, reason] of [[{ partial: true }, "enumeration_incomplete"], [{ supply: 60n }, "supply_inconsistency"]]) {
    const { report } = await fixture(options);
    const { assessment } = derive(report);
    assert.equal(assessment.concentration.notExcludedTopNCurrentMintSupplyShare.reason, reason);
    assert.equal(assessment.concentration.notExcludedObservedPopulationTopNShare.completeness, "partial");
    assert.equal(assessment.population.source.holderSnapshotId, report.holders.evidence.snapshotRecord.snapshotId);
  }
});

test("known market failures retain unavailable evidence without exclusions", async () => {
  for (const category of ["configuration_error", "request_timeout", "transport_error", "http_error", "malformed_response"]) {
    const { report } = await fixture({ marketFailure: category });
    const { assessment } = derive(report);
    assert.equal(assessment.addressRoleEvidence.marketSource.reason, category === "malformed_response" ? "malformed_response" : "provider_error");
    assert.equal(assessment.exclusionAssessment.summary.excludeCount, 0);
    assert.equal(assessment.exclusionAssessment.summary.unresolvedCount, 1);
  }
});

test("missing prerequisites and unsupported market evidence do not invent observations", async () => {
  const { report } = await fixture();
  for (const mint of [{ status: "unavailable", reason: "mint_provider_unavailable" }, { status: "not_attempted", reason: "mint_unresolved" }, { status: "present", evidence: { resolution: { exists: false } } }, { status: "present", evidence: { resolution: { exists: true, isMint: false } } }]) {
    assert.deepEqual(derive({ ...report, mint }), { status: "not_attempted", reason: "mint_unresolved" });
  }
  for (const status of ["unavailable", "not_attempted"]) {
    assert.deepEqual(derive({ ...report, holders: { status, reason: "holder_evidence_unavailable" } }), { status: "not_attempted", reason: "holder_evidence_unavailable" });
  }
  for (const market of [{ status: "not_attempted", reason: "mint_unresolved" }, { status: "unavailable", reason: "unknown" }, { status: "unavailable", reason: "market_provider_unavailable", errorCategory: "unknown" }, { status: "unavailable", reason: "market_provider_unavailable" }]) {
    assert.deepEqual(derive({ ...report, market }), { status: "not_attempted", reason: "market_evidence_unsupported" });
  }
});

test("report identity and existing composition validation reject inconsistent inputs", async () => {
  const { report } = await fixture();
  for (const mutate of [
    r => { r.chain = "ethereum"; }, r => { r.schemaVersion = "unknown"; }, r => { r.assetAddress = key(9); },
    r => { r.mint.evidence.resolution.rawSupply = "101"; },
    r => { r.market.evidence.mintAddress = key(9); },
    r => { r.holders.evidence.snapshotRecord.snapshotId = "sha256:" + "0".repeat(64); },
  ]) {
    const changed = structuredClone(report); mutate(changed); assert.throws(() => derive(changed));
  }
});

test("bridge imports and runs with provider, database, and network access blocked", async () => {
  const { report } = await fixture();
  const script = `
    const Module = require('node:module'); const original = Module._load;
    Module._load = function(id, ...args) {
      if (/providers[\\/]|platform[\\/]database|^pg$/.test(id)) throw Error('forbidden import');
      return original.call(this, id, ...args);
    };
    global.fetch = () => { throw Error('network forbidden'); };
    require('node:net').Socket.prototype.connect = () => { throw Error('network forbidden'); };
    require('node:tls').connect = () => { throw Error('network forbidden'); };
    const { deriveSolanaHolderAssessmentFromReport } = require('./dist/application/solanaHolderAssessmentFromReport.js');
    if (deriveSolanaHolderAssessmentFromReport(${JSON.stringify(report)}).status !== 'present') process.exit(1);
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});
