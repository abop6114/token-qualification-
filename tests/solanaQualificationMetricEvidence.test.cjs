const assert = require("node:assert/strict");
const { test } = require("node:test");
const { deriveSolanaQualificationMetricEvidence, SolanaQualificationMetricEvidenceInputError } = require("../dist/analysis/solanaQualificationMetricEvidence.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { encodeSolanaPublicKey, decodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const { HeliusTransferProviderError } = require("../dist/providers/solana/heliusTransfersByAddress.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(90);
const OWNER = key(91);
const TOKEN_ACCOUNT = key(92);
const POOL = key(93);
const QUOTE = key(94);
const FETCHED = "2026-10-13T15:00:00.000Z";
const WINDOW = { fromUnixSecondsInclusive: 1_790_000_000, toUnixSecondsExclusive: 1_800_000_000 };
async function withHeliusKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "offline-phase4b-test-key";
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  }
}

function mintAccount({ supply = 18446744073709551615n, mintAuthority = null, freezeAuthority = null, tokenProgram = "spl-token" } = {}) {
  const data = Buffer.alloc(82);
  if (mintAuthority) {
    data.writeUInt32LE(1, 0);
    data.set(Buffer.from(decodeSolanaPublicKey(mintAuthority)), 4);
  }
  data.writeBigUInt64LE(supply, 36);
  data[44] = 9;
  data[45] = 1;
  if (freezeAuthority) {
    data.writeUInt32LE(1, 46);
    data.set(Buffer.from(decodeSolanaPublicKey(freezeAuthority)), 50);
  }
  return { requestedAddress: MINT, owner: SOLANA_TOKEN_PROGRAM_IDS[tokenProgram], dataBase64: data.toString("base64") };
}

function tokenAccount(balance = 100n) {
  const data = Buffer.alloc(165);
  data.set(Buffer.from(decodeSolanaPublicKey(MINT)), 0);
  data.set(Buffer.from(decodeSolanaPublicKey(OWNER)), 32);
  data.writeBigUInt64LE(balance, 64);
  data[108] = 1;
  return { address: TOKEN_ACCOUNT, programOwner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], dataBase64: data.toString("base64"), reportedSpace: 165 };
}

function pool(overrides = {}) {
  return {
    chainId: "solana", poolAddress: POOL, dexId: "offline-dex", baseTokenAddress: MINT,
    quoteTokenAddress: QUOTE, priceUsd: "0.25", marketCapUsd: "250000", fdvUsd: "300000",
    liquidityUsd: "12500", volumeUsd: { h24: "7000" }, poolCreatedAt: 1_790_000_000, ...overrides,
  };
}

async function makeReport({ history = "not_requested", ...overrides } = {}) {
  let providerCalls = 0;
  const deps = {
    getAccount: async () => { providerCalls += 1; return mintAccount(overrides.mint); },
    getMarkets: async () => { providerCalls += 1; return overrides.markets ?? []; },
    getTokenAccountPages: async () => {
      providerCalls += 1;
      const accounts = overrides.accounts ?? [tokenAccount()];
      const partial = overrides.holderCompleteness === "partial";
      return { status: "available", completeness: partial ? "partial" : "complete", stopReason: partial ? "request_timeout" : "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000, pages: [{ accounts, paginationKey: partial ? "2" : null, contextSlot: 100 }] };
    },
    now: () => new Date(FETCHED),
  };
  if (history !== "not_requested") {
    let page = 0;
    deps.fetchHistoricalPage = async () => {
      providerCalls += 1;
      if (history === "error") throw new HeliusTransferProviderError("http", "offline fixture failure");
      page += 1;
      return { observations: [], paginationToken: history === "truncated" ? (page === 1 ? "2" : "3") : null };
    };
  }
  const request = { chain: "solana", assetAddress: MINT, historicalTransactions: history === "not_requested" ? { status: "not_requested" } : { status: "requested", requestedWindow: WINDOW } };
  const report = history === "not_requested"
    ? await generateSolanaTokenEvidenceReport(request, deps)
    : await withHeliusKey(() => generateSolanaTokenEvidenceReport(request, deps));
  return { report, providerCalls };
}

function get(output, id) {
  const item = output.entries.find((candidate) => candidate.id === id);
  assert.ok(item, `metric ${id} exists`);
  return item;
}

test("emits stable metric IDs and ordering, preserves input, and is deterministic", async () => {
  const { report } = await makeReport({ markets: [pool()] });
  const before = structuredClone(report);
  const first = deriveSolanaQualificationMetricEvidence(report);
  const second = deriveSolanaQualificationMetricEvidence(report);
  assert.deepEqual(first, second);
  assert.deepEqual(report, before);
  assert.equal(first.entries[0].id, "market.primary_pool.liquidity_usd");
  assert.equal(first.entries[4].id, "market.primary_pool.fdv_usd");
  assert.equal(first.entries[5].id, "holders.token_account_count");
  assert.equal(first.entries.at(-1).id, "historical.request_state");
  assert.equal(first.schemaVersion, "solana-qualification-metric-evidence-v1");
  assert.equal("score" in first, false);
  assert.equal("verdict" in first, false);
});

test("market metrics remain selected-pool scoped and preserve pool provenance", async () => {
  const { report } = await makeReport({ markets: [pool()] });
  const output = deriveSolanaQualificationMetricEvidence(report);
  const liquidity = get(output, "market.primary_pool.liquidity_usd");
  const price = get(output, "market.primary_pool.price_usd");
  assert.equal(liquidity.value, "12500");
  assert.equal(liquidity.scope.address, POOL);
  assert.equal(liquidity.source.provider, "dexscreener");
  assert.equal(liquidity.source.observedAt, report.market.evidence.pools[0].provenance.fetchedAt);
  assert.equal(price.value, "0.25");
  assert.equal(price.evidenceKind, "provider_observation");
  assert.equal(output.entries.some((item) => item.id.includes("pool_created")), false);
});

test("quote-side token-oriented market metrics stay unavailable while pool metrics remain available", async () => {
  const { report } = await makeReport({ markets: [pool({ baseTokenAddress: QUOTE, quoteTokenAddress: MINT })] });
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "market.primary_pool.liquidity_usd").status, "available");
  for (const id of ["market.primary_pool.price_usd", "market.primary_pool.market_cap_usd", "market.primary_pool.fdv_usd"]) {
    assert.equal(get(output, id).status, "unavailable");
    assert.equal(get(output, id).reason, "orientation_unsupported");
  }
});

test("successful empty market result is unavailable rather than zero", async () => {
  const { report } = await makeReport();
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(report.market.status, "present");
  assert.equal(get(output, "market.primary_pool.liquidity_usd").status, "unavailable");
  assert.equal(get(output, "market.primary_pool.liquidity_usd").reason, "no_market");
  assert.equal(get(output, "market.primary_pool.liquidity_usd").value, null);
});

test("provider-unavailable market section remains distinct from an empty successful result", async () => {
  const { report } = await makeReport();
  report.market = { status: "unavailable", reason: "market_provider_unavailable" };
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "market.primary_pool.liquidity_usd").reason, "market_provider_unavailable");
});

test("holder account and authority populations remain distinct and raw supply precision is preserved", async () => {
  const { report } = await makeReport();
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "holders.token_account_count").value, 1);
  assert.equal(get(output, "holders.positive_owner_authority_count").value, 1);
  assert.equal(get(output, "holders.current_mint_supply_raw").value, "18446744073709551615");
  assert.equal(get(output, "holders.observed_positive_balance_raw").value, "100");
  assert.match(get(output, "holders.positive_owner_authority_count").limitation, /not independent wallets/);
});

test("partial holder enumeration is preserved as partial without converting observed values to zero", async () => {
  const { report } = await makeReport({ holderCompleteness: "partial" });
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "holders.token_account_count").value, 1);
  assert.equal(get(output, "holders.token_account_count").completeness, "partial");
  assert.equal(get(output, "holders.positive_owner_authority_count").completeness, "partial");
  assert.equal(get(output, "holders.concentration_top1").status, "unavailable");
});

test("existing Top-N eligibility is reused, including partial amount evidence and supply inconsistency", async () => {
  const { report } = await makeReport();
  const structure = report.holders.evidence.holderStructure;
  structure.amountCoverage = { state: "partial", unsupportedExtensionTypes: [25], reason: "unsupported_balance_affecting_extension" };
  report.holders.evidence.ownerAuthorityBalanceDistribution.coverage.state = "partial";
  report.holders.evidence.ownerAuthorityBalanceDistribution.coverage.amountCoverageState = "partial";
  for (const topN of [1, 5, 10, 20]) {
    structure.concentration[`top${topN}`] = { status: "unavailable", topN, numeratorRaw: null, denominatorRaw: structure.currentMintSupplyRaw, denominatorBasis: "current_mint_supply", percentage: null, reason: "unsupported_balance_affecting_extension" };
  }
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "holders.concentration_top1").reason, "unsupported_balance_affecting_extension");
  assert.equal(get(output, "holders.observed_positive_balance_raw").completeness, "partial");
});

test("numerically available concentration retains its exact value but becomes partial under partial amount coverage", async () => {
  const { report } = await makeReport();
  const structure = report.holders.evidence.holderStructure;
  const exactTop1 = structuredClone(structure.concentration.top1);
  structure.amountCoverage = { state: "partial", unsupportedExtensionTypes: [25], reason: "unsupported_balance_affecting_extension" };
  report.holders.evidence.ownerAuthorityBalanceDistribution.coverage.state = "partial";
  report.holders.evidence.ownerAuthorityBalanceDistribution.coverage.amountCoverageState = "partial";
  structure.concentration.top1 = exactTop1;
  const metric = get(deriveSolanaQualificationMetricEvidence(report), "holders.concentration_top1");
  assert.equal(metric.status, "available");
  assert.equal(metric.value, exactTop1.percentage);
  assert.equal(metric.completeness, "partial");
});

test("supply-inconsistent concentration remains unavailable without inventing a percentage", async () => {
  const { report } = await makeReport();
  const structure = report.holders.evidence.holderStructure;
  structure.supplyDifferenceRaw = "-1";
  structure.amountCoverage = { state: "partial", unsupportedExtensionTypes: [], reason: "supply_inconsistency" };
  report.holders.evidence.ownerAuthorityBalanceDistribution.coverage.state = "partial";
  report.holders.evidence.ownerAuthorityBalanceDistribution.coverage.amountCoverageState = "partial";
  report.holders.evidence.ownerAuthorityBalanceDistribution.coverage.amountCoverageReason = "supply_inconsistency";
  for (const topN of [1, 5, 10, 20]) structure.concentration[`top${topN}`] = { status: "unavailable", topN, numeratorRaw: null, denominatorRaw: structure.currentMintSupplyRaw, denominatorBasis: "current_mint_supply", percentage: null, reason: "supply_inconsistency" };
  const metric = get(deriveSolanaQualificationMetricEvidence(report), "holders.concentration_top1");
  assert.equal(metric.status, "unavailable");
  assert.equal(metric.value, null);
  assert.equal(metric.reason, "supply_inconsistency");
});

test("available existing concentration retains exact percentage and gate-derived completeness", async () => {
  const { report } = await makeReport();
  const output = deriveSolanaQualificationMetricEvidence(report);
  const top = report.holders.evidence.holderStructure.concentration.top1;
  const projected = get(output, "holders.concentration_top1");
  assert.equal(projected.value, top.percentage);
  assert.equal(projected.numeratorRaw, top.numeratorRaw);
  assert.equal(projected.denominatorRaw, top.denominatorRaw);
  assert.equal(projected.completeness, "complete");
});

test("empty holder population exposes exact zero counts and leaves undefined distribution values unavailable", async () => {
  const { report } = await makeReport({ accounts: [tokenAccount(0n)] });
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "holders.token_account_count").value, 1);
  assert.equal(get(output, "holders.positive_owner_authority_count").value, 0);
  assert.equal(get(output, "holders.distribution.minimum_balance_raw").status, "unavailable");
  assert.equal(get(output, "holders.distribution.minimum_balance_raw").reason, "empty_observed_population");
  assert.deepEqual(get(output, "holders.distribution.repeated_balance_groups").value, []);
});

test("balance distribution is projected without recalculation or address exposure", async () => {
  const { report } = await makeReport();
  const output = deriveSolanaQualificationMetricEvidence(report);
  const minimum = get(output, "holders.distribution.minimum_balance_raw");
  assert.equal(minimum.value, "100");
  assert.equal(get(output, "holders.distribution.quantile_p99_raw").value, "100");
  assert.equal(JSON.stringify(output).includes(OWNER), false);
  assert.equal(JSON.stringify(output).includes(TOKEN_ACCOUNT), false);
});

test("base mint and freeze authority state preserve set and unset facts without implying a security verdict", async () => {
  const { report } = await makeReport({ mint: { mintAuthority: OWNER, freezeAuthority: null } });
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "token_controls.mint_authority_state").value, "set");
  assert.equal(get(output, "token_controls.mint_authority_address").value, OWNER);
  assert.equal(get(output, "token_controls.freeze_authority_state").value, "unset");
  assert.equal(get(output, "token_controls.freeze_authority_address").status, "unavailable");
  assert.equal(get(output, "token_controls.freeze_authority_address").reason, "authority_unset");
  assert.equal(output.entries.some((item) => /safe|unsafe|risk|score/i.test(item.id)), false);
});

test("classic SPL extension inventory is explicitly not applicable", async () => {
  const { report } = await makeReport();
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "token_controls.mint_extension_inventory").status, "not_applicable");
  assert.equal(get(output, "token_controls.mint_extension_inventory").reason, "classic_spl_token_program");
  assert.match(get(output, "token_controls.mint_authority_state").limitation, /complete Token-2022/);
});

test("Token-2022 recognized mint extension inventory is presented as inventory only", async () => {
  const { report } = await makeReport({ mint: { tokenProgram: "token-2022" }, accounts: [] });
  const metric = get(deriveSolanaQualificationMetricEvidence(report), "token_controls.mint_extension_inventory");
  assert.equal(metric.status, "available");
  assert.deepEqual(metric.value, []);
  assert.match(metric.limitation, /no extension authorities/);
});

test("historical not-requested state is not represented as empty history", async () => {
  const { report, providerCalls } = await makeReport();
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "historical.request_state").status, "not_requested");
  assert.equal(output.entries.some((item) => item.id === "historical.authority.accepted_observation_count"), false);
  assert.equal(providerCalls, 3);
});

test("historical requested and naturally completed sample keeps requested window separate from returned evidence", async () => {
  const { report } = await makeReport({ history: "present" });
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(output, "historical.request_state").value, "requested");
  assert.deepEqual(get(output, "historical.requested_window").value, WINDOW);
  const authorityMetric = get(output, "historical.authority.accepted_observation_count");
  assert.equal(authorityMetric.value, 0);
  assert.equal(authorityMetric.scope.address, OWNER);
  assert.equal(get(output, "historical.authority.observed_block_time_bounds").status, "unavailable");
  assert.equal(get(output, "historical.authority.observed_block_time_bounds").reason, "no_usable_block_times");
  assert.match(get(output, "historical.sample_coverage").limitation, /not the full holder population/);
});

test("historical amount evidence profile preserves exact raw strings and non-exact discriminator counts", async () => {
  const { report } = await makeReport({ history: "present" });
  const metric = report.historicalTransactions.evidence.descriptiveMetrics.authorities[0].amountEvidenceProfile;
  metric.value = {
    exactRawAmountObservationCount: 1,
    nonExactOrUnavailableAmountObservationCount: 2,
    reportedAmountTypeCounts: [
      { reportedAmountType: "integer_string", count: 1 },
      { reportedAmountType: "non_integer_string", count: 1 },
      { reportedAmountType: "safe_integer_number", count: 0 },
      { reportedAmountType: "non_integer_number", count: 0 },
      { reportedAmountType: "unsafe_integer_number", count: 0 },
      { reportedAmountType: "null", count: 0 },
      { reportedAmountType: "missing", count: 1 },
    ],
    exactRawAmountCoverage: "partial",
    minimumExactRawAmount: "18446744073709551615",
    maximumExactRawAmount: "18446744073709551615",
  };
  const projected = get(deriveSolanaQualificationMetricEvidence(report), "historical.authority.amount_evidence_profile");
  assert.equal(projected.status, "available");
  assert.equal(projected.value.minimumExactRawAmount, "18446744073709551615");
  assert.equal(projected.value.reportedAmountTypeCounts[4].reportedAmountType, "unsafe_integer_number");
});

test("historical truncated sample remains partial and does not infer time coverage", async () => {
  const { report } = await makeReport({ history: "truncated" });
  const authority = report.historicalTransactions.evidence.descriptiveMetrics.authorities[0];
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(authority.queryStatus, "success");
  assert.equal(authority.paginationStatus, "truncated");
  const projected = deriveSolanaQualificationMetricEvidence(report);
  assert.equal(get(projected, "historical.authority.accepted_observation_count").completeness, "partial");
  assert.match(get(projected, "historical.authority.accepted_observation_count").limitation, /no full-window/);
  assert.equal(get(projected, "historical.requested_window").completeness, "complete");
});

test("history unavailable and not attempted remain distinct", async () => {
  const { report } = await makeReport();
  report.historicalTransactions = { status: "unavailable", reason: "history_provider_unavailable" };
  assert.equal(get(deriveSolanaQualificationMetricEvidence(report), "historical.request_state").status, "unavailable");
  report.historicalTransactions = { status: "not_attempted", reason: "holder_evidence_unavailable" };
  assert.equal(get(deriveSolanaQualificationMetricEvidence(report), "historical.request_state").status, "not_attempted");
});

test("requested history provider failure preserves unavailable metric state", async () => {
  const { report } = await makeReport({ history: "error" });
  assert.equal(report.historicalTransactions.evidence.descriptiveMetrics.authorities[0].queryStatus, "provider_error");
  const metric = get(deriveSolanaQualificationMetricEvidence(report), "historical.authority.accepted_observation_count");
  assert.equal(metric.status, "unavailable");
  assert.equal(metric.reason, "provider_error");
  assert.equal(metric.value, null);
});

test("historical conflicting transaction integration is preserved explicitly", async () => {
  const { report } = await makeReport({ history: "present" });
  report.historicalTransactions.evidence.transactionIntegration.coverage.downstream.status = "conflicting";
  const metric = get(deriveSolanaQualificationMetricEvidence(report), "historical.transaction_integration_coverage");
  assert.equal(metric.status, "conflicting");
  assert.equal(metric.value, "conflicting");
});

test("rejects malformed source report and cross-section mint identity mismatch", async () => {
  const { report } = await makeReport();
  assert.throws(() => deriveSolanaQualificationMetricEvidence({ ...report, schemaVersion: "wrong" }), (error) => error instanceof SolanaQualificationMetricEvidenceInputError && error.reason === "malformed_report");
  report.market.evidence.mintAddress = key(88);
  assert.throws(() => deriveSolanaQualificationMetricEvidence(report), (error) => error instanceof SolanaQualificationMetricEvidenceInputError && error.reason === "identity_mismatch");
});

test("offline report generation invokes only injected dependencies and adapter makes no additional calls", async () => {
  const { report, providerCalls } = await makeReport({ markets: [pool()] });
  const callsBeforeProjection = providerCalls;
  const before = structuredClone(report);
  const output = deriveSolanaQualificationMetricEvidence(report);
  assert.deepEqual(report, before);
  assert.ok(output.entries.length > 20);
  assert.equal(callsBeforeProjection, 3);
});
