const assert = require("node:assert/strict");
const { test } = require("node:test");
const { evaluateSolanaClaimPermissions, SolanaClaimPermissionInputError } = require("../dist/analysis/solanaClaimPermission.js");
const { SolanaQualificationMetricEvidenceInputError } = require("../dist/analysis/solanaQualificationMetricEvidence.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");
const { presentSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidencePresentation.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { encodeSolanaPublicKey, decodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(90);
const OWNER = key(91);
const TOKEN_ACCOUNT = key(92);
const POOL = key(93);
const QUOTE = key(94);
const FETCHED = "2026-10-13T15:00:00.000Z";
const WINDOW = { fromUnixSecondsInclusive: 1_790_000_000, toUnixSecondsExclusive: 1_800_000_000 };

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

function tokenAccount(address = TOKEN_ACCOUNT, balance = 100n, options = {}) {
  const data = Buffer.alloc(options.extension ? 174 : 165);
  data.set(Buffer.from(decodeSolanaPublicKey(MINT)), 0);
  data.set(Buffer.from(decodeSolanaPublicKey(options.ownerAddress ?? OWNER)), 32);
  data.writeBigUInt64LE(balance, 64);
  data[108] = 1;
  if (options.extension) {
    data[165] = 2;
    data.writeUInt16LE(options.extension.type, 166);
    data.writeUInt16LE(4, 168);
    data.writeUInt32LE(1, 170);
  }
  const tokenProgram = options.tokenProgram ?? "spl-token";
  return { address, programOwner: SOLANA_TOKEN_PROGRAM_IDS[tokenProgram], dataBase64: data.toString("base64"), reportedSpace: data.length };
}

function pool(overrides = {}) {
  return {
    chainId: "solana", poolAddress: POOL, dexId: "offline-dex", baseTokenAddress: MINT,
    quoteTokenAddress: QUOTE, priceUsd: "0.25", marketCapUsd: "250000", fdvUsd: "300000", liquidityUsd: "12500",
    volumeUsd: { m5: "15.5", h1: "120", h6: "900", h24: "7000" }, poolCreatedAt: 1_790_000_000, ...overrides,
  };
}

async function withHeliusKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "offline-claim-test-key";
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  }
}

async function makeReport({ history = "not_requested", holderCompleteness = "complete", holderStopReason = "request_timeout", mint = {}, markets = [pool()], pages = null } = {}) {
  const deps = {
    getAccount: async () => mintAccount(mint),
    getMarkets: async () => markets,
    getTokenAccountPages: async () => ({
      status: "available",
      completeness: holderCompleteness,
      stopReason: holderCompleteness === "complete" ? "provider_terminated" : holderStopReason,
      configuredMaxPages: 20,
      requestedPageSize: 5000,
      pages: pages ?? [{ accounts: [tokenAccount()], paginationKey: holderCompleteness === "complete" ? null : "next", contextSlot: 100 }],
    }),
    now: () => new Date(FETCHED),
  };
  if (history === "present") {
    deps.fetchHistoricalPage = async () => ({ observations: [], paginationToken: null });
  }
  const request = {
    chain: "solana", assetAddress: MINT,
    historicalTransactions: history === "not_requested" ? { status: "not_requested" } : { status: "requested", requestedWindow: WINDOW },
  };
  const build = () => generateSolanaTokenEvidenceReport(request, deps);
  return history === "not_requested" ? build() : withHeliusKey(build);
}

function claim(result, id) {
  const found = result.claims.find((item) => item.id === id);
  assert.ok(found, `claim ${id} exists`);
  return found;
}

test("fixed catalog is deterministic, ordered, identity-bound, and does not mutate the report", async () => {
  const report = await makeReport();
  const before = structuredClone(report);
  const first = evaluateSolanaClaimPermissions(report);
  const second = evaluateSolanaClaimPermissions(report);
  assert.deepEqual(first, second);
  assert.deepEqual(report, before);
  assert.equal(first.schemaVersion, "tqe-claim-permission-proposal-v1");
  assert.equal(first.chain, "solana");
  assert.equal(first.mintAddress, MINT);
  assert.equal(first.sourceReportSchemaVersion, report.schemaVersion);
  assert.equal(first.sourceReportGeneratedAt, report.generatedAt);
  assert.deepEqual(first.claims.map((item) => item.id), [
    "market.price_usd", "market.liquidity_usd", "market.market_cap_usd", "market.fdv_usd",
    "market.volume_m5_usd", "market.volume_h1_usd", "market.volume_h6_usd", "market.volume_h24_usd",
    "holders.token_account_count", "holders.positive_token_account_count", "holders.positive_owner_authority_count",
    "holders.observed_positive_balance_raw", "holders.observed_frame_balance_distribution", "holders.full_population_count",
    "holders.concentration_top1", "holders.concentration_top5", "holders.concentration_top10", "holders.concentration_top20",
    "token_controls.mint_authority_state", "token_controls.freeze_authority_state", "token_controls.token_program",
    "token_controls.mint_extension_inventory", "historical.sampled_activity", "historical.transaction_integration_coverage", "historical.momentum",
  ]);
  assert.equal(Object.hasOwn(first, "score"), false);
  assert.equal(Object.hasOwn(first, "verdict"), false);
});

test("selected-pool claims permit only selected metrics and all explicitly mapped volume windows", async () => {
  const report = await makeReport();
  const result = evaluateSolanaClaimPermissions(report);
  for (const [id, expected, path] of [
    ["market.price_usd", "0.25", "priceUsd"], ["market.liquidity_usd", "12500", "liquidityUsd"],
    ["market.market_cap_usd", "250000", "marketCapUsd"], ["market.fdv_usd", "300000", "fdvUsd"],
    ["market.volume_m5_usd", "15.5", "volumeUsd.m5"], ["market.volume_h1_usd", "120", "volumeUsd.h1"],
    ["market.volume_h6_usd", "900", "volumeUsd.h6"], ["market.volume_h24_usd", "7000", "volumeUsd.h24"],
  ]) {
    const item = claim(result, id);
    assert.equal(item.outcome, "permitted");
    assert.equal(item.value, expected);
    assert.equal(item.scope, "selected_pool");
    assert.equal(item.scopeAddress, POOL);
    assert.equal(item.evidence[0].source.observedAt, report.market.evidence.pools[0].provenance.fetchedAt);
    assert.equal(item.evidence[0].source.fieldPath.endsWith(path), true);
    assert.equal(item.evidence[0].source.provider, "dexscreener");
  }
  assert.equal(claim(result, "market.price_usd").evidence[0].source.sourceUpdatedAt, null);
  assert.equal(result.claims.some((item) => item.value === "15.5" && item.evidence[0]?.source.fieldPath.includes("pools[1]")), false);
});

test("unavailable selected-pool metrics and absent pools are withheld without selecting another pool or using zero", async () => {
  const metricMissing = await makeReport({ markets: [pool({ liquidityUsd: null })] });
  const metricResult = evaluateSolanaClaimPermissions(metricMissing);
  assert.equal(claim(metricResult, "market.liquidity_usd").outcome, "withheld_insufficient");
  assert.equal(claim(metricResult, "market.liquidity_usd").value, null);
  assert.equal(claim(metricResult, "market.liquidity_usd").evidence[0].reason, "not_reported");

  const noPool = await makeReport({ markets: [] });
  const noPoolResult = evaluateSolanaClaimPermissions(noPool);
  assert.equal(claim(noPoolResult, "market.price_usd").outcome, "withheld_insufficient");
  assert.equal(claim(noPoolResult, "market.volume_m5_usd").value, null);
  assert.equal(claim(noPoolResult, "market.volume_m5_usd").evidence[0].reason, "no_market");

  const unavailable = await makeReport();
  unavailable.market = { status: "unavailable", reason: "market_provider_unavailable" };
  assert.equal(claim(evaluateSolanaClaimPermissions(unavailable), "market.volume_h1_usd").outcome, "withheld_insufficient");
});

test("an unavailable metric on the selected pool is not substituted from another pool", async () => {
  const report = await makeReport({ markets: [
    pool({ priceUsd: null, liquidityUsd: "50000" }),
    pool({ poolAddress: key(96), dexId: "alternate-dex", priceUsd: "0.5", liquidityUsd: "10000" }),
  ] });
  assert.equal(report.market.evidence.primaryPoolAddress, POOL);
  const price = claim(evaluateSolanaClaimPermissions(report), "market.price_usd");
  assert.equal(price.outcome, "withheld_insufficient");
  assert.equal(price.scopeAddress, POOL);
  assert.equal(price.evidence[0].source.fieldPath.endsWith("pools[0].priceUsd"), true);
  assert.equal(price.evidence[0].reason, "not_reported");
});

test("market source timestamps stay source-supported and are not substituted", async () => {
  const report = await makeReport({ markets: [pool()] });
  report.market.evidence.provenance.sourceUpdatedAt = "2026-10-12T00:00:00.000Z";
  report.market.evidence.pools[0].provenance.sourceUpdatedAt = null;
  report.market.evidence.pools[0].provenance.fetchedAt = "2026-10-14T00:00:00.000Z";
  const output = evaluateSolanaClaimPermissions(report);
  const price = claim(output, "market.price_usd").evidence[0].source;
  assert.equal(price.observedAt, "2026-10-14T00:00:00.000Z");
  assert.equal(price.sourceUpdatedAt, null);
  assert.notEqual(price.observedAt, report.market.evidence.snapshotAt);
});

test("observed holder counts and raw sum are permitted as observed-frame facts; full population remains withheld", async () => {
  const output = evaluateSolanaClaimPermissions(await makeReport());
  for (const id of ["holders.token_account_count", "holders.positive_token_account_count", "holders.positive_owner_authority_count", "holders.observed_positive_balance_raw"]) {
    assert.equal(claim(output, id).outcome, "permitted");
    assert.ok(claim(output, id).limitationCodes.includes("observed_frame_only"));
  }
  assert.equal(claim(output, "holders.token_account_count").value, 1);
  assert.equal(claim(output, "holders.positive_token_account_count").value, 1);
  assert.equal(claim(output, "holders.positive_owner_authority_count").value, 1);
  assert.equal(claim(output, "holders.observed_positive_balance_raw").value, "100");
  assert.equal(claim(output, "holders.observed_positive_balance_raw").unit, "raw token units");
  assert.ok(claim(output, "holders.positive_owner_authority_count").limitationCodes.includes("owner_authorities_are_not_wallets_or_people"));
  assert.equal(claim(output, "holders.full_population_count").outcome, "withheld_insufficient");
  assert.equal(claim(output, "holders.full_population_count").reason, "unsupported_claim");
});

test("partial enumeration and varying context slots remain observed-frame only and withhold Top-N", async () => {
  const pageCursors = "23456789ABCDEFGHJKLMNP";
  const partialPages = Array.from({ length: 20 }, (_, index) => ({
    accounts: index === 0 ? [tokenAccount(TOKEN_ACCOUNT, 100n)] : index === 1 ? [tokenAccount(key(95), 200n)] : [],
    paginationKey: index === 19 ? "Z" : pageCursors[index],
    contextSlot: 100 + index,
  }));
  const report = await makeReport({
    holderCompleteness: "partial",
    holderStopReason: "page_cap",
    pages: partialPages,
  });
  const output = evaluateSolanaClaimPermissions(report);
  assert.equal(claim(output, "holders.token_account_count").outcome, "permitted");
  assert.ok(claim(output, "holders.token_account_count").limitationCodes.includes("partial_enumeration"));
  assert.ok(claim(output, "holders.token_account_count").evidence[0].source.contextSlots.length > 1);
  assert.equal(claim(output, "holders.token_account_count").evidence[0].sourceCoverage.acquisition.stopReason, "page_cap");
  assert.equal(claim(output, "holders.token_account_count").evidence[0].sourceCoverage.acquisition.configuredMaxPages, 20);
  for (const id of ["holders.concentration_top1", "holders.concentration_top5", "holders.concentration_top10", "holders.concentration_top20"]) {
    assert.equal(claim(output, id).outcome, "withheld_insufficient");
    assert.equal(claim(output, id).reason, "enumeration_incomplete");
  }
});

test("complete natural enumeration projects all Top-N concentrations and D10 permissions without an atomic-snapshot claim", async () => {
  const pages = [
    {
      accounts: [
        tokenAccount(key(101), 40n, { ownerAddress: key(1) }),
        tokenAccount(key(102), 30n, { ownerAddress: key(2) }),
      ],
      paginationKey: "2",
      contextSlot: 123,
    },
    {
      accounts: [
        tokenAccount(key(103), 20n, { ownerAddress: key(3) }),
        tokenAccount(key(104), 10n, { ownerAddress: key(4) }),
      ],
      paginationKey: null,
      contextSlot: 124,
    },
  ];
  const report = await makeReport({ mint: { supply: 100n }, pages });
  const structure = report.holders.evidence.holderStructure;
  assert.equal(structure.enumeration.completeness, "complete");
  assert.equal(structure.enumeration.slotConsistency, "not_guaranteed");
  assert.deepEqual(structure.enumeration.contextSlots, [123, 124]);
  assert.equal(structure.amountCoverage.state, "complete");
  assert.equal(structure.observedPositiveBalanceRaw, "100");
  assert.equal(structure.supplyDifferenceRaw, "0");

  const output = evaluateSolanaClaimPermissions(report);
  for (const [n, expectedPercentage, expectedNumerator] of [
    [1, "40.000000", "40"],
    [5, "100.000000", "100"],
    [10, "100.000000", "100"],
    [20, "100.000000", "100"],
  ]) {
    const item = claim(output, `holders.concentration_top${n}`);
    assert.equal(item.outcome, "permitted");
    assert.equal(item.value.percentage, expectedPercentage);
    assert.equal(item.value.numeratorRaw, expectedNumerator);
    assert.equal(item.value.denominatorRaw, "100");
    assert.equal(item.evidence[0].status, "available");
    assert.equal(item.evidence[0].value, expectedPercentage);
    assert.ok(item.limitationCodes.includes("not_atomic_with_mint_supply"));
    assert.ok(item.limitationCodes.includes("not_economic_control_concentration"));
  }
});

test("complete enumeration with partial Token-2022 amount coverage withholds concentration claims", async () => {
  const report = await makeReport({
    mint: { supply: 100n, tokenProgram: "token-2022" },
    pages: [{
      accounts: [tokenAccount(key(105), 40n, { tokenProgram: "token-2022", extension: { type: 2 } })],
      paginationKey: null,
      contextSlot: 123,
    }],
  });
  const structure = report.holders.evidence.holderStructure;
  assert.equal(structure.enumeration.completeness, "complete");
  assert.equal(structure.amountCoverage.state, "partial");
  assert.equal(structure.concentration.top1.status, "unavailable");
  assert.equal(structure.concentration.top1.reason, "unsupported_balance_affecting_extension");

  const output = evaluateSolanaClaimPermissions(report);
  for (const n of [1, 5, 10, 20]) {
    const item = claim(output, `holders.concentration_top${n}`);
    assert.equal(item.outcome, "withheld_insufficient");
    assert.equal(item.value, null);
    assert.equal(item.evidence[0].value, null);
    assert.equal(item.evidence[0].numeratorRaw, null);
    assert.equal(item.evidence[0].denominatorRaw, null);
  }
});

test("complete enumeration with observed positive balances above supply withholds concentration claims", async () => {
  const report = await makeReport({
    mint: { supply: 100n },
    pages: [{ accounts: [tokenAccount(key(106), 101n)], paginationKey: null, contextSlot: 123 }],
  });
  const structure = report.holders.evidence.holderStructure;
  assert.equal(structure.enumeration.completeness, "complete");
  assert.equal(structure.amountCoverage.state, "partial");
  assert.equal(structure.amountCoverage.reason, "supply_inconsistency");
  assert.equal(structure.concentration.top1.status, "unavailable");

  const output = evaluateSolanaClaimPermissions(report);
  for (const n of [1, 5, 10, 20]) {
    const item = claim(output, `holders.concentration_top${n}`);
    assert.equal(item.outcome, "withheld_insufficient");
    assert.equal(item.value, null);
    assert.equal(item.evidence[0].reason, "supply_inconsistency");
    assert.equal(item.evidence[0].value, null);
  }
});

test("empty naturally completed enumeration with positive supply withholds and redacts concentration claims", async () => {
  const report = await makeReport({
    mint: { supply: 100n },
    pages: [
      { accounts: [], paginationKey: "2", contextSlot: 123 },
      { accounts: [], paginationKey: null, contextSlot: 124 },
    ],
  });
  const structure = report.holders.evidence.holderStructure;
  assert.equal(structure.enumeration.completeness, "complete");
  assert.equal(structure.enumeration.slotConsistency, "not_guaranteed");
  assert.deepEqual(structure.enumeration.contextSlots, [123, 124]);
  assert.equal(structure.tokenAccountCount, 0);
  assert.equal(structure.nonzeroTokenAccountCount, 0);
  assert.equal(structure.observedPositiveBalanceRaw, "0");
  assert.equal(structure.supplyDifferenceRaw, "100");
  assert.equal(structure.amountCoverage.state, "complete");
  for (const topN of [1, 5, 10, 20]) {
    assert.equal(structure.concentration[`top${topN}`].status, "unavailable");
    assert.equal(structure.concentration[`top${topN}`].reason, "empty_observed_population");
  }

  const output = evaluateSolanaClaimPermissions(report);
  for (const topN of [1, 5, 10, 20]) {
    const item = claim(output, `holders.concentration_top${topN}`);
    assert.equal(item.outcome, "withheld_insufficient");
    assert.equal(item.reason, "metric_not_eligible");
    assert.equal(item.value, null);
    assert.equal(item.evidence[0].status, "unavailable");
    assert.equal(item.evidence[0].reason, "empty_observed_population");
    assert.equal(item.evidence[0].value, null);
    assert.equal(item.evidence[0].numeratorRaw, null);
    assert.equal(item.evidence[0].denominatorRaw, null);
    assert.equal(JSON.stringify(item).includes('"percentage":"0.000000"'), false);
    assert.ok(item.limitationCodes.includes("slot_consistency_not_guaranteed"));
    assert.ok(item.limitationCodes.includes("not_atomic_with_mint_supply"));
  }

  const presentation = presentSolanaTokenEvidenceReport(report).sections[2];
  assert.equal(presentation.concentration.every((item) => item.status === "unavailable" && item.reason === "empty_observed_population"), true);

  const zeroRowsReport = await makeReport({
    mint: { supply: 100n },
    pages: [{
      accounts: [
        tokenAccount(key(107), 0n, { ownerAddress: key(1) }),
        tokenAccount(key(108), 0n, { ownerAddress: key(2) }),
      ],
      paginationKey: null,
      contextSlot: 125,
    }],
  });
  assert.equal(zeroRowsReport.holders.evidence.holderStructure.tokenAccountCount, 2);
  assert.equal(zeroRowsReport.holders.evidence.holderStructure.nonzeroTokenAccountCount, 0);
  for (const topN of [1, 5, 10, 20]) {
    const item = claim(evaluateSolanaClaimPermissions(zeroRowsReport), `holders.concentration_top${topN}`);
    assert.equal(item.outcome, "withheld_insufficient");
    assert.equal(item.evidence[0].reason, "empty_observed_population");
    assert.equal(item.evidence[0].value, null);
    assert.equal(item.evidence[0].numeratorRaw, null);
    assert.equal(item.evidence[0].denominatorRaw, null);
  }

  const zeroSupplyReport = await makeReport({
    mint: { supply: 0n },
    pages: [{ accounts: [], paginationKey: null, contextSlot: 126 }],
  });
  for (const topN of [1, 5, 10, 20]) {
    const item = claim(evaluateSolanaClaimPermissions(zeroSupplyReport), `holders.concentration_top${topN}`);
    assert.equal(item.outcome, "withheld_insufficient");
    assert.equal(item.evidence[0].reason, "zero_supply");
  }
});

test("snapshot validation accepts consistent non-default collection limits and rejects contradictory acquisition metadata", async () => {
  const complete = await makeReport();
  const completeRecord = structuredClone(complete.holders.evidence.snapshotRecord);
  completeRecord.acquisition.configuredMaxPages = 7;
  completeRecord.acquisition.requestedPageSize = 2048;
  complete.holders.evidence.snapshotRecord = completeRecord;
  assert.equal(claim(evaluateSolanaClaimPermissions(complete), "holders.token_account_count").value, 1);

  const partial = await makeReport({ holderCompleteness: "partial", holderStopReason: "request_timeout" });
  const partialRecord = structuredClone(partial.holders.evidence.snapshotRecord);
  partialRecord.acquisition.configuredMaxPages = 7;
  partialRecord.acquisition.requestedPageSize = 2048;
  partial.holders.evidence.snapshotRecord = partialRecord;
  partial.holders.evidence.holderStructure.acquisition.configuredMaxPages = 7;
  partial.holders.evidence.holderStructure.acquisition.requestedPageSize = 2048;
  assert.equal(claim(evaluateSolanaClaimPermissions(partial), "holders.token_account_count").value, 1);
  assert.equal(claim(evaluateSolanaClaimPermissions(partial), "holders.token_account_count").evidence[0].sourceCoverage.acquisition.configuredMaxPages, 7);

  const contradictory = structuredClone(partial);
  contradictory.holders.evidence.snapshotRecord.acquisition.configuredMaxPages = 8;
  assert.throws(() => evaluateSolanaClaimPermissions(contradictory), SolanaClaimPermissionInputError);

  const invalid = structuredClone(complete);
  invalid.holders.evidence.snapshotRecord.acquisition.requestedPageSize = 0;
  assert.throws(() => evaluateSolanaClaimPermissions(invalid), SolanaClaimPermissionInputError);
});

test("withheld and not-evaluated claims redact evidence values while preserving safe metadata and permitted exact values", async () => {
  const report = await makeReport();
  const output = evaluateSolanaClaimPermissions(report);
  const withheld = claim(output, "holders.full_population_count");
  const withheldReference = withheld.evidence[0];
  assert.equal(withheld.outcome, "withheld_insufficient");
  assert.equal(withheld.value, null);
  assert.equal(withheldReference.value, null);
  assert.equal(withheldReference.numeratorRaw, null);
  assert.equal(withheldReference.denominatorRaw, null);
  assert.equal(withheldReference.sourceCoverage.supplyDifferenceRaw, null);
  assert.equal(withheldReference.sourceCoverage.acquisition.configuredMaxPages, 20);
  assert.equal(JSON.stringify(withheld).includes('"value":1'), false);

  const notEvaluated = claim(output, "historical.sampled_activity");
  assert.equal(notEvaluated.outcome, "not_evaluated_not_requested");
  assert.equal(notEvaluated.evidence.every((reference) => reference.value === null && reference.numeratorRaw === null && reference.denominatorRaw === null), true);

  const permitted = claim(output, "holders.observed_positive_balance_raw");
  assert.equal(permitted.outcome, "permitted");
  assert.equal(permitted.value, "100");
  assert.equal(permitted.evidence[0].value, "100");
});

test("partial amount coverage preserves observed exact raw sums while eligible concentration carries partial caveats", async () => {
  const report = await makeReport();
  const structure = report.holders.evidence.holderStructure;
  structure.amountCoverage = { state: "partial", unsupportedExtensionTypes: [25], reason: "unsupported_balance_affecting_extension" };
  const coverage = report.holders.evidence.ownerAuthorityBalanceDistribution.coverage;
  coverage.state = "partial";
  coverage.amountCoverageState = "partial";
  coverage.amountCoverageReason = "unsupported_balance_affecting_extension";
  coverage.unsupportedExtensionTypes = [25];
  const partialSnapshotRecord = structuredClone(report.holders.evidence.snapshotRecord);
  partialSnapshotRecord.snapshot.amountCoverage = structuredClone(structure.amountCoverage);
  report.holders.evidence.snapshotRecord = partialSnapshotRecord;
  const output = evaluateSolanaClaimPermissions(report);
  const sum = claim(output, "holders.observed_positive_balance_raw");
  assert.equal(sum.outcome, "permitted");
  assert.equal(sum.value, "100");
  assert.ok(sum.limitationCodes.includes("partial_amount_coverage"));
  assert.equal(claim(output, "holders.concentration_top1").outcome, "permitted");
  assert.ok(claim(output, "holders.concentration_top1").limitationCodes.includes("partial_amount_coverage"));
});

test("observed-frame distribution preserves only existing eligible ledger values", async () => {
  const output = evaluateSolanaClaimPermissions(await makeReport());
  const distribution = claim(output, "holders.observed_frame_balance_distribution");
  assert.equal(distribution.outcome, "permitted");
  assert.equal(distribution.value["holders.distribution.minimum_balance_raw"], "100");
  assert.equal(distribution.value["holders.distribution.quantile_p99_raw"], "100");
  assert.equal(JSON.stringify(distribution).includes(OWNER), false);
  assert.equal(JSON.stringify(distribution).includes(TOKEN_ACCOUNT), false);
});

test("zero positive-balance observations remain explicit and do not erase the observed empty distribution", async () => {
  const report = await makeReport({ pages: [{ accounts: [tokenAccount(TOKEN_ACCOUNT, 0n)], paginationKey: null, contextSlot: 100 }] });
  const output = evaluateSolanaClaimPermissions(report);
  assert.equal(claim(output, "holders.positive_owner_authority_count").value, 0);
  assert.equal(claim(output, "holders.observed_positive_balance_raw").value, "0");
  const distribution = claim(output, "holders.observed_frame_balance_distribution");
  assert.equal(distribution.outcome, "permitted");
  assert.deepEqual(distribution.value["holders.distribution.repeated_balance_groups"], []);
  assert.equal(distribution.value["holders.distribution.minimum_balance_raw"], undefined);
});

test("Top-N concentration reuses exact eligible metric values and numerator/denominator without recomputation", async () => {
  const report = await makeReport();
  const ledgerSource = require("../dist/analysis/solanaQualificationMetricEvidence.js").deriveSolanaQualificationMetricEvidence(report);
  const expected = ledgerSource.entries.find((entry) => entry.id === "holders.concentration_top1");
  const item = claim(evaluateSolanaClaimPermissions(report), "holders.concentration_top1");
  assert.equal(item.outcome, "permitted");
  assert.equal(item.value.percentage, expected.value);
  assert.equal(item.value.numeratorRaw, expected.numeratorRaw);
  assert.equal(item.value.denominatorRaw, expected.denominatorRaw);
  assert.equal(item.evidence[0].source.fieldPath, expected.source.fieldPath);
  assert.ok(item.limitationCodes.includes("not_atomic_with_mint_supply"));
  assert.ok(item.limitationCodes.includes("not_economic_control_concentration"));
});

test("base authority states, token program, classic not-applicable inventory, and empty Token-2022 inventory stay distinct", async () => {
  const classic = evaluateSolanaClaimPermissions(await makeReport({ mint: { mintAuthority: OWNER, freezeAuthority: null } }));
  assert.equal(claim(classic, "token_controls.mint_authority_state").value, "set");
  assert.equal(claim(classic, "token_controls.freeze_authority_state").value, "unset");
  assert.equal(claim(classic, "token_controls.token_program").value, "spl-token");
  const classicInventory = claim(classic, "token_controls.mint_extension_inventory");
  assert.equal(classicInventory.outcome, "permitted");
  assert.deepEqual(classicInventory.value, { status: "not_applicable", reason: "classic_spl_token_program" });

  const token2022 = evaluateSolanaClaimPermissions(await makeReport({
    mint: { tokenProgram: "token-2022" },
    pages: [{ accounts: [], paginationKey: null, contextSlot: 100 }],
  }));
  assert.equal(claim(token2022, "token_controls.token_program").value, "token-2022");
  assert.deepEqual(claim(token2022, "token_controls.mint_extension_inventory").value, []);
  assert.notDeepEqual(claim(token2022, "token_controls.mint_extension_inventory").value, classicInventory.value);
  assert.ok(classicInventory.limitationCodes.includes("not_security_or_risk_assessment"));
});

test("history not requested, unavailable, and successful empty bounded query remain distinct", async () => {
  const notRequested = evaluateSolanaClaimPermissions(await makeReport());
  for (const id of ["historical.sampled_activity", "historical.transaction_integration_coverage"]) {
    const item = claim(notRequested, id);
    assert.equal(item.outcome, "not_evaluated_not_requested");
    assert.equal(item.value, null);
    assert.equal(item.reason, "history_not_requested");
    assert.ok(item.limitationCodes.includes("bounded_selected_authorities_only"));
    assert.ok(item.evidence.length > 0);
    for (const reference of item.evidence) {
      assert.equal(reference.value, null);
      assert.equal(reference.numeratorRaw, null);
      assert.equal(reference.denominatorRaw, null);
      assert.equal(reference.status, "not_requested");
      assert.equal(typeof reference.metricId, "string");
      assert.equal(reference.source.section, "historicalTransactions");
      assert.equal(typeof reference.source.fieldPath, "string");
      assert.equal(reference.source.provider, null);
      assert.equal(reference.source.method, null);
    }
  }
  assert.equal(claim(notRequested, "historical.momentum").outcome, "withheld_insufficient");

  const unavailableReport = await makeReport();
  unavailableReport.historicalTransactions = { status: "unavailable", reason: "provider_unavailable" };
  assert.equal(claim(evaluateSolanaClaimPermissions(unavailableReport), "historical.sampled_activity").outcome, "withheld_insufficient");

  const successfulEmpty = evaluateSolanaClaimPermissions(await makeReport({ history: "present" }));
  const sampled = claim(successfulEmpty, "historical.sampled_activity");
  assert.equal(sampled.outcome, "permitted");
  assert.equal(sampled.value.authorities[0].metrics.find((metric) => metric.id === "historical.authority.accepted_observation_count").value, 0);
  assert.equal(sampled.value.requestedWindow.fromUnixSecondsInclusive, WINDOW.fromUnixSecondsInclusive);
  assert.ok(sampled.limitationCodes.includes("requested_window_is_not_observed_coverage"));
  assert.ok(sampled.limitationCodes.includes("no_trade_or_direction_inference"));
});

test("conflicting transaction-integration evidence is withheld without converting it to unavailable", async () => {
  const report = await makeReport({ history: "present" });
  report.historicalTransactions.evidence.transactionIntegration.coverage.downstream.status = "conflicting";
  const result = evaluateSolanaClaimPermissions(report);
  const integration = claim(result, "historical.transaction_integration_coverage");
  assert.equal(integration.outcome, "withheld_conflicting");
  assert.equal(integration.reason, "conflicting_evidence");
  assert.equal(integration.evidence[0].status, "conflicting");
  assert.equal(claim(result, "historical.sampled_activity").outcome, "permitted");
});

test("malformed report and cross-section identity mismatches fail explicitly", async () => {
  const report = await makeReport();
  assert.throws(() => evaluateSolanaClaimPermissions({ ...report, schemaVersion: "wrong" }), SolanaQualificationMetricEvidenceInputError);
  report.market.evidence.mintAddress = key(88);
  assert.throws(() => evaluateSolanaClaimPermissions(report), (error) => error instanceof SolanaQualificationMetricEvidenceInputError && error.reason === "identity_mismatch");
});

test("rejects malformed derived metric values instead of permitting fabricated availability", async () => {
  const report = await makeReport();
  report.market.evidence.pools[0].priceUsd.value = "12.5\n";
  assert.throws(() => evaluateSolanaClaimPermissions(report), SolanaClaimPermissionInputError);

  const badConcentration = await makeReport();
  badConcentration.holders.evidence.holderStructure.concentration.top1.percentage = "500.000000";
  const badConcentrationRecord = structuredClone(badConcentration.holders.evidence.snapshotRecord);
  badConcentrationRecord.snapshot.concentration.top1.percentage = "500.000000";
  badConcentration.holders.evidence.snapshotRecord = badConcentrationRecord;
  assert.throws(() => evaluateSolanaClaimPermissions(badConcentration), SolanaClaimPermissionInputError);
});

test("rejects contradictory snapshot acquisition provenance before permitting holder claims", async () => {
  const report = await makeReport();
  const badRecord = structuredClone(report.holders.evidence.snapshotRecord);
  badRecord.acquisition.stopReason = "page_cap";
  report.holders.evidence.snapshotRecord = badRecord;
  assert.throws(() => evaluateSolanaClaimPermissions(report), SolanaClaimPermissionInputError);
});
