import { executeSolanaHistoricalQueryPlan } from "../execution/solanaHistoricalQueryExecution";
import { executeSolanaTransactionEnrichment } from "../execution/solanaTransactionEnrichment";
import { integrateSolanaTransactionEvidence } from "../normalization/solanaTransactionEvidenceIntegration";
import { calculateSolanaHistoricalDescriptiveMetrics } from "../normalization/solanaHistoricalMetrics";
import { buildSolanaHistoricalQueryPlanV2 } from "../normalization/solanaHistoricalQueryPlan";
import { selectSolanaHistoricalAuthoritiesV2 } from "../normalization/solanaHistoricalAuthoritySelector";
import { createSolanaHistoricalTransactionSelection } from "../normalization/solanaHistoricalTransactionSelector";
import { normalizeMarketSnapshot } from "../normalization/marketSnapshot";
import { normalizeOwnerAuthorityBalanceDistribution } from "../normalization/ownerAuthorityBalanceDistribution";
import { normalizeSolanaHolderStructure } from "../normalization/solanaHolders";
import { normalizeSolanaMintAccount, getSolanaMintExtensionTypes, type SolanaMintResolution } from "../normalization/solanaMint";
import { normalizeSolanaToken2022MintExtensionInventory } from "../normalization/solanaToken2022MintExtensionInventory";
import { createSolanaHolderSnapshotRecordV2 } from "../normalization/solanaHolderSnapshotComparison";
import { getSolanaAccount, SolanaAccountProviderError, type RawSolanaAccount } from "../providers/solana/heliusRpc";
import { getSolanaTokenAccountPages } from "../providers/solana/heliusTokenAccounts";
import { getSolanaMintMarkets, DexScreenerProviderError } from "../providers/market/dexScreener";
import { SOLANA_TOKEN_PROGRAM_IDS } from "../types/solana";
import type { SolanaTokenAccountAcquisitionResult, SolanaHolderStructure, SolanaPartialHolderStructure } from "../types/holders";
import type { RawMarketPoolObservation } from "../types/market";
import type { SolanaHistoricalTimeWindow } from "../types/solanaHistoricalSampling";
import type { HeliusHistoricalTransferPageFetcher } from "../providers/solana/heliusHistoricalTransferAdapter";
import type {
  EvidenceSection,
  GenerateSolanaTokenEvidenceReportRequest,
  HistoricalEvidenceSection,
  SolanaHolderReportEvidence,
  SolanaHistoricalReportRequest,
  SolanaHistoricalReportEvidence,
  SolanaMintReportEvidence,
  SolanaResolvedMint,
  SolanaTokenEvidenceReport,
} from "../types/solanaTokenEvidenceReport";
import { SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION } from "../types/solanaTokenEvidenceReport";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

export type SolanaTokenEvidenceReportRequestErrorReason =
  | "invalid_chain"
  | "invalid_asset_address"
  | "invalid_request_shape"
  | "invalid_historical_window";

export class SolanaTokenEvidenceReportRequestError extends Error {
  constructor(readonly reason: SolanaTokenEvidenceReportRequestErrorReason) {
    super(reason === "invalid_chain" ? "The evidence report chain must be solana."
      : reason === "invalid_asset_address" ? "A valid Solana public-key address is required."
        : reason === "invalid_historical_window" ? "The historical time window is malformed."
          : "The evidence report request shape is malformed.");
    this.name = "SolanaTokenEvidenceReportRequestError";
  }
}

export interface SolanaTokenEvidenceReportDependencies {
  getAccount: (address: string) => Promise<RawSolanaAccount | null>;
  getMarkets: (mintAddress: string) => Promise<RawMarketPoolObservation[]>;
  getTokenAccountPages: (
    mintAddress: string,
    tokenProgram: SolanaResolvedMint["tokenProgram"],
  ) => Promise<SolanaTokenAccountAcquisitionResult>;
  fetchHistoricalPage?: HeliusHistoricalTransferPageFetcher;
  fetchTransaction?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_DEPENDENCIES: Pick<SolanaTokenEvidenceReportDependencies, "getAccount" | "getMarkets" | "getTokenAccountPages"> = {
  getAccount: getSolanaAccount,
  getMarkets: getSolanaMintMarkets,
  getTokenAccountPages: getSolanaTokenAccountPages,
};

const HISTORICAL_LIMITS = {
  maxSelectedAuthorities: 1,
  maxPagesPerAuthority: 2,
  maxRecordsPerAuthority: 150,
  requestTimeoutMs: 30_000,
  transactionEnrichmentTimeoutMs: 30_000,
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateWindow(value: unknown): asserts value is SolanaHistoricalTimeWindow {
  if (!isObject(value) || !exactKeys(value, ["fromUnixSecondsInclusive", "toUnixSecondsExclusive"]) ||
    !Number.isSafeInteger(value.fromUnixSecondsInclusive) || (value.fromUnixSecondsInclusive as number) < 0 ||
    !Number.isSafeInteger(value.toUnixSecondsExclusive) ||
    (value.toUnixSecondsExclusive as number) <= (value.fromUnixSecondsInclusive as number)) {
    throw new SolanaTokenEvidenceReportRequestError("invalid_historical_window");
  }
}

function validateRequest(value: unknown): asserts value is GenerateSolanaTokenEvidenceReportRequest {
  if (!isObject(value)) throw new SolanaTokenEvidenceReportRequestError("invalid_request_shape");
  if (value.chain !== "solana") throw new SolanaTokenEvidenceReportRequestError("invalid_chain");
  if (typeof value.assetAddress !== "string" || !isSolanaPublicKeySyntax(value.assetAddress)) {
    throw new SolanaTokenEvidenceReportRequestError("invalid_asset_address");
  }
  if (!exactKeys(value, ["chain", "assetAddress", "historicalTransactions"]) || !isObject(value.historicalTransactions)) {
    throw new SolanaTokenEvidenceReportRequestError("invalid_request_shape");
  }
  const history = value.historicalTransactions;
  if (history.status === "not_requested") {
    if (!exactKeys(history, ["status"])) throw new SolanaTokenEvidenceReportRequestError("invalid_request_shape");
    return;
  }
  if (history.status === "requested") {
    if (!exactKeys(history, ["status", "requestedWindow"])) throw new SolanaTokenEvidenceReportRequestError("invalid_request_shape");
    validateWindow(history.requestedWindow);
    return;
  }
  throw new SolanaTokenEvidenceReportRequestError("invalid_request_shape");
}

function notAttempted(reason: "mint_unresolved" | "holder_evidence_unavailable"): EvidenceSection<never> {
  return { status: "not_attempted", reason };
}

function mintEvidence(account: RawSolanaAccount | null, resolution: SolanaMintResolution): SolanaMintReportEvidence {
  if (!resolution.exists) return { resolution };
  if (!resolution.isMint) return { resolution };
  if (account === null) throw new Error("Resolved mint evidence has no source account.");
  if (account.owner !== SOLANA_TOKEN_PROGRAM_IDS[resolution.tokenProgram]) {
    throw new Error("Resolved mint provider account owner contradicts normalized mint evidence.");
  }
  return {
    resolution,
    token2022MintExtensionInventory: normalizeSolanaToken2022MintExtensionInventory({
      account,
      mint: resolution,
    }),
  };
}

async function generateHistoricalEvidence(
  request: Extract<SolanaHistoricalReportRequest, { status: "requested" }>,
  snapshotRecord: import("../types/solanaHolderSnapshot").SolanaHolderSnapshotRecordV2,
  dependencies: SolanaTokenEvidenceReportDependencies,
  now: () => Date,
): Promise<SolanaHistoricalReportEvidence> {
  const authoritySelection = selectSolanaHistoricalAuthoritiesV2(snapshotRecord, HISTORICAL_LIMITS.maxSelectedAuthorities);
  const queryPlan = buildSolanaHistoricalQueryPlanV2({
    snapshotRecord,
    selection: authoritySelection,
    requestedWindow: request.requestedWindow,
    maxPagesPerAuthority: HISTORICAL_LIMITS.maxPagesPerAuthority,
    maxRecordsPerAuthority: HISTORICAL_LIMITS.maxRecordsPerAuthority,
  });
  const historicalExecution = await executeSolanaHistoricalQueryPlan(queryPlan, {
    requestTimeoutMs: HISTORICAL_LIMITS.requestTimeoutMs,
    ...(dependencies.fetchHistoricalPage === undefined ? {} : { fetchPage: dependencies.fetchHistoricalPage }),
    now: () => now().getTime(),
  });
  const descriptiveMetrics = calculateSolanaHistoricalDescriptiveMetrics(queryPlan, historicalExecution.evidence);
  const transactionSelection = createSolanaHistoricalTransactionSelection(queryPlan, historicalExecution.evidence);
  const transactionEnrichment = await executeSolanaTransactionEnrichment(
    transactionSelection,
    queryPlan,
    historicalExecution.evidence,
    {
      timeoutMs: HISTORICAL_LIMITS.transactionEnrichmentTimeoutMs,
      now,
      ...(dependencies.fetchTransaction === undefined ? {} : { fetchImpl: dependencies.fetchTransaction }),
    },
  );
  const transactionIntegration = integrateSolanaTransactionEvidence({
    phase2A: transactionEnrichment,
    plan: queryPlan,
    historicalEvidence: historicalExecution.evidence,
  });
  return {
    authoritySelection,
    queryPlan,
    execution: { evidence: historicalExecution.evidence, telemetry: historicalExecution.telemetry },
    descriptiveMetrics,
    transactionSelection,
    transactionEnrichment,
    transactionIntegration,
  };
}

/**
 * Assembles existing Solana evidence without introducing qualification logic.
 * Provider observations are acquired at independent times and may use different slots.
 */
export async function generateSolanaTokenEvidenceReport(
  request: GenerateSolanaTokenEvidenceReportRequest,
  injected: Partial<SolanaTokenEvidenceReportDependencies> = {},
): Promise<SolanaTokenEvidenceReport> {
  validateRequest(request);
  const dependencies: SolanaTokenEvidenceReportDependencies = { ...DEFAULT_DEPENDENCIES, ...injected };
  const now = dependencies.now ?? (() => new Date());

  let mint: EvidenceSection<SolanaMintReportEvidence>;
  let resolution: SolanaMintResolution;
  let mintAccount: RawSolanaAccount | null;
  try {
    mintAccount = await dependencies.getAccount(request.assetAddress);
    resolution = normalizeSolanaMintAccount(mintAccount);
    mint = { status: "present", evidence: mintEvidence(mintAccount, resolution) };
  } catch (error: unknown) {
    if (!(error instanceof SolanaAccountProviderError)) throw error;
    return {
      schemaVersion: SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION,
      chain: "solana",
      assetAddress: request.assetAddress,
      generatedAt: now().toISOString(),
      mint: { status: "unavailable", reason: "mint_provider_unavailable", errorCategory: error.category },
      market: notAttempted("mint_unresolved"),
      holders: notAttempted("mint_unresolved"),
      historicalTransactions: request.historicalTransactions.status === "not_requested"
        ? { status: "not_requested" }
        : notAttempted("mint_unresolved"),
    };
  }

  if (!resolution.exists || !resolution.isMint) {
    return {
      schemaVersion: SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION,
      chain: "solana",
      assetAddress: request.assetAddress,
      generatedAt: now().toISOString(),
      mint,
      market: notAttempted("mint_unresolved"),
      holders: notAttempted("mint_unresolved"),
      historicalTransactions: request.historicalTransactions.status === "not_requested"
        ? { status: "not_requested" }
        : notAttempted("mint_unresolved"),
    };
  }

  let market: EvidenceSection<Awaited<ReturnType<typeof normalizeMarketSnapshot>>>;
  try {
    const observations = await dependencies.getMarkets(request.assetAddress);
    market = {
      status: "present",
      evidence: normalizeMarketSnapshot("solana", request.assetAddress, observations, now().toISOString()),
    };
  } catch (error: unknown) {
    if (!(error instanceof DexScreenerProviderError)) throw error;
    market = { status: "unavailable", reason: "market_provider_unavailable", errorCategory: error.category };
  }

  const acquisition = await dependencies.getTokenAccountPages(request.assetAddress, resolution.tokenProgram);
  let holders: EvidenceSection<SolanaHolderReportEvidence>;
  if (acquisition.status === "unavailable") {
    holders = {
      status: "unavailable",
      reason: "holder_acquisition_unavailable",
      errorCategory: acquisition.reason,
    };
  } else {
    // Resolve extension types from the already acquired mint account; no additional provider call.
    if (mintAccount === null) throw new Error("Resolved mint account became unavailable during report assembly.");
    const extensionTypes = getSolanaMintExtensionTypes(mintAccount, resolution.tokenProgram);
    const normalizedHolderStructure = normalizeSolanaHolderStructure({
      mintAddress: resolution.mintAddress,
      tokenProgram: resolution.tokenProgram,
      decimals: resolution.decimals,
      currentMintSupplyRaw: resolution.rawSupply,
      mintExtensionTypes: extensionTypes,
      acquisition,
      fetchedAt: now().toISOString(),
    });
    const distribution = normalizeOwnerAuthorityBalanceDistribution({
      chain: normalizedHolderStructure.chain,
      assetAddress: normalizedHolderStructure.mintAddress,
      snapshotAt: normalizedHolderStructure.fetchedAt,
      decimals: normalizedHolderStructure.decimals,
      currentSupplyRaw: normalizedHolderStructure.currentMintSupplyRaw,
      enumeration: normalizedHolderStructure.enumeration,
      amountCoverage: normalizedHolderStructure.amountCoverage,
      rawOwnerCount: normalizedHolderStructure.rawOwnerCount,
      rawOwnerAuthorities: normalizedHolderStructure.rawOwnerAuthorities,
    });
    const snapshotRecord = acquisition.completeness === "complete"
      ? createSolanaHolderSnapshotRecordV2(normalizedHolderStructure as SolanaHolderStructure, {
          completeness: acquisition.completeness,
          stopReason: acquisition.stopReason,
          configuredMaxPages: acquisition.configuredMaxPages,
          requestedPageSize: acquisition.requestedPageSize,
        })
      : createSolanaHolderSnapshotRecordV2(normalizedHolderStructure as SolanaPartialHolderStructure);
    holders = { status: "present", evidence: {
      holderStructure: normalizedHolderStructure,
      ownerAuthorityBalanceDistribution: distribution,
      snapshotRecord,
    } };
  }

  let historicalTransactions: HistoricalEvidenceSection<SolanaHistoricalReportEvidence>;
  if (request.historicalTransactions.status === "not_requested") {
    historicalTransactions = { status: "not_requested" };
  } else if (holders.status !== "present") {
    historicalTransactions = { status: "not_attempted", reason: "holder_evidence_unavailable" };
  } else {
    historicalTransactions = {
      status: "present",
      evidence: await generateHistoricalEvidence(request.historicalTransactions, holders.evidence.snapshotRecord, dependencies, now),
    };
  }

  return {
    schemaVersion: SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION,
    chain: "solana",
    assetAddress: request.assetAddress,
    generatedAt: now().toISOString(),
    mint,
    market,
    holders,
    historicalTransactions,
  };
}
