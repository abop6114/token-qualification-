const assert = require("node:assert/strict");
const { test } = require("node:test");
const { presentSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidencePresentation.js");
const { generateSolanaTokenEvidenceReport } = require("../dist/application/solanaTokenEvidenceReport.js");

const MINT = "11111111111111111111111111111111";
const AUTHORITY = "Vote111111111111111111111111111111111111111";
const FETCHED = "2026-10-13T15:00:00.000Z";
const HUGE = "18446744073709551615";
const rawMetric = (value, sourceField = "priceUsd") => ({ status: "available", value, basis: "provider_reported", sourceField });
const missingMetric = (reason = "not_reported") => ({ status: "unavailable", value: null, reason });

function concentration(topN, numeratorRaw = "12345678901234567890", percentage = "12.345678") {
  return { status: "available", topN, numeratorRaw, denominatorRaw: HUGE, denominatorBasis: "current_mint_supply", percentage };
}

function report(overrides = {}) {
  const top = { top1: concentration(1), top5: concentration(5), top10: concentration(10), top20: concentration(20) };
  return {
    schemaVersion: "solana-token-evidence-report-v1",
    chain: "solana",
    assetAddress: MINT,
    generatedAt: "2026-10-14T12:00:00.000Z",
    mint: {
      status: "present",
      evidence: {
        resolution: {
          exists: true,
          isMint: true,
          mintAddress: MINT,
          tokenProgram: "spl-token",
          decimals: 9,
          rawSupply: HUGE,
          baseAuthorities: {
            mintAuthority: { status: "unset", address: null },
            freezeAuthority: { status: "set", address: AUTHORITY },
          },
        },
        token2022MintExtensionInventory: {
          schemaVersion: "solana-token-2022-mint-extension-inventory-v1",
          chain: "solana",
          mintAddress: MINT,
          tokenProgram: "spl-token",
          status: "not_applicable",
        },
      },
    },
    market: {
      status: "present",
      evidence: {
        chain: "solana",
        mintAddress: MINT,
        snapshotAt: "2026-10-13T15:00:01.000Z",
        tokenCreatedAt: missingMetric("no_creation_evidence"),
        tokenAgeSeconds: missingMetric("no_creation_evidence"),
        lifecycle: { state: "unknown", basis: "unknown", evidence: null },
        pools: [],
        primaryPoolAddress: null,
        provenance: { provider: "dexscreener", fetchedAt: FETCHED, sourceUpdatedAt: null },
      },
    },
    holders: {
      status: "present",
      evidence: {
        holderStructure: {
          chain: "solana",
          mintAddress: MINT,
          tokenProgram: "spl-token",
          decimals: 9,
          currentMintSupplyRaw: HUGE,
          observedPositiveBalanceRaw: "12345678901234567890",
          supplyDifferenceRaw: "6101065172499993725",
          fetchedAt: FETCHED,
          enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [300, 301] },
          tokenAccountCount: 3,
          nonzeroTokenAccountCount: 2,
          tokenAccountStateSummary: { initialized: {}, frozen: {} },
          rawOwnerCount: 1,
          rawOwnerAuthorities: [{ ownerAddress: AUTHORITY, balanceRaw: "12345678901234567890", tokenAccountCount: 2 }],
          amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null },
          concentration: top,
        },
        ownerAuthorityBalanceDistribution: {
          chain: "solana",
          assetAddress: MINT,
          population: "positive_owner_authorities",
          observedOwnerAuthorityCount: 1,
          decimals: 9,
          currentSupplyRaw: HUGE,
          observedPositiveOwnerAuthorityBalanceRaw: "12345678901234567890",
          cumulativeOwnerBalanceProfile: [{ ownerPercentile: 100, includedOwnerAuthorityCount: 1, cumulativeObservedBalanceRaw: "12345678901234567890", cumulativeObservedBalanceShare: "100.000000" }],
          minimumBalanceRaw: "12345678901234567890",
          maximumBalanceRaw: "12345678901234567890",
          medianBalanceRaw: "12345678901234567890",
          quantilesRaw: { p25: "12345678901234567890", p50: "12345678901234567890", p75: "12345678901234567890", p90: "12345678901234567890", p99: "12345678901234567890" },
          distinctBalanceCount: 1,
          repeatedBalanceGroupCount: 0,
          authoritiesInRepeatedBalanceGroups: 0,
          authorityShareInRepeatedBalanceGroups: "0.000000",
          repeatedBalanceGroups: [],
          repeatedBalanceGroupsOmitted: 0,
          coverage: { state: "complete", source: "normalized_holder_snapshot", sourceSnapshotAt: FETCHED, enumerationCompleteness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [300, 301], amountCoverageState: "complete", amountCoverageReason: null, unsupportedExtensionTypes: [] },
        },
        snapshotRecord: {
          schemaVersion: "solana-holder-snapshot-record-v2",
          snapshotId: "snapshot-id",
          source: { provider: "helius", method: "getProgramAccountsV2", commitment: "finalized" },
          acquisition: { completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000 },
          snapshot: {},
        },
      },
    },
    historicalTransactions: { status: "not_requested" },
    ...overrides,
  };
}

function fieldById(section, id) {
  const result = section.fields.find((item) => item.id === id);
  assert.ok(result, `field ${id} exists`);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function historyEvidence(overrides = {}) {
  const signature = "5".repeat(80);
  const candidate = {
    signature,
    sourceObservations: [],
    disposition: { status: "selected", selectionPosition: 0 },
    acquisition: { status: "returned", provenance: { chain: "solana", provider: "helius", method: "getTransaction", encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0, requestedSignature: signature, fetchedAt: FETCHED } },
    normalization: { status: "available", transaction: { signatures: [signature], execution: { status: "failed", basis: "provider_meta_err_non_null", reportedError: { error: "example" } } } },
  };
  const authority = {
    authorityAddress: AUTHORITY,
    queryStatus: "success",
    paginationStatus: "truncated",
    terminalReason: "page_and_record_caps",
    requestCount: 2,
    pages: [{ pageNumber: 1, requestLimit: 100, recordCount: 2, startRecordIndex: 0, endRecordIndexExclusive: 2, continuationTokenUsed: false, continuationTokenReturned: true, firstUsableBlockTime: 100, lastUsableBlockTime: 90, minimumUsableBlockTime: 90, maximumUsableBlockTime: 100, recordsWithoutUsableBlockTime: 0 }],
    observations: [
      { providerRecord: { signature, amount: { rawAmount: "12", exactRawAvailable: true } }, observedTime: { status: "available", unixSeconds: 100, basis: "provider_reported" } },
      { providerRecord: { signature, amount: { rawAmount: null, exactRawAvailable: false, reportedAmount: "0.5" } }, observedTime: { status: "available", unixSeconds: 90, basis: "provider_reported" } },
    ],
    providerError: null,
  };
  const profile = { exactRawAmountObservationCount: 1, nonExactOrUnavailableAmountObservationCount: 1, reportedAmountTypeCounts: [], exactRawAmountCoverage: "partial", minimumExactRawAmount: "12", maximumExactRawAmount: "12" };
  const metricValue = (value) => ({ status: "available", value, queryCompleteness: "partial" });
  const authorityMetrics = {
    authorityAddress: AUTHORITY,
    queryStatus: "success",
    paginationStatus: "truncated",
    acceptedObservationCount: metricValue(2),
    usableBlockTimeCount: metricValue(2),
    missingBlockTimeCount: metricValue(0),
    observedBlockTimeBounds: metricValue({ minimumUnixSeconds: 90, maximumUnixSeconds: 100, spanSeconds: 10 }),
    distinctSignatureCount: metricValue(1),
    reportedTransferTypeCounts: { status: "unavailable", value: null, reason: "no_usable_block_times" },
    reportedEndpointRelationshipCounts: { status: "unavailable", value: null, reason: "no_usable_block_times" },
    amountEvidenceProfile: metricValue(profile),
  };
  const integratedCandidate = {
    candidateIndex: 0,
    signature,
    status: "integrated",
    balanceFlow: { status: "partial" },
    instructionEvidence: { coverage: { outer: { status: "partial" }, inner: { status: "unavailable" }, processing: "partial" } },
    reconciliation: { coverage: { status: "conflicting", reasonCodes: ["pair_reference_conflict"] } },
  };
  const evidence = {
    authoritySelection: {},
    queryPlan: {
      planVersion: "solana-bounded-history-query-plan-v2",
      mintAddress: MINT,
      requestedWindow: { fromUnixSecondsInclusive: 50, toUnixSecondsExclusive: 200 },
      maxPagesPerAuthority: 2,
      maxRecordsPerAuthority: 150,
      selectedAuthorityCount: 1,
      candidateAuthorities: [
        { authorityAddress: AUTHORITY, balanceRaw: "100", observedCandidateFrameRank: 0, plannedDisposition: { status: "selected", selectionPosition: 0, selectionReason: "rank_position" } },
        { authorityAddress: "Stake11111111111111111111111111111111111111", balanceRaw: "50", observedCandidateFrameRank: 1, plannedDisposition: { status: "not_selected" } },
      ],
    },
    execution: {
      evidence: {
        chain: "solana",
        mintAddress: MINT,
        provenance: { provider: "helius", method: "getTransfersByAddress", fetchedAt: FETCHED, requestedWindow: { fromUnixSecondsInclusive: 50, toUnixSecondsExclusive: 200 }, maxAuthorities: 1, maxPagesPerAuthority: 2, maxRecordsPerAuthority: 150 },
        authorityScope: { source: "holder_snapshot", candidateAuthorityCount: 2, candidateSetCompleteness: "partial" },
        authorities: [authority, {
          authorityAddress: "Stake11111111111111111111111111111111111111", queryStatus: "not_queried", reason: "not_selected",
          paginationStatus: "not_applicable", terminalReason: "not_queried", requestCount: 0, pages: [], observations: [], providerError: null,
        }],
        applicationDerivedEvidence: { status: "not_calculated", metrics: null },
      },
      telemetry: { apiKeySentinel: "must-not-appear" },
    },
    descriptiveMetrics: {
      version: "solana-historical-descriptive-metrics-v1",
      source: { mintAddress: MINT, requestedWindow: { fromUnixSecondsInclusive: 50, toUnixSecondsExclusive: 200 }, evidenceFetchedAt: FETCHED, selectorVersion: "selector", selectionBasis: "basis", candidateAuthorityCount: 2, candidateSetCompleteness: "partial", selectedAuthorityCount: 1 },
      sampleCoverage: { candidateAuthorityCount: 2, selectedAuthorityCount: 1, queriedAuthorityCount: 1, naturallyCompleteAuthorityCount: 0, truncatedAuthorityCount: 1, providerErrorAuthorityCount: 0, unqueriedAuthorityCount: 1 },
      authorities: [authorityMetrics],
    },
    transactionSelection: { selectedUniqueSignatureCount: 1, candidates: [] },
    transactionEnrichment: {
      selection: {},
      evidence: { executionCompleteness: "partial", candidates: [candidate] },
      telemetry: { attemptedSignatureCount: 1, requestCount: 1, secret: "omit-telemetry" },
    },
    transactionIntegration: {
      phase2A: { secret: "do-not-copy" },
      candidates: [integratedCandidate],
      coverage: { candidateSet: { status: "some_eligible", candidateCount: 1, eligibleCount: 1, ineligibleCount: 0 }, downstream: { status: "conflicting", completeCount: 0, partialCount: 0, unavailableCount: 0, conflictingCount: 1 } },
    },
  };
  return { status: "present", evidence: { ...evidence, ...overrides } };
}

test("emits exact v1 schema, Solana chain, fixed ordered sections, and null unsupplied name/symbol", () => {
  const result = presentSolanaTokenEvidenceReport(report());
  assert.equal(result.schemaVersion, "solana-token-evidence-presentation-v1");
  assert.equal(result.sourceReportSchemaVersion, "solana-token-evidence-report-v1");
  assert.equal(result.chain, "solana");
  assert.deepEqual(result.sections.map((section) => [section.id, section.label]), [
    ["identity_mint", "Identity and mint"], ["market", "Market"], ["holders", "Holders"], ["historical", "Historical evidence"],
  ]);
  assert.deepEqual(result.token, { requestedMintAddress: MINT, name: null, symbol: null });
});

test("identity fields use a fixed allowlisted order", () => {
  const fields = presentSolanaTokenEvidenceReport(report()).sections[0].fields;
  assert.deepEqual(fields.map((item) => item.id), [
    "identity.requested_mint_address", "identity.resolved_mint_address", "identity.account_exists", "identity.is_mint",
    "identity.token_program", "identity.decimals", "identity.raw_supply", "identity.mint_authority_status",
    "identity.mint_authority_address", "identity.freeze_authority_status", "identity.freeze_authority_address",
    "identity.extension_inventory_status",
  ]);
});

test("market pool fields have a fixed allowlisted order", () => {
  const pool = {
    poolAddress: "Pool11111111111111111111111111111111111111", dexId: "dex", counterTokenAddress: null,
    poolCreatedAt: missingMetric("no_market"), priceUsd: rawMetric("0.000000000000000001", "priceUsd"),
    marketCapUsd: missingMetric(), fdvUsd: missingMetric(), liquidityUsd: rawMetric("0", "liquidity.usd"),
    volumeUsd: { m5: missingMetric(), h1: missingMetric(), h6: missingMetric(), h24: missingMetric() },
    provenance: { provider: "dexscreener", fetchedAt: FETCHED, sourceUpdatedAt: null },
  };
  const result = presentSolanaTokenEvidenceReport(report({ market: { status: "present", evidence: { ...report().market.evidence, pools: [pool], primaryPoolAddress: pool.poolAddress } } }));
  assert.deepEqual(result.sections[1].pools[0].fields.map((item) => item.id), [
    "market.source_updated_at", "market.pool_created_at", "market.price_usd", "market.market_cap_usd", "market.fdv_usd",
    "market.liquidity_usd", "market.volume_m5_usd", "market.volume_h1_usd", "market.volume_h6_usd", "market.volume_h24_usd",
  ]);
});

test("identical input produces deeply equal deterministic output", () => {
  const input = report();
  assert.deepEqual(presentSolanaTokenEvidenceReport(input), presentSolanaTokenEvidenceReport(input));
});

test("presentation does not mutate the deeply frozen report", () => {
  const input = deepFreeze(report());
  const before = JSON.stringify(input);
  presentSolanaTokenEvidenceReport(input);
  assert.equal(JSON.stringify(input), before);
});

test("source present remains present while explicit partial holder coverage is separate", () => {
  const input = report();
  input.holders.evidence.holderStructure.enumeration.completeness = "partial";
  input.holders.evidence.holderStructure.amountCoverage.state = "partial";
  input.holders.evidence.snapshotRecord.acquisition = { completeness: "partial", stopReason: "request_timeout", configuredMaxPages: 20, requestedPageSize: 5000 };
  const result = presentSolanaTokenEvidenceReport(input).sections[2];
  assert.equal(result.sourceStatus.status, "present");
  assert.equal(result.completeness, "partial");
  assert.equal(result.acquisition.stopReason, "request_timeout");
});

test("partial snapshot acquisition cannot be hidden by contradictory complete nested coverage", () => {
  const input = report();
  input.holders.evidence.snapshotRecord.acquisition = { completeness: "partial", stopReason: "provider_error", configuredMaxPages: 20, requestedPageSize: 5000 };
  const result = presentSolanaTokenEvidenceReport(input).sections[2];
  assert.equal(result.sourceStatus.status, "present");
  assert.equal(result.completeness, "partial");
});

test("unavailable and not-attempted source statuses remain distinct", () => {
  const input = report({
    market: { status: "unavailable", reason: "market_provider_unavailable", errorCategory: "transport" },
    holders: { status: "not_attempted", reason: "mint_unresolved" },
  });
  const result = presentSolanaTokenEvidenceReport(input);
  assert.deepEqual(result.sections[1].sourceStatus, { status: "unavailable", reason: "market_provider_unavailable", errorCategory: "transport" });
  assert.deepEqual(result.sections[2].sourceStatus, { status: "not_attempted", reason: "mint_unresolved" });
});

test("historical not-requested and not-attempted states remain distinct", () => {
  const notRequested = presentSolanaTokenEvidenceReport(report()).sections[3];
  const notAttempted = presentSolanaTokenEvidenceReport(report({ historicalTransactions: { status: "not_attempted", reason: "holder_evidence_unavailable" } })).sections[3];
  assert.deepEqual(notRequested.sourceStatus, { status: "not_requested" });
  assert.deepEqual(notAttempted.sourceStatus, { status: "not_attempted", reason: "holder_evidence_unavailable" });
});

test("successful empty market result is not represented as unavailable or zero liquidity", () => {
  const result = presentSolanaTokenEvidenceReport(report()).sections[1];
  assert.equal(result.sourceStatus.status, "present");
  assert.equal(fieldById(result, "market.pool_count").value, 0);
  assert.equal(result.pools.length, 0);
  assert.equal(result.primaryPoolAddress, null);
  const primary = fieldById(result, "market.primary_pool_address");
  assert.equal(primary.status, "available");
  assert.equal(primary.value, null);
  assert.equal(primary.reason, "no_eligible_pools");
  assert.equal(primary.displayValue, "No primary pool selected");
  assert.ok(result.limitations.some((text) => text.includes("no eligible pools")));
});

test("snapshot-level and pool-level market fields retain their own observation times", () => {
  const input = report();
  const snapshotAt = "2026-10-13T15:10:00.000Z";
  const poolFetchedAt = "2026-10-13T15:09:00.000Z";
  const poolUpdatedAt = "2026-10-13T15:08:00.000Z";
  input.market.evidence.provenance.fetchedAt = snapshotAt;
  const pool = {
    poolAddress: "Pool11111111111111111111111111111111111111", dexId: "dex", counterTokenAddress: null,
    poolCreatedAt: rawMetric("2026-10-01T00:00:00.000Z"), priceUsd: rawMetric("2.5"),
    marketCapUsd: rawMetric("250"), fdvUsd: rawMetric("300"), liquidityUsd: rawMetric("80"),
    volumeUsd: { m5: rawMetric("1"), h1: rawMetric("2"), h6: rawMetric("3"), h24: rawMetric("4") },
    provenance: { provider: "dexscreener", fetchedAt: poolFetchedAt, sourceUpdatedAt: poolUpdatedAt },
  };
  input.market.evidence.pools = [pool];
  input.market.evidence.primaryPoolAddress = pool.poolAddress;

  const result = presentSolanaTokenEvidenceReport(input).sections[1];
  assert.equal(fieldById(result, "market.provider_fetch_time").provenance.observedAt, snapshotAt);
  assert.equal(result.pools[0].provenance.observedAt, poolFetchedAt);
  assert.equal(result.pools[0].provenance.sourceUpdatedAt, poolUpdatedAt);
  for (const id of ["market.pool_created_at", "market.price_usd", "market.market_cap_usd", "market.fdv_usd", "market.liquidity_usd", "market.volume_m5_usd", "market.volume_h1_usd", "market.volume_h6_usd", "market.volume_h24_usd"]) {
    const metric = fieldById(result.pools[0], id);
    assert.equal(metric.provenance.observedAt, poolFetchedAt, `${id} uses pool fetch time`);
    assert.equal(metric.provenance.sourceUpdatedAt, poolUpdatedAt, `${id} uses pool update time`);
  }
  const poolUpdateField = fieldById(result.pools[0], "market.source_updated_at");
  assert.equal(poolUpdateField.provenance.observedAt, poolFetchedAt);
  assert.equal(poolUpdateField.provenance.sourceUpdatedAt, poolUpdatedAt);
});

test("explicit zero holder population remains distinct from absent holder evidence", () => {
  const input = report();
  const s = input.holders.evidence.holderStructure;
  Object.assign(s, { tokenAccountCount: 0, nonzeroTokenAccountCount: 0, rawOwnerCount: 0, observedPositiveBalanceRaw: "0", rawOwnerAuthorities: [] });
  const d = input.holders.evidence.ownerAuthorityBalanceDistribution;
  Object.assign(d, { observedOwnerAuthorityCount: 0, observedPositiveOwnerAuthorityBalanceRaw: "0", minimumBalanceRaw: null, maximumBalanceRaw: null, medianBalanceRaw: null, quantilesRaw: { p25: null, p50: null, p75: null, p90: null, p99: null }, distinctBalanceCount: 0, repeatedBalanceGroupCount: 0, authoritiesInRepeatedBalanceGroups: 0, authorityShareInRepeatedBalanceGroups: null, repeatedBalanceGroups: [], repeatedBalanceGroupsOmitted: 0 });
  const result = presentSolanaTokenEvidenceReport(input).sections[2];
  assert.equal(result.sourceStatus.status, "present");
  assert.equal(fieldById(result, "holders.token_account_count").value, 0);
  assert.equal(fieldById(result, "holders.positive_balance_owner_authority_count").value, 0);
  assert.equal(fieldById(result, "holders.minimum_balance_raw").status, "unavailable");
  assert.equal(result.balanceDistribution.observedPositiveOwnerAuthorityBalanceRaw, "0");
});

test("large raw mint supply and holder balances remain exact decimal strings", () => {
  const result = presentSolanaTokenEvidenceReport(report());
  assert.equal(fieldById(result.sections[0], "identity.raw_supply").value, HUGE);
  assert.equal(fieldById(result.sections[0], "identity.raw_supply").rawValue, HUGE);
  assert.equal(fieldById(result.sections[2], "holders.current_mint_supply_raw").value, HUGE);
  assert.equal(fieldById(result.sections[2], "holders.observed_positive_balance_raw").value, "12345678901234567890");
});

test("concentration keeps exact numerators and labels current mint supply denominator", () => {
  const concentrationEvidence = presentSolanaTokenEvidenceReport(report()).sections[2].concentration[0];
  assert.equal(concentrationEvidence.numeratorRaw, "12345678901234567890");
  assert.equal(concentrationEvidence.denominatorRaw, HUGE);
  assert.equal(concentrationEvidence.denominatorBasis, "current_mint_supply");
  assert.equal(concentrationEvidence.denominatorDescription, "Current mint supply");
  assert.equal(concentrationEvidence.percentage, "12.345678");
});

test("partial holder acquisition retains stop reason, caps, slots, and partial concentration reasons", () => {
  const input = report();
  const structure = input.holders.evidence.holderStructure;
  structure.enumeration.completeness = "partial";
  structure.concentration.top1 = { status: "unavailable", topN: 1, numeratorRaw: null, denominatorRaw: HUGE, denominatorBasis: "current_mint_supply", percentage: null, reason: "enumeration_incomplete" };
  input.holders.evidence.snapshotRecord.acquisition = { completeness: "partial", stopReason: "page_cap", configuredMaxPages: 20, requestedPageSize: 5000 };
  const result = presentSolanaTokenEvidenceReport(input).sections[2];
  assert.equal(result.completeness, "partial");
  assert.equal(result.sourceStatus.status, "present");
  assert.deepEqual(result.contextSlots, [300, 301]);
  assert.equal(result.acquisition.stopReason, "page_cap");
  assert.equal(result.concentration[0].reason, "enumeration_incomplete");
});

test("fully complete holder acquisition, enumeration, amount coverage, and distribution report complete", () => {
  const result = presentSolanaTokenEvidenceReport(report()).sections[2];
  assert.equal(result.sourceStatus.status, "present");
  assert.equal(result.acquisition.completeness, "complete");
  assert.equal(result.completeness, "complete");
});

test("partial distribution coverage keeps holder section partial despite otherwise complete evidence", () => {
  const input = report();
  input.holders.evidence.ownerAuthorityBalanceDistribution.coverage.state = "partial";
  const result = presentSolanaTokenEvidenceReport(input).sections[2];
  assert.equal(result.sourceStatus.status, "present");
  assert.equal(result.acquisition.completeness, "complete");
  assert.equal(fieldById(result, "holders.enumeration_completeness").value, "complete");
  assert.equal(fieldById(result, "holders.amount_coverage_state").value, "complete");
  assert.equal(result.completeness, "partial");
});

test("missing optional holder coverage reason remains unknown instead of available-null", () => {
  const input = report();
  input.holders.evidence.holderStructure.amountCoverage.state = "partial";
  delete input.holders.evidence.holderStructure.amountCoverage.reason;
  const result = presentSolanaTokenEvidenceReport(input).sections[2];
  const reason = fieldById(result, "holders.amount_coverage_reason");
  assert.equal(result.sourceStatus.status, "present");
  assert.equal(reason.status, "unknown");
  assert.equal(reason.value, null);
  assert.equal(reason.reason, "coverage_reason_not_reported");
});

test("quote-side market metrics remain unavailable with orientation_unsupported", () => {
  const pool = {
    poolAddress: "Pool11111111111111111111111111111111111111", dexId: "dex", counterTokenAddress: MINT,
    poolCreatedAt: missingMetric("no_market"), priceUsd: missingMetric("orientation_unsupported"),
    marketCapUsd: missingMetric("orientation_unsupported"), fdvUsd: missingMetric("orientation_unsupported"),
    liquidityUsd: rawMetric("0", "liquidity.usd"),
    volumeUsd: { m5: rawMetric("2"), h1: missingMetric(), h6: missingMetric(), h24: rawMetric("0") },
    provenance: { provider: "dexscreener", fetchedAt: FETCHED, sourceUpdatedAt: null },
  };
  const market = { ...report().market.evidence, pools: [pool], primaryPoolAddress: pool.poolAddress };
  const result = presentSolanaTokenEvidenceReport(report({ market: { status: "present", evidence: market } })).sections[1];
  assert.equal(fieldById(result.pools[0], "market.price_usd").reason, "orientation_unsupported");
  assert.equal(fieldById(result.pools[0], "market.market_cap_usd").reason, "orientation_unsupported");
  assert.equal(fieldById(result.pools[0], "market.fdv_usd").reason, "orientation_unsupported");
  assert.equal(fieldById(result.pools[0], "market.liquidity_usd").value, "0");
});

test("market fetch provenance uses provider time and does not use report assembly time", () => {
  const result = presentSolanaTokenEvidenceReport(report()).sections[1];
  const fetch = fieldById(result, "market.provider_fetch_time");
  assert.equal(fetch.value, FETCHED);
  assert.equal(fetch.provenance.observedAt, FETCHED);
  assert.notEqual(fetch.value, report().generatedAt);
});

test("fields without a supported observation timestamp do not inherit report generatedAt", () => {
  const result = presentSolanaTokenEvidenceReport(report()).sections[0];
  const supply = fieldById(result, "identity.raw_supply");
  assert.equal(supply.provenance.provider, null);
  assert.equal(supply.provenance.observedAt, null);
  assert.equal(supply.provenance.sourcePath, "report.mint.evidence.resolution.rawSupply");
});

test("base mint and freeze authority set/unset evidence is preserved without safety wording", () => {
  const result = presentSolanaTokenEvidenceReport(report()).sections[0];
  assert.equal(fieldById(result, "identity.mint_authority_status").value, "unset");
  assert.equal(fieldById(result, "identity.mint_authority_address").value, null);
  assert.equal(fieldById(result, "identity.mint_authority_address").status, "available");
  assert.equal(fieldById(result, "identity.mint_authority_address").reason, "authority_unset");
  assert.equal(fieldById(result, "identity.mint_authority_address").displayValue, "Unset");
  assert.equal(fieldById(result, "identity.freeze_authority_status").value, "set");
  assert.equal(fieldById(result, "identity.freeze_authority_address").value, AUTHORITY);
  assert.ok(result.limitations.some((value) => value.includes("do not describe Token-2022 extension authorities")));
  assert.equal(result.limitations.some((value) => /safe|unsafe|security passed/i.test(value)), false);
});

test("available non-null presentation values retain their value and status", () => {
  const result = presentSolanaTokenEvidenceReport(report());
  const decimals = fieldById(result.sections[0], "identity.decimals");
  const price = fieldById(result.sections[1], "market.pool_count");
  assert.equal(decimals.status, "available");
  assert.equal(decimals.value, 9);
  assert.equal(decimals.rawValue, 9);
  assert.equal(price.status, "available");
  assert.equal(price.value, 0);
});

test("Token-2022 extension inventory is presence-only and retains extension entries", () => {
  const input = report();
  input.mint.evidence.resolution.tokenProgram = "token-2022";
  input.mint.evidence.token2022MintExtensionInventory = { schemaVersion: "solana-token-2022-mint-extension-inventory-v1", chain: "solana", mintAddress: MINT, tokenProgram: "token-2022", status: "available", extensions: [{ extensionTypeId: 3, extensionName: "MintCloseAuthority", payloadLength: 32 }] };
  const result = presentSolanaTokenEvidenceReport(input).sections[0];
  assert.equal(result.extensions.status, "available");
  assert.deepEqual(result.extensions.entries, [{ extensionTypeId: 3, extensionName: "MintCloseAuthority", payloadLength: 32 }]);
  assert.ok(result.extensions.limitation.includes("not a complete"));
});

test("Token-2022 malformed inventory remains explicit and is not expanded", () => {
  const input = report();
  input.mint.evidence.resolution.tokenProgram = "token-2022";
  input.mint.evidence.token2022MintExtensionInventory = { schemaVersion: "solana-token-2022-mint-extension-inventory-v1", chain: "solana", mintAddress: MINT, tokenProgram: "token-2022", status: "malformed", reason: "duplicate_extension_type" };
  const result = presentSolanaTokenEvidenceReport(input).sections[0];
  assert.equal(result.extensions.status, "malformed");
  assert.deepEqual(result.extensions.entries, []);
  assert.equal(result.extensions.reason, "duplicate_extension_type");
});

test("historical presentation exposes bounded scope and never claims token-wide completeness", () => {
  const result = presentSolanaTokenEvidenceReport(report({ historicalTransactions: historyEvidence() })).sections[3];
  assert.deepEqual(result.requestedWindow, { fromUnixSecondsInclusive: 50, toUnixSecondsExclusive: 200 });
  assert.equal(fieldById(result, "historical.max_authorities").value, 1);
  assert.equal(fieldById(result, "historical.max_pages_per_authority").value, 2);
  assert.equal(fieldById(result, "historical.max_records_per_authority").value, 150);
  assert.equal(result.completeness, "partial");
  assert.ok(result.limitations.some((value) => value.includes("not token-wide or lifetime history")));
  assert.equal(result.authorities[0].terminalReason, "page_and_record_caps");
});

test("historical page metadata retains provider order/range evidence without cursor values", () => {
  const result = presentSolanaTokenEvidenceReport(report({ historicalTransactions: historyEvidence() })).sections[3];
  assert.deepEqual(result.authorities[0].pages[0], {
    pageNumber: 1, requestLimit: 100, recordCount: 2, startRecordIndex: 0, endRecordIndexExclusive: 2,
    continuationTokenUsed: false, continuationTokenReturned: true, firstUsableBlockTime: 100, lastUsableBlockTime: 90,
    minimumUsableBlockTime: 90, maximumUsableBlockTime: 100, recordsWithoutUsableBlockTime: 0,
  });
  assert.equal("paginationToken" in result.authorities[0].pages[0], false);
});

test("historical amount profile preserves exact raw evidence and unavailable amounts", () => {
  const authority = presentSolanaTokenEvidenceReport(report({ historicalTransactions: historyEvidence() })).sections[3].authorities[0];
  assert.equal(authority.acceptedObservationCount, 2);
  assert.equal(authority.amountEvidence.exactRawAmountObservationCount, 1);
  assert.equal(authority.amountEvidence.nonExactOrUnavailableAmountObservationCount, 1);
  assert.equal(authority.amountEvidence.minimumExactRawAmount, "12");
  assert.equal(authority.amountEvidence.maximumExactRawAmount, "12");
});

test("partial transaction enrichment and reconciliation conflict remain categorical", () => {
  const result = presentSolanaTokenEvidenceReport(report({ historicalTransactions: historyEvidence() })).sections[3];
  assert.equal(fieldById(result, "historical.enrichment_execution_completeness").value, "partial");
  assert.equal(fieldById(result, "historical.integration_coverage_status").value, "conflicting");
  assert.equal(result.transactions[0].integrationStatus, "integrated");
  assert.equal(result.transactions[0].reconciliationCoverage, "conflicting");
  assert.deepEqual(result.transactions[0].reconciliationReasonCodes, ["pair_reference_conflict"]);
});

test("unresolved instruction reconciliation remains an explicit limitation", () => {
  const input = report({ historicalTransactions: historyEvidence() });
  input.historicalTransactions.evidence.transactionIntegration.candidates[0].reconciliation.coverage = {
    status: "partial",
    reasonCodes: ["unresolved_instruction_reference"],
  };
  const result = presentSolanaTokenEvidenceReport(input).sections[3];
  assert.equal(result.transactions[0].reconciliationCoverage, "partial");
  assert.deepEqual(result.transactions[0].reconciliationReasonCodes, ["unresolved_instruction_reference"]);
});

test("successful empty historical authority query remains distinct from unavailable", () => {
  const input = report({ historicalTransactions: historyEvidence() });
  const history = input.historicalTransactions.evidence;
  const authority = history.execution.evidence.authorities[0];
  Object.assign(authority, { queryStatus: "success", paginationStatus: "complete", terminalReason: "natural_termination", requestCount: 1, pages: [], observations: [], providerError: null });
  Object.assign(history.descriptiveMetrics.sampleCoverage, { naturallyCompleteAuthorityCount: 1, truncatedAuthorityCount: 0 });
  const metric = (value) => ({ status: "available", value, queryCompleteness: "complete" });
  Object.assign(history.descriptiveMetrics.authorities[0], {
    queryStatus: "success", paginationStatus: "complete", acceptedObservationCount: metric(0), usableBlockTimeCount: metric(0), missingBlockTimeCount: metric(0),
    observedBlockTimeBounds: { status: "unavailable", value: null, reason: "no_usable_block_times" }, distinctSignatureCount: metric(0),
    amountEvidenceProfile: { status: "unavailable", value: null, reason: "no_usable_block_times" },
  });
  const result = presentSolanaTokenEvidenceReport(input).sections[3].authorities[0];
  assert.equal(result.queryStatus, "success");
  assert.equal(result.terminalReason, "natural_termination");
  assert.equal(result.acceptedObservationCount, 0);
  assert.equal(result.amountEvidence.status, "unavailable");
});

test("provider error after accepted historical pages preserves retained rows and error state", () => {
  const input = report({ historicalTransactions: historyEvidence() });
  const evidence = input.historicalTransactions.evidence;
  Object.assign(evidence.execution.evidence.authorities[0], {
    queryStatus: "provider_error", paginationStatus: "not_applicable", terminalReason: "provider_error",
    providerError: { category: "transport", message: "sanitized diagnostic" },
  });
  Object.assign(evidence.descriptiveMetrics.sampleCoverage, { truncatedAuthorityCount: 0, providerErrorAuthorityCount: 1 });
  const authority = presentSolanaTokenEvidenceReport(input).sections[3].authorities[0];
  assert.equal(authority.queryStatus, "provider_error");
  assert.equal(authority.terminalReason, "provider_error");
  assert.equal(authority.acceptedObservationCount, 2);
  assert.equal(authority.pages.length, 1);
  assert.equal(JSON.stringify(authority).includes("sanitized diagnostic"), false);
});

test("failed transaction execution remains visible for an integrated candidate", () => {
  const result = presentSolanaTokenEvidenceReport(report({ historicalTransactions: historyEvidence() })).sections[3];
  assert.equal(result.transactions[0].executionStatus, "failed");
  assert.equal(result.transactions[0].integrationStatus, "integrated");
  assert.deepEqual(result.transactions[0].requestProvenance, { provider: "helius", method: "getTransaction", fetchedAt: FETCHED });
});

test("candidate and transaction source indexes are retained without exposing signatures", () => {
  const result = presentSolanaTokenEvidenceReport(report({ historicalTransactions: historyEvidence() })).sections[3];
  assert.equal(result.transactions[0].candidateIndex, 0);
  assert.equal(result.transactions[0].disposition, "selected");
  assert.equal(result.transactions[0].integrationStatus, "integrated");
  assert.equal(JSON.stringify(result).includes("5".repeat(80)), false);
});

test("no qualification score, verdict, recommendation, or AI interpretation is emitted", () => {
  const result = presentSolanaTokenEvidenceReport(report());
  for (const forbidden of ["score", "rating", "recommendation", "verdict", "interpretation"]) {
    assert.equal(Object.hasOwn(result, forbidden), false);
  }
  assert.deepEqual(Object.keys(result), ["schemaVersion", "sourceReportSchemaVersion", "chain", "token", "sections"]);
});

test("operational telemetry and arbitrary nested source payloads do not leak", () => {
  const input = report({ historicalTransactions: historyEvidence() });
  input.secretSentinel = "not-allowlisted";
  const serialized = JSON.stringify(presentSolanaTokenEvidenceReport(input));
  for (const sentinel of ["must-not-appear", "omit-telemetry", "do-not-copy", "not-allowlisted", "apiKeySentinel", "secret"]) {
    assert.equal(serialized.includes(sentinel), false, `leaked ${sentinel}`);
  }
});

test("presentation makes no provider calls", () => {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("network forbidden in presentation test"); };
  try {
    const result = presentSolanaTokenEvidenceReport(report());
    assert.equal(result.sections.length, 4);
    assert.equal(calls, 0);
  } finally {
    global.fetch = previousFetch;
  }
});

test("existing report entry point output remains consumable with only injected offline dependencies", async () => {
  const reportFromService = await generateSolanaTokenEvidenceReport({ chain: "solana", assetAddress: MINT, historicalTransactions: { status: "not_requested" } }, {
    getAccount: async () => null,
    getMarkets: async () => { throw new Error("must not run after unresolved mint"); },
    getTokenAccountPages: async () => { throw new Error("must not run after unresolved mint"); },
    now: () => new Date(FETCHED),
  });
  const result = presentSolanaTokenEvidenceReport(reportFromService);
  assert.equal(result.sourceReportSchemaVersion, reportFromService.schemaVersion);
  assert.deepEqual(result.sections.map((section) => section.sourceStatus.status), ["present", "not_attempted", "not_attempted", "not_requested"]);
});

test("not-found and non-mint resolutions retain their distinct source facts", () => {
  const notFound = report({ mint: { status: "present", evidence: { resolution: { exists: false, isMint: false } } } });
  const nonMint = report({ mint: { status: "present", evidence: { resolution: { exists: true, isMint: false } } } });
  const missing = presentSolanaTokenEvidenceReport(notFound).sections[0];
  const notToken = presentSolanaTokenEvidenceReport(nonMint).sections[0];
  assert.equal(fieldById(missing, "identity.account_exists").value, false);
  assert.equal(fieldById(notToken, "identity.account_exists").value, true);
  assert.equal(fieldById(notToken, "identity.is_mint").value, false);
});

test("provider fetch and source-update provenance remain distinct", () => {
  const market = report().market.evidence;
  market.provenance.sourceUpdatedAt = "2026-10-13T14:59:00.000Z";
  const result = presentSolanaTokenEvidenceReport(report({ market: { status: "present", evidence: market } })).sections[1];
  assert.equal(fieldById(result, "market.provider_fetch_time").value, FETCHED);
  assert.equal(fieldById(result, "market.source_updated_at").value, "2026-10-13T14:59:00.000Z");
  assert.equal(fieldById(result, "market.source_updated_at").provenance.observedAt, FETCHED);
  assert.equal(fieldById(result, "market.source_updated_at").provenance.sourceUpdatedAt, "2026-10-13T14:59:00.000Z");
});

test("unavailable concentration preserves reason and null percentage instead of zero", () => {
  const input = report();
  input.holders.evidence.holderStructure.concentration.top1 = { status: "unavailable", topN: 1, numeratorRaw: null, denominatorRaw: HUGE, denominatorBasis: "current_mint_supply", percentage: null, reason: "supply_inconsistency" };
  const item = presentSolanaTokenEvidenceReport(input).sections[2].concentration[0];
  assert.equal(item.status, "unavailable");
  assert.equal(item.percentage, null);
  assert.equal(item.reason, "supply_inconsistency");
});

test("extension inventory not-applicable for classic SPL is preserved", () => {
  const result = presentSolanaTokenEvidenceReport(report()).sections[0];
  assert.equal(result.extensions.status, "not_applicable");
  assert.deepEqual(result.extensions.entries, []);
});

test("historical unqueried authority is not turned into a successful empty query", () => {
  const input = report({ historicalTransactions: historyEvidence() });
  const result = presentSolanaTokenEvidenceReport(input).sections[3];
  assert.equal(result.authorities.length, 1);
  assert.equal(fieldById(result, "historical.unqueried_authority_count").value, 1);
});

test("source provenance paths point to actual assembled report values", () => {
  const result = presentSolanaTokenEvidenceReport(report({ historicalTransactions: historyEvidence() }));
  assert.equal(fieldById(result.sections[1], "market.provider_fetch_time").provenance.sourcePath, "report.market.evidence.provenance.fetchedAt");
  assert.equal(fieldById(result.sections[2], "holders.current_mint_supply_raw").provenance.sourcePath, "report.holders.evidence.holderStructure.currentMintSupplyRaw");
  assert.equal(fieldById(result.sections[3], "historical.window_start_inclusive").provenance.sourcePath, "report.historicalTransactions.evidence.execution.evidence.provenance.requestedWindow.fromUnixSecondsInclusive");
});
