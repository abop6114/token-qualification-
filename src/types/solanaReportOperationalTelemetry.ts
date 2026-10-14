/** Operational observations are separate from token evidence and qualification assessment. */
export const SOLANA_REPORT_OPERATIONAL_TELEMETRY_SCHEMA_VERSION =
  "solana-report-operational-telemetry-v1" as const;

export type SolanaTelemetryProvider = "helius" | "dexscreener";

export type SolanaTelemetryProviderOperation =
  | "getAccountInfo"
  | "tokenPairs"
  | "getProgramAccountsV2"
  | "getTransfersByAddress"
  | "getTransaction";

export type SolanaTelemetryReportSection =
  | "mint"
  | "market"
  | "holders"
  | "historical_acquisition"
  | "transaction_enrichment";

export type SolanaTelemetryRequestOutcome =
  | "accepted"
  | "http_error"
  | "rpc_error"
  | "malformed_response"
  | "transport_error"
  | "request_timeout";

export type SolanaTelemetryApplicationStage =
  | "mint_acquisition"
  | "mint_normalization"
  | "market_acquisition"
  | "market_normalization"
  | "holder_acquisition"
  | "holder_normalization"
  | "historical_selection_and_planning"
  | "historical_page_acquisition"
  | "historical_metrics_and_transaction_selection"
  | "transaction_enrichment"
  | "phase2e_integration";

export type SolanaTelemetryStageOutcome = "completed" | "failed" | "skipped" | "not_requested";

export type SolanaTelemetryAcquisitionDisposition =
  | "complete"
  | "partial"
  | "unavailable"
  | "not_applicable"
  | "not_requested";

export type SolanaTelemetrySafeReasonCode =
  | "mint_unresolved"
  | "holder_evidence_unavailable"
  | "history_not_requested"
  | "provider_preflight_failure"
  | "provider_failure"
  | "unexpected_application_failure"
  | "dependency_not_instrumented"
  | "prerequisite_not_met"
  | "observer_failure"
  | "instrumentation_incomplete";

/** V1 deliberately reports neither provider credits nor monetary cost. */
export interface SolanaTelemetryProviderUsageUnknown {
  status: "unknown";
  reason: "provider_usage_not_observed";
}

export interface SolanaTelemetryMonetaryCostUnknown {
  status: "unknown";
  reason: "monetary_cost_not_verified";
}

interface SolanaProviderRequestObservationBase {
  /** Local fetch-invocation order, not request completion order. */
  requestSequence: number;
  section: SolanaTelemetryReportSection;
  provider: SolanaTelemetryProvider;
  operation: SolanaTelemetryProviderOperation;
  /** The instrumented adapter invoked its fetch boundary. This does not prove a real remote exchange. */
  requestAttempted: true;
  elapsedMs: number | null;
  measurementBasis: "instrumented_fetch_invocation";
  providerUsage: SolanaTelemetryProviderUsageUnknown;
}

export type SolanaProviderRequestObservation =
  | (SolanaProviderRequestObservationBase & {
      outcome: "accepted";
      responseReceived: true;
    })
  | (SolanaProviderRequestObservationBase & {
      outcome: "http_error" | "rpc_error" | "malformed_response";
      responseReceived: true;
    })
  | (SolanaProviderRequestObservationBase & {
      outcome: "transport_error";
      responseReceived: false;
    })
  | (SolanaProviderRequestObservationBase & {
      /** A timeout is not a cancellation guarantee; the response may or may not have arrived. */
      outcome: "request_timeout";
      responseReceived: boolean;
    });

export type SolanaStageRequestObservationCoverage =
  | { status: "complete" }
  | { status: "partial"; reason: "instrumentation_incomplete" }
  | { status: "dependency_only"; reason: "dependency_not_instrumented" }
  | { status: "not_attempted"; reason: "prerequisite_not_met" }
  | { status: "preflight_failed"; reason: "provider_preflight_failure" }
  | { status: "observation_failed"; reason: "observer_failure" };

/**
 * Stage observations describe application execution only. Their operational coverage
 * does not establish token-evidence completeness.
 */
export interface SolanaApplicationStageObservation {
  stage: SolanaTelemetryApplicationStage;
  section: SolanaTelemetryReportSection;
  outcome: SolanaTelemetryStageOutcome;
  reasonCode: SolanaTelemetrySafeReasonCode | null;
  elapsedMs: number | null;
  /** Non-null only for stages that acquire provider-backed evidence. */
  acquisitionDisposition: SolanaTelemetryAcquisitionDisposition | null;
  requestObservationCoverage: SolanaStageRequestObservationCoverage;
}

export interface SolanaTelemetrySectionCounts {
  attemptedRequestCount: number;
  responseReceivedCount: number;
  acceptedOperationCount: number;
  failedOperationCount: number;
  timeoutCount: number;
}

export type SolanaTelemetrySectionCountMap = Record<SolanaTelemetryReportSection, SolanaTelemetrySectionCounts>;

export interface SolanaReportOperationalTelemetryInput {
  requestObservations: readonly SolanaProviderRequestObservation[];
  stageObservations: readonly SolanaApplicationStageObservation[];
  /** Supplied by the caller; never calculated from or substituted for stage durations. */
  reportElapsedMs: number | null;
}

export type SolanaReportOperationalCoverage = "complete" | "partial" | "none";

export interface SolanaReportOperationalTelemetry {
  schemaVersion: typeof SOLANA_REPORT_OPERATIONAL_TELEMETRY_SCHEMA_VERSION;
  chain: "solana";
  requestObservations: SolanaProviderRequestObservation[];
  stageObservations: SolanaApplicationStageObservation[];
  counts: {
    attemptedRequestCount: number;
    responseReceivedCount: number;
    acceptedOperationCount: number;
    failedOperationCount: number;
    timeoutCount: number;
    bySection: SolanaTelemetrySectionCountMap;
  };
  reportElapsedMs: number | null;
  requestObservationCoverage: SolanaReportOperationalCoverage;
  providerUsage: SolanaTelemetryProviderUsageUnknown;
  monetaryCost: SolanaTelemetryMonetaryCostUnknown;
}
