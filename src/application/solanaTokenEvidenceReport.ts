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
import type { SolanaHistoricalAuthoritySelectionV2 } from "../types/solanaHistoricalAuthoritySelection";
import type { SolanaHistoricalQueryPlanV2 } from "../types/solanaHistoricalQueryPlan";
import type { SolanaHistoricalTransactionSelectionEvidence } from "../types/solanaHistoricalTransactionSelection";
import type { SolanaTransactionEvidenceIntegrationEvidence } from "../types/solanaTransactionEvidenceIntegration";
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
import { performance } from "node:perf_hooks";
import { aggregateSolanaReportOperationalTelemetry } from "./solanaReportOperationalTelemetry";
import type {
  SolanaApplicationStageObservation,
  SolanaProviderRequestObservation,
  SolanaReportOperationalTelemetry,
  SolanaTelemetryAcquisitionDisposition,
  SolanaTelemetryApplicationStage,
  SolanaTelemetryReportSection,
  SolanaTelemetrySafeReasonCode,
  SolanaTelemetryStageOutcome,
  SolanaStageRequestObservationCoverage,
} from "../types/solanaReportOperationalTelemetry";
import type { SolanaProviderRequestObservationContext, SolanaProviderRequestObservationLimitation } from "../providers/providerRequestObservation";
import { HELIUS_ACCOUNT_DEFAULT_TIMEOUT_MS } from "../providers/solana/heliusRpc";
import { DEX_SCREENER_DEFAULT_TIMEOUT_MS } from "../providers/market/dexScreener";
import { HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS } from "../providers/solana/heliusTransaction";
import { getHeliusHistoricalTransferPage } from "../providers/solana/heliusHistoricalTransferAdapter";
import { throwIfSolanaExecutionCancelled } from "../types/solanaTrustedExecutionContext";
import type { SolanaTrustedExecutionContext } from "../types/solanaTrustedExecutionContext";

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
  getAccount: (address: string, signal?: AbortSignal) => Promise<RawSolanaAccount | null>;
  getMarkets: (mintAddress: string, signal?: AbortSignal) => Promise<RawMarketPoolObservation[]>;
  getTokenAccountPages: (
    mintAddress: string,
    tokenProgram: SolanaResolvedMint["tokenProgram"],
    signal?: AbortSignal,
  ) => Promise<SolanaTokenAccountAcquisitionResult>;
  fetchHistoricalPage?: HeliusHistoricalTransferPageFetcher;
  fetchTransaction?: typeof fetch;
  now?: () => Date;
}

/** Testable seams for the additive telemetry-enabled entry point only. */
export interface SolanaTokenEvidenceReportTelemetryOptions {
  fetchImpl?: typeof fetch;
  monotonicNow?: () => number;
  /** Optional synchronous observer hook; it runs before the report-local collection. */
  observeRequest?: (observation: SolanaProviderRequestObservation) => undefined;
}

export interface SolanaTokenEvidenceReportWithTelemetry {
  report: SolanaTokenEvidenceReport;
  operationalTelemetry: SolanaReportOperationalTelemetry;
}

export class SolanaTokenEvidenceReportTelemetryError extends Error {
  constructor(readonly report: SolanaTokenEvidenceReport) {
    super("The evidence report completed, but operational telemetry could not be validated.");
    this.name = "SolanaTokenEvidenceReportTelemetryError";
  }
}

const DEFAULT_DEPENDENCIES: Pick<SolanaTokenEvidenceReportDependencies, "getAccount" | "getMarkets" | "getTokenAccountPages"> = {
  getAccount: (address) => getSolanaAccount(address),
  getMarkets: (mintAddress) => getSolanaMintMarkets(mintAddress),
  getTokenAccountPages: (mintAddress, tokenProgram) => getSolanaTokenAccountPages(mintAddress, tokenProgram),
};

const HISTORICAL_LIMITS = {
  maxSelectedAuthorities: 1,
  maxPagesPerAuthority: 2,
  maxRecordsPerAuthority: 150,
  requestTimeoutMs: 30_000,
  transactionEnrichmentTimeoutMs: 30_000,
} as const;

interface StageStart {
  stage: SolanaTelemetryApplicationStage;
  startMs: number | null;
  requestCountBefore: number;
}

class ReportTelemetryCollector {
  readonly requests: SolanaProviderRequestObservation[] = [];
  readonly stages: SolanaApplicationStageObservation[] = [];
  private sequence = 0;
  private activeStage: SolanaTelemetryApplicationStage | null = null;
  private readonly limitations = new Map<SolanaTelemetryApplicationStage, Set<SolanaProviderRequestObservationLimitation>>();
  readonly context: SolanaProviderRequestObservationContext;

  constructor(private readonly options: SolanaTokenEvidenceReportTelemetryOptions) {
    this.context = {
      allocateRequestSequence: () => {
        if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Request sequence exhausted.");
        this.sequence += 1;
        return this.sequence;
      },
      observeRequest: (observation) => {
        this.requests.push(observation);
        options.observeRequest?.({ ...observation, providerUsage: { ...observation.providerUsage } });
        return undefined;
      },
      onObservationLimitation: (reason) => {
        if (this.activeStage === null) return;
        const reasons = this.limitations.get(this.activeStage) ?? new Set<SolanaProviderRequestObservationLimitation>();
        reasons.add(reason);
        this.limitations.set(this.activeStage, reasons);
      },
      ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
    };
  }

  now(): number | null {
    try {
      const value = this.options.monotonicNow === undefined ? performance.now() : this.options.monotonicNow();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  start(stage: SolanaTelemetryApplicationStage, section: SolanaTelemetryReportSection): StageStart {
    this.activeStage = stage;
    return {
      stage,
      startMs: this.now(),
      requestCountBefore: this.requests.filter((request) => request.section === section).length,
    };
  }

  finish(
    start: StageStart,
    section: SolanaTelemetryReportSection,
    outcome: SolanaTelemetryStageOutcome,
    reasonCode: SolanaTelemetrySafeReasonCode | null,
    acquisitionDisposition: SolanaTelemetryAcquisitionDisposition | null,
    requestObservationCoverage: SolanaStageRequestObservationCoverage,
  ): void {
    const ended = this.now();
    const elapsedMs = start.startMs !== null && ended !== null && ended >= start.startMs
      ? ended - start.startMs
      : null;
    this.stages.push({
      stage: start.stage,
      section,
      outcome,
      reasonCode,
      elapsedMs,
      acquisitionDisposition,
      requestObservationCoverage,
    });
    this.activeStage = null;
  }

  requestCoverage(
    start: StageStart,
    section: SolanaTelemetryReportSection,
    builtInInstrumentedPath: boolean,
    requestExpected: boolean,
    preflightFailed = false,
  ): SolanaStageRequestObservationCoverage {
    const reasons = this.limitations.get(start.stage) ?? new Set();
    this.limitations.delete(start.stage);
    if (reasons.has("observer_delivery_failed")) return { status: "observation_failed", reason: "observer_failure" };
    if (reasons.has("sequence_allocation_failed") || reasons.has("invalid_terminal_classification")) {
      return { status: "partial", reason: "instrumentation_incomplete" };
    }
    const after = this.requests.filter((request) => request.section === section).length;
    if (!requestExpected) return { status: "not_attempted", reason: "prerequisite_not_met" };
    if (preflightFailed && builtInInstrumentedPath && after === start.requestCountBefore) {
      return { status: "preflight_failed", reason: "provider_preflight_failure" };
    }
    if (!builtInInstrumentedPath) {
      return after > start.requestCountBefore
        ? { status: "partial", reason: "instrumentation_incomplete" }
        : { status: "dependency_only", reason: "dependency_not_instrumented" };
    }
    return after > start.requestCountBefore
      ? { status: "complete" }
      : { status: "partial", reason: "instrumentation_incomplete" };
  }

  observedRequestCountSince(start: StageStart, section: SolanaTelemetryReportSection): number {
    return this.requests.filter((request) => request.section === section).length - start.requestCountBefore;
  }

  completedApplicationCoverage(): SolanaStageRequestObservationCoverage {
    return { status: "complete" };
  }

  skippedCoverage(): SolanaStageRequestObservationCoverage {
    return { status: "not_attempted", reason: "prerequisite_not_met" };
  }

  notRequestedCoverage(): SolanaStageRequestObservationCoverage {
    return { status: "not_attempted", reason: "prerequisite_not_met" };
  }

  recordNotRun(
    stage: SolanaTelemetryApplicationStage,
    section: SolanaTelemetryReportSection,
    reason: SolanaTelemetrySafeReasonCode,
    acquisitionDisposition: SolanaTelemetryAcquisitionDisposition | null = null,
    outcome: "skipped" | "not_requested" = "skipped",
  ): void {
    const start = this.start(stage, section);
    this.finish(start, section, outcome, reason, acquisitionDisposition, this.notRequestedCoverage());
  }
}

function makeMintFailureReport(
  request: GenerateSolanaTokenEvidenceReportRequest,
  now: () => Date,
  category: string,
): SolanaTokenEvidenceReport {
  return {
    schemaVersion: SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION,
    chain: "solana",
    assetAddress: request.assetAddress,
    generatedAt: now().toISOString(),
    mint: { status: "unavailable", reason: "mint_provider_unavailable", errorCategory: category },
    market: notAttempted("mint_unresolved"),
    holders: notAttempted("mint_unresolved"),
    historicalTransactions: request.historicalTransactions.status === "not_requested"
      ? { status: "not_requested" }
      : notAttempted("mint_unresolved"),
  };
}

function recordSkippedAfterMintResolution(
  collector: ReportTelemetryCollector,
  historyStatus: SolanaHistoricalReportRequest["status"],
): void {
  const historyNotRequested = historyStatus === "not_requested";
  const outcome = historyNotRequested ? "not_requested" : "skipped";
  const reason = historyNotRequested ? "history_not_requested" : "mint_unresolved";
  collector.recordNotRun("market_acquisition", "market", "mint_unresolved", "not_applicable");
  collector.recordNotRun("market_normalization", "market", "mint_unresolved");
  collector.recordNotRun("holder_acquisition", "holders", "mint_unresolved", "not_applicable");
  collector.recordNotRun("holder_normalization", "holders", "mint_unresolved");
  collector.recordNotRun("historical_selection_and_planning", "historical_acquisition", reason, null, outcome);
  collector.recordNotRun("historical_page_acquisition", "historical_acquisition", reason,
    historyNotRequested ? "not_requested" : "not_applicable", outcome);
  collector.recordNotRun("historical_metrics_and_transaction_selection", "historical_acquisition", reason, null, outcome);
  collector.recordNotRun("transaction_enrichment", "transaction_enrichment", reason,
    historyNotRequested ? "not_requested" : "not_applicable", outcome);
  collector.recordNotRun("phase2e_integration", "historical_acquisition", reason, null, outcome);
}

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
  collector?: ReportTelemetryCollector,
  telemetryOptions: SolanaTokenEvidenceReportTelemetryOptions = {},
  context?: SolanaTrustedExecutionContext,
): Promise<SolanaHistoricalReportEvidence> {
  throwIfSolanaExecutionCancelled(context);
  const planningStart = collector?.start("historical_selection_and_planning", "historical_acquisition");
  let authoritySelection: SolanaHistoricalAuthoritySelectionV2;
  let queryPlan: SolanaHistoricalQueryPlanV2;
  try {
    authoritySelection = selectSolanaHistoricalAuthoritiesV2(snapshotRecord, HISTORICAL_LIMITS.maxSelectedAuthorities);
    queryPlan = buildSolanaHistoricalQueryPlanV2({
      snapshotRecord,
      selection: authoritySelection,
      requestedWindow: request.requestedWindow,
      maxPagesPerAuthority: HISTORICAL_LIMITS.maxPagesPerAuthority,
      maxRecordsPerAuthority: HISTORICAL_LIMITS.maxRecordsPerAuthority,
    });
    if (collector && planningStart) collector.finish(planningStart, "historical_acquisition", "completed", null, null, collector.completedApplicationCoverage());
    throwIfSolanaExecutionCancelled(context);
  } catch (error: unknown) {
    if (collector && planningStart) collector.finish(planningStart, "historical_acquisition", "failed", "unexpected_application_failure", null, collector.completedApplicationCoverage());
    throw error;
  }

  const pageStart = collector?.start("historical_page_acquisition", "historical_acquisition");
  const builtInPageAdapter = dependencies.fetchHistoricalPage === undefined;
  const historicalExecution = await executeSolanaHistoricalQueryPlan(queryPlan, {
    requestTimeoutMs: HISTORICAL_LIMITS.requestTimeoutMs,
    ...(builtInPageAdapter
      ? {
          fetchPage: (input, timeoutMs, observationContext, signal) => getHeliusHistoricalTransferPage(
            input, timeoutMs, telemetryOptions.fetchImpl ?? fetch, observationContext, signal,
          ),
        }
      : {
          fetchPage: (input, timeoutMs, observationContext, signal) => dependencies.fetchHistoricalPage!(
            input, timeoutMs, observationContext, signal,
          ),
        }),
    ...(collector === undefined ? {} : { requestObservationContext: collector.context }),
    now: () => now().getTime(),
    ...(context?.signal === undefined ? {} : { signal: context.signal }),
  });
  throwIfSolanaExecutionCancelled(context);
  if (collector && pageStart) {
    const selectedCount = queryPlan.selectedAuthorityCount;
    const authorities = historicalExecution.evidence.authorities.filter((authority) => authority.queryStatus !== "not_queried");
    const hasProviderError = authorities.some((authority) => authority.queryStatus === "provider_error");
    const hasRetainedPages = authorities.some((authority) => authority.pages.length > 0);
    const allSelectedSucceeded = authorities.length === selectedCount && authorities.every((authority) => authority.queryStatus === "success");
    const truncated = authorities.some((authority) => authority.queryStatus === "success" && authority.paginationStatus === "truncated");
    const preflightFailed = authorities.some((authority) => authority.queryStatus === "provider_error" && authority.providerError?.category === "configuration");
    const disposition: SolanaTelemetryAcquisitionDisposition = selectedCount === 0
      ? "not_applicable"
      : hasProviderError && !hasRetainedPages ? "unavailable"
        : hasProviderError || truncated || !allSelectedSucceeded ? "partial" : "complete";
    const noRequestsNeeded = selectedCount === 0;
    const stageOutcome: SolanaTelemetryStageOutcome = noRequestsNeeded ? "skipped" : hasProviderError ? "failed" : "completed";
    const coverage = noRequestsNeeded
      ? collector.skippedCoverage()
      : collector.requestCoverage(pageStart, "historical_acquisition", builtInPageAdapter, true, preflightFailed);
    const reasonCode: SolanaTelemetrySafeReasonCode | null = noRequestsNeeded ? "prerequisite_not_met"
      : hasProviderError ? (coverage.status === "preflight_failed" ? "provider_preflight_failure" : "provider_failure") : null;
    collector.finish(pageStart, "historical_acquisition", stageOutcome, reasonCode, disposition, coverage);
  }

  const metricsStart = collector?.start("historical_metrics_and_transaction_selection", "historical_acquisition");
  let descriptiveMetrics: SolanaHistoricalReportEvidence["descriptiveMetrics"];
  let transactionSelection: SolanaHistoricalTransactionSelectionEvidence;
  try {
    throwIfSolanaExecutionCancelled(context);
    descriptiveMetrics = calculateSolanaHistoricalDescriptiveMetrics(queryPlan, historicalExecution.evidence);
    transactionSelection = createSolanaHistoricalTransactionSelection(queryPlan, historicalExecution.evidence);
    if (collector && metricsStart) collector.finish(metricsStart, "historical_acquisition", "completed", null, null, collector.completedApplicationCoverage());
    throwIfSolanaExecutionCancelled(context);
  } catch (error: unknown) {
    if (collector && metricsStart) collector.finish(metricsStart, "historical_acquisition", "failed", "unexpected_application_failure", null, collector.completedApplicationCoverage());
    throw error;
  }

  const transactionStart = collector?.start("transaction_enrichment", "transaction_enrichment");
  const selectedTransactions = transactionSelection.candidates.filter((candidate) => candidate.disposition.status === "selected").length;
  const transactionEnrichment = await executeSolanaTransactionEnrichment(
    transactionSelection,
    queryPlan,
    historicalExecution.evidence,
    {
      timeoutMs: HISTORICAL_LIMITS.transactionEnrichmentTimeoutMs,
      now,
      fetchImpl: dependencies.fetchTransaction ?? telemetryOptions.fetchImpl ?? fetch,
      ...(collector === undefined ? {} : { requestObservationContext: collector.context }),
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    },
  );
  throwIfSolanaExecutionCancelled(context);
  if (collector && transactionStart) {
    const telem = transactionEnrichment.telemetry;
    const requestFailures = telem.providerErrorCount + telem.requestTimeoutCount + telem.malformedResponseCount;
    const hasConfigurationFailure = transactionEnrichment.evidence.candidates.some((candidate) =>
      candidate.acquisition.status === "provider_error" && candidate.acquisition.error.category === "configuration");
    const noRequestsNeeded = selectedTransactions === 0;
    const disposition: SolanaTelemetryAcquisitionDisposition = noRequestsNeeded ? "not_applicable"
      : requestFailures === 0 ? "complete"
        : telem.normalizedTransactionCount + telem.providerNullCount > 0 ? "partial" : "unavailable";
    const stageOutcome: SolanaTelemetryStageOutcome = noRequestsNeeded ? "skipped" : requestFailures > 0 ? "failed" : "completed";
    const coverage = noRequestsNeeded
      ? collector.skippedCoverage()
      : collector.requestCoverage(transactionStart, "transaction_enrichment", true, true, hasConfigurationFailure);
    const reasonCode: SolanaTelemetrySafeReasonCode | null = noRequestsNeeded ? "prerequisite_not_met"
      : requestFailures === 0 ? null
        : coverage.status === "preflight_failed" ? "provider_preflight_failure" : "provider_failure";
    collector.finish(transactionStart, "transaction_enrichment", stageOutcome, reasonCode, disposition, coverage);
  }

  const integrationStart = collector?.start("phase2e_integration", "historical_acquisition");
  let transactionIntegration: SolanaTransactionEvidenceIntegrationEvidence;
  try {
    transactionIntegration = integrateSolanaTransactionEvidence({
      phase2A: transactionEnrichment,
      plan: queryPlan,
      historicalEvidence: historicalExecution.evidence,
    });
    if (collector && integrationStart) collector.finish(integrationStart, "historical_acquisition", "completed", null, null, collector.completedApplicationCoverage());
  } catch (error: unknown) {
    if (collector && integrationStart) collector.finish(integrationStart, "historical_acquisition", "failed", "unexpected_application_failure", null, collector.completedApplicationCoverage());
    throw error;
  }
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
async function generateSolanaTokenEvidenceReportInternal(
  request: GenerateSolanaTokenEvidenceReportRequest,
  injected: Partial<SolanaTokenEvidenceReportDependencies>,
  collector?: ReportTelemetryCollector,
  telemetryOptions: SolanaTokenEvidenceReportTelemetryOptions = {},
  context?: SolanaTrustedExecutionContext,
): Promise<SolanaTokenEvidenceReport> {
  validateRequest(request);
  throwIfSolanaExecutionCancelled(context);
  const dependencies: SolanaTokenEvidenceReportDependencies = { ...DEFAULT_DEPENDENCIES, ...injected };
  const now = dependencies.now ?? (() => new Date());

  let mint: EvidenceSection<SolanaMintReportEvidence>;
  let resolution: SolanaMintResolution;
  let mintAccount: RawSolanaAccount | null;
  const mintAcquisitionStart = collector?.start("mint_acquisition", "mint");
  try {
    throwIfSolanaExecutionCancelled(context);
    mintAccount = injected.getAccount === undefined
      ? await getSolanaAccount(request.assetAddress, telemetryOptions.fetchImpl ?? fetch, HELIUS_ACCOUNT_DEFAULT_TIMEOUT_MS, collector?.context, context?.signal)
      : await dependencies.getAccount(request.assetAddress, context?.signal);
    throwIfSolanaExecutionCancelled(context);
    if (collector && mintAcquisitionStart) {
      const coverage = collector.requestCoverage(mintAcquisitionStart, "mint", injected.getAccount === undefined, true);
      collector.finish(mintAcquisitionStart, "mint", "completed", null, "complete", coverage);
    }
  } catch (error: unknown) {
    if (collector && mintAcquisitionStart) {
      const preflight = injected.getAccount === undefined && error instanceof SolanaAccountProviderError && error.category === "configuration_error";
      const coverage = collector.requestCoverage(mintAcquisitionStart, "mint", injected.getAccount === undefined, true, preflight);
      collector.finish(mintAcquisitionStart, "mint", "failed", preflight ? "provider_preflight_failure" : "provider_failure", "unavailable", coverage);
    }
    if (!(error instanceof SolanaAccountProviderError)) throw error;
    if (collector) recordSkippedAfterMintResolution(collector, request.historicalTransactions.status);
    const report = makeMintFailureReport(request, now, error.category);
    throwIfSolanaExecutionCancelled(context);
    return report;
  }

  const mintNormalizationStart = collector?.start("mint_normalization", "mint");
  try {
    resolution = normalizeSolanaMintAccount(mintAccount);
    mint = { status: "present", evidence: mintEvidence(mintAccount, resolution) };
  } catch (error: unknown) {
    if (collector && mintNormalizationStart) collector.finish(mintNormalizationStart, "mint", "failed", "unexpected_application_failure", null, collector.completedApplicationCoverage());
    throw error;
  }

  if (collector && mintNormalizationStart) collector.finish(mintNormalizationStart, "mint", "completed", null, null, collector.completedApplicationCoverage());

  if (!resolution.exists || !resolution.isMint) {
    if (collector) recordSkippedAfterMintResolution(collector, request.historicalTransactions.status);
    const report: SolanaTokenEvidenceReport = {
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
    throwIfSolanaExecutionCancelled(context);
    return report;
  }

  let market: EvidenceSection<Awaited<ReturnType<typeof normalizeMarketSnapshot>>> = notAttempted("mint_unresolved");
  const marketAcquisitionStart = collector?.start("market_acquisition", "market");
  let marketObservations: RawMarketPoolObservation[] | undefined;
  let marketAcquired = false;
  try {
    throwIfSolanaExecutionCancelled(context);
    marketObservations = injected.getMarkets === undefined
      ? await getSolanaMintMarkets(request.assetAddress, telemetryOptions.fetchImpl ?? fetch, DEX_SCREENER_DEFAULT_TIMEOUT_MS, collector?.context, context?.signal)
      : await dependencies.getMarkets(request.assetAddress, context?.signal);
    throwIfSolanaExecutionCancelled(context);
    marketAcquired = true;
    if (collector && marketAcquisitionStart) {
      collector.finish(marketAcquisitionStart, "market", "completed", null, "complete",
        collector.requestCoverage(marketAcquisitionStart, "market", injected.getMarkets === undefined, true));
    }
  } catch (error: unknown) {
    if (collector && marketAcquisitionStart) {
      const preflight = injected.getMarkets === undefined && error instanceof DexScreenerProviderError && error.category === "configuration_error";
      collector.finish(marketAcquisitionStart, "market", "failed", preflight ? "provider_preflight_failure" : "provider_failure", "unavailable",
        collector.requestCoverage(marketAcquisitionStart, "market", injected.getMarkets === undefined, true, preflight));
    }
    if (!(error instanceof DexScreenerProviderError)) throw error;
    market = { status: "unavailable", reason: "market_provider_unavailable", errorCategory: error.category };
  }

  if (marketAcquired) {
    const marketNormalizationStart = collector?.start("market_normalization", "market");
    try {
      market = {
        status: "present",
        evidence: normalizeMarketSnapshot("solana", request.assetAddress, marketObservations as RawMarketPoolObservation[], now().toISOString()),
      };
      if (collector && marketNormalizationStart) collector.finish(marketNormalizationStart, "market", "completed", null, null, collector.completedApplicationCoverage());
    } catch (error: unknown) {
      if (collector && marketNormalizationStart) collector.finish(marketNormalizationStart, "market", "failed", "unexpected_application_failure", null, collector.completedApplicationCoverage());
      throw error;
    }
  } else if (collector) {
    collector.recordNotRun("market_normalization", "market", "prerequisite_not_met");
  }

  const holderAcquisitionStart = collector?.start("holder_acquisition", "holders");
  throwIfSolanaExecutionCancelled(context);
  const acquisition = injected.getTokenAccountPages === undefined
    ? await getSolanaTokenAccountPages(request.assetAddress, resolution.tokenProgram, telemetryOptions.fetchImpl ?? fetch, HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS, collector?.context, context?.signal)
    : await dependencies.getTokenAccountPages(request.assetAddress, resolution.tokenProgram, context?.signal);
  throwIfSolanaExecutionCancelled(context);
  if (collector && holderAcquisitionStart) {
    const unavailable = acquisition.status === "unavailable";
    const configurationFailure = unavailable && acquisition.reason === "configuration_error";
    const disposition: SolanaTelemetryAcquisitionDisposition = unavailable ? "unavailable" : acquisition.completeness;
    const coverage = collector.requestCoverage(holderAcquisitionStart, "holders", injected.getTokenAccountPages === undefined, true, configurationFailure);
    collector.finish(holderAcquisitionStart, "holders", unavailable ? "failed" : "completed",
      unavailable ? (configurationFailure && injected.getTokenAccountPages === undefined ? "provider_preflight_failure" : "provider_failure") : null,
      disposition, coverage);
  }
  let holders: EvidenceSection<SolanaHolderReportEvidence>;
  if (acquisition.status === "unavailable") {
    holders = {
      status: "unavailable",
      reason: "holder_acquisition_unavailable",
      errorCategory: acquisition.reason,
    };
  } else {
    const holderNormalizationStart = collector?.start("holder_normalization", "holders");
    try {
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
      if (collector && holderNormalizationStart) collector.finish(holderNormalizationStart, "holders", "completed", null, null, collector.completedApplicationCoverage());
    } catch (error: unknown) {
      if (collector && holderNormalizationStart) collector.finish(holderNormalizationStart, "holders", "failed", "unexpected_application_failure", null, collector.completedApplicationCoverage());
      throw error;
    }
  }
  if (acquisition.status === "unavailable" && collector) {
    collector.recordNotRun("holder_normalization", "holders", "prerequisite_not_met");
  }

  let historicalTransactions: HistoricalEvidenceSection<SolanaHistoricalReportEvidence>;
  if (request.historicalTransactions.status === "not_requested") {
    historicalTransactions = { status: "not_requested" };
    if (collector) {
      collector.recordNotRun("historical_selection_and_planning", "historical_acquisition", "history_not_requested", null, "not_requested");
      collector.recordNotRun("historical_page_acquisition", "historical_acquisition", "history_not_requested", "not_requested", "not_requested");
      collector.recordNotRun("historical_metrics_and_transaction_selection", "historical_acquisition", "history_not_requested", null, "not_requested");
      collector.recordNotRun("transaction_enrichment", "transaction_enrichment", "history_not_requested", "not_requested", "not_requested");
      collector.recordNotRun("phase2e_integration", "historical_acquisition", "history_not_requested", null, "not_requested");
    }
  } else if (holders.status !== "present") {
    historicalTransactions = { status: "not_attempted", reason: "holder_evidence_unavailable" };
    if (collector) {
      collector.recordNotRun("historical_selection_and_planning", "historical_acquisition", "holder_evidence_unavailable");
      collector.recordNotRun("historical_page_acquisition", "historical_acquisition", "holder_evidence_unavailable", "not_applicable");
      collector.recordNotRun("historical_metrics_and_transaction_selection", "historical_acquisition", "holder_evidence_unavailable");
      collector.recordNotRun("transaction_enrichment", "transaction_enrichment", "holder_evidence_unavailable", "not_applicable");
      collector.recordNotRun("phase2e_integration", "historical_acquisition", "holder_evidence_unavailable");
    }
  } else {
    throwIfSolanaExecutionCancelled(context);
    historicalTransactions = {
      status: "present",
      evidence: await generateHistoricalEvidence(request.historicalTransactions, holders.evidence.snapshotRecord, dependencies, now, collector, telemetryOptions, context),
    };
  }

  const report: SolanaTokenEvidenceReport = {
    schemaVersion: SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION,
    chain: "solana",
    assetAddress: request.assetAddress,
    generatedAt: now().toISOString(),
    mint,
    market,
    holders,
    historicalTransactions,
  };
  throwIfSolanaExecutionCancelled(context);
  return report;
}

/** Existing evidence-only API; its return shape and execution path remain unchanged. */
export async function generateSolanaTokenEvidenceReport(
  request: GenerateSolanaTokenEvidenceReportRequest,
  injected: Partial<SolanaTokenEvidenceReportDependencies> = {},
  context?: SolanaTrustedExecutionContext,
): Promise<SolanaTokenEvidenceReport> {
  return generateSolanaTokenEvidenceReportInternal(request, injected, undefined, {}, context);
}

/**
 * Runs the same evidence pipeline once and returns operational telemetry separately.
 * If aggregation rejects internally inconsistent telemetry, the completed report is
 * attached to a sanitized error rather than paired with fabricated sidecar data.
 */
export async function generateSolanaTokenEvidenceReportWithTelemetry(
  request: GenerateSolanaTokenEvidenceReportRequest,
  injected: Partial<SolanaTokenEvidenceReportDependencies> = {},
  options: SolanaTokenEvidenceReportTelemetryOptions = {},
  context?: SolanaTrustedExecutionContext,
): Promise<SolanaTokenEvidenceReportWithTelemetry> {
  validateRequest(request);
  const collector = new ReportTelemetryCollector(options);
  const startedAt = collector.now();
  const report = await generateSolanaTokenEvidenceReportInternal(request, injected, collector, options, context);
  const endedAt = collector.now();
  const reportElapsedMs = startedAt !== null && endedAt !== null && endedAt >= startedAt
    ? endedAt - startedAt
    : null;
  try {
    return {
      report,
      operationalTelemetry: aggregateSolanaReportOperationalTelemetry({
        requestObservations: collector.requests,
        stageObservations: collector.stages,
        reportElapsedMs,
      }),
    };
  } catch {
    throw new SolanaTokenEvidenceReportTelemetryError(report);
  }
}
