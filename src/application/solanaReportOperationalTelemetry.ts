import {
  SOLANA_REPORT_OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
  type SolanaApplicationStageObservation,
  type SolanaProviderRequestObservation,
  type SolanaReportOperationalCoverage,
  type SolanaReportOperationalTelemetry,
  type SolanaReportOperationalTelemetryInput,
  type SolanaTelemetryAcquisitionDisposition,
  type SolanaTelemetryApplicationStage,
  type SolanaTelemetryProvider,
  type SolanaTelemetryProviderOperation,
  type SolanaTelemetryReportSection,
  type SolanaTelemetrySafeReasonCode,
  type SolanaTelemetrySectionCountMap,
  type SolanaTelemetrySectionCounts,
  type SolanaTelemetryStageOutcome,
  type SolanaStageRequestObservationCoverage,
} from "../types/solanaReportOperationalTelemetry";

export type SolanaReportOperationalTelemetryInputErrorReason =
  | "invalid_input"
  | "invalid_request_sequence"
  | "duplicate_request_sequence"
  | "invalid_request_observation"
  | "invalid_stage_observation"
  | "duplicate_stage_observation"
  | "invalid_coverage_combination"
  | "invalid_report_duration";

/** Error messages intentionally contain only a stable code, never input or provider data. */
export class SolanaReportOperationalTelemetryInputError extends Error {
  constructor(readonly reason: SolanaReportOperationalTelemetryInputErrorReason) {
    super(`Invalid operational telemetry input (${reason}).`);
    this.name = "SolanaReportOperationalTelemetryInputError";
  }
}

const SECTIONS: readonly SolanaTelemetryReportSection[] = [
  "mint", "market", "holders", "historical_acquisition", "transaction_enrichment",
];

const STAGE_SECTION: Readonly<Record<SolanaTelemetryApplicationStage, SolanaTelemetryReportSection>> = {
  mint_acquisition: "mint",
  mint_normalization: "mint",
  market_acquisition: "market",
  market_normalization: "market",
  holder_acquisition: "holders",
  holder_normalization: "holders",
  historical_selection_and_planning: "historical_acquisition",
  historical_page_acquisition: "historical_acquisition",
  historical_metrics_and_transaction_selection: "historical_acquisition",
  transaction_enrichment: "transaction_enrichment",
  phase2e_integration: "historical_acquisition",
};

const STAGE_ORDER: readonly SolanaTelemetryApplicationStage[] = [
  "mint_acquisition", "mint_normalization", "market_acquisition", "market_normalization",
  "holder_acquisition", "holder_normalization", "historical_selection_and_planning",
  "historical_page_acquisition", "historical_metrics_and_transaction_selection",
  "transaction_enrichment", "phase2e_integration",
];

const REQUEST_STAGE: Readonly<Partial<Record<SolanaTelemetryReportSection, SolanaTelemetryApplicationStage>>> = {
  mint: "mint_acquisition",
  market: "market_acquisition",
  holders: "holder_acquisition",
  historical_acquisition: "historical_page_acquisition",
  transaction_enrichment: "transaction_enrichment",
};

const ACQUISITION_STAGES = new Set<SolanaTelemetryApplicationStage>([
  "mint_acquisition", "market_acquisition", "holder_acquisition", "historical_page_acquisition", "transaction_enrichment",
]);

const REASONS: readonly SolanaTelemetrySafeReasonCode[] = [
  "mint_unresolved", "holder_evidence_unavailable", "history_not_requested",
  "provider_preflight_failure", "provider_failure", "unexpected_application_failure",
  "dependency_not_instrumented", "prerequisite_not_met", "observer_failure", "instrumentation_incomplete",
];

const DISPOSITIONS: readonly SolanaTelemetryAcquisitionDisposition[] = [
  "complete", "partial", "unavailable", "not_applicable", "not_requested",
];

function fail(reason: SolanaReportOperationalTelemetryInputErrorReason): never {
  throw new SolanaReportOperationalTelemetryInputError(reason);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function validDuration(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function expectedProvider(operation: SolanaTelemetryProviderOperation): SolanaTelemetryProvider {
  return operation === "tokenPairs" ? "dexscreener" : "helius";
}

function expectedSection(operation: SolanaTelemetryProviderOperation): SolanaTelemetryReportSection {
  switch (operation) {
    case "getAccountInfo": return "mint";
    case "tokenPairs": return "market";
    case "getProgramAccountsV2": return "holders";
    case "getTransfersByAddress": return "historical_acquisition";
    case "getTransaction": return "transaction_enrichment";
  }
}

function isProvider(value: unknown): value is SolanaTelemetryProvider {
  return value === "helius" || value === "dexscreener";
}

function isOperation(value: unknown): value is SolanaTelemetryProviderOperation {
  return value === "getAccountInfo" || value === "tokenPairs" || value === "getProgramAccountsV2" ||
    value === "getTransfersByAddress" || value === "getTransaction";
}

function isSection(value: unknown): value is SolanaTelemetryReportSection {
  return SECTIONS.includes(value as SolanaTelemetryReportSection);
}

function isStage(value: unknown): value is SolanaTelemetryApplicationStage {
  return STAGE_ORDER.includes(value as SolanaTelemetryApplicationStage);
}

function isOutcome(value: unknown): value is SolanaTelemetryStageOutcome {
  return value === "completed" || value === "failed" || value === "skipped" || value === "not_requested";
}

function validateRequestObservation(value: unknown): asserts value is SolanaProviderRequestObservation {
  if (!isObject(value) || !exactKeys(value, [
    "requestSequence", "section", "provider", "operation", "requestAttempted", "responseReceived",
    "outcome", "elapsedMs", "measurementBasis", "providerUsage",
  ])) fail("invalid_request_observation");
  if (!Number.isSafeInteger(value.requestSequence) || (value.requestSequence as number) <= 0) {
    fail("invalid_request_sequence");
  }
  if (!isSection(value.section) || !isProvider(value.provider) || !isOperation(value.operation) ||
      value.provider !== expectedProvider(value.operation) || value.section !== expectedSection(value.operation) ||
      value.requestAttempted !== true || !validDuration(value.elapsedMs) ||
      value.measurementBasis !== "instrumented_fetch_invocation") {
    fail("invalid_request_observation");
  }
  if (!isObject(value.providerUsage) || !exactKeys(value.providerUsage, ["status", "reason"]) ||
      value.providerUsage.status !== "unknown" || value.providerUsage.reason !== "provider_usage_not_observed") {
    fail("invalid_request_observation");
  }
  const validResponseOutcome =
    (value.outcome === "accepted" && value.responseReceived === true) ||
    ((value.outcome === "http_error" || value.outcome === "rpc_error" || value.outcome === "malformed_response") && value.responseReceived === true) ||
    (value.outcome === "transport_error" && value.responseReceived === false) ||
    (value.outcome === "request_timeout" && typeof value.responseReceived === "boolean");
  if (!validResponseOutcome) fail("invalid_request_observation");
}

function validateCoverage(value: unknown): asserts value is SolanaStageRequestObservationCoverage {
  if (!isObject(value) || typeof value.status !== "string") fail("invalid_coverage_combination");
  if (value.status === "complete") {
    if (exactKeys(value, ["status"])) return;
  } else if (value.status === "partial" && value.reason === "instrumentation_incomplete") {
    if (exactKeys(value, ["status", "reason"])) return;
  } else if (value.status === "dependency_only" && value.reason === "dependency_not_instrumented") {
    if (exactKeys(value, ["status", "reason"])) return;
  } else if (value.status === "not_attempted" && value.reason === "prerequisite_not_met") {
    if (exactKeys(value, ["status", "reason"])) return;
  } else if (value.status === "preflight_failed" && value.reason === "provider_preflight_failure") {
    if (exactKeys(value, ["status", "reason"])) return;
  } else if (value.status === "observation_failed" && value.reason === "observer_failure") {
    if (exactKeys(value, ["status", "reason"])) return;
  }
  fail("invalid_coverage_combination");
}

function validateStageObservation(value: unknown): asserts value is SolanaApplicationStageObservation {
  if (!isObject(value) || !exactKeys(value, [
    "stage", "section", "outcome", "reasonCode", "elapsedMs", "acquisitionDisposition", "requestObservationCoverage",
  ])) fail("invalid_stage_observation");
  if (!isStage(value.stage) || !isSection(value.section) || value.section !== STAGE_SECTION[value.stage] ||
      !isOutcome(value.outcome) || (value.reasonCode !== null && !REASONS.includes(value.reasonCode as SolanaTelemetrySafeReasonCode)) ||
      !validDuration(value.elapsedMs)) {
    fail("invalid_stage_observation");
  }
  if (value.acquisitionDisposition !== null && !DISPOSITIONS.includes(value.acquisitionDisposition as SolanaTelemetryAcquisitionDisposition)) {
    fail("invalid_stage_observation");
  }
  if (ACQUISITION_STAGES.has(value.stage) !== (value.acquisitionDisposition !== null)) {
    fail("invalid_stage_observation");
  }
  validateCoverage(value.requestObservationCoverage);

  const coverage = value.requestObservationCoverage as SolanaStageRequestObservationCoverage;
  const stageOutcome = value.outcome as SolanaTelemetryStageOutcome;
  const reasonCode = value.reasonCode as SolanaTelemetrySafeReasonCode | null;
  if ((stageOutcome === "completed" && reasonCode !== null) || (stageOutcome === "failed" && reasonCode === null)) {
    fail("invalid_stage_observation");
  }
  if ((stageOutcome === "skipped" || stageOutcome === "not_requested") && coverage.status !== "not_attempted") {
    fail("invalid_coverage_combination");
  }
  if (coverage.status === "preflight_failed" &&
      (stageOutcome !== "failed" || reasonCode !== "provider_preflight_failure" || value.acquisitionDisposition !== "unavailable")) {
    fail("invalid_coverage_combination");
  }
  if (coverage.status === "not_attempted" && stageOutcome !== "skipped" && stageOutcome !== "not_requested") {
    fail("invalid_coverage_combination");
  }
  if (stageOutcome === "not_requested" && value.reasonCode !== "history_not_requested") {
    fail("invalid_stage_observation");
  }
  if (stageOutcome === "not_requested" && ![
    "historical_selection_and_planning", "historical_page_acquisition",
    "historical_metrics_and_transaction_selection", "transaction_enrichment", "phase2e_integration",
  ].includes(value.stage)) fail("invalid_stage_observation");
  if (value.acquisitionDisposition === "not_requested" && stageOutcome !== "not_requested") fail("invalid_stage_observation");
  if (stageOutcome === "not_requested" && ACQUISITION_STAGES.has(value.stage) && value.acquisitionDisposition !== "not_requested") {
    fail("invalid_stage_observation");
  }
  if ((stageOutcome === "skipped" || stageOutcome === "not_requested") && value.reasonCode === null) {
    fail("invalid_stage_observation");
  }
}

function cloneRequest(value: SolanaProviderRequestObservation): SolanaProviderRequestObservation {
  return { ...value, providerUsage: { ...value.providerUsage } };
}

function cloneStage(value: SolanaApplicationStageObservation): SolanaApplicationStageObservation {
  return { ...value, requestObservationCoverage: { ...value.requestObservationCoverage } };
}

function emptySectionCounts(): SolanaTelemetrySectionCounts {
  return { attemptedRequestCount: 0, responseReceivedCount: 0, acceptedOperationCount: 0, failedOperationCount: 0, timeoutCount: 0 };
}

/**
 * Validates and deterministically aggregates operational observations. Request events
 * are sorted by invocation sequence on a copy; stage events are emitted in fixed order.
 */
export function aggregateSolanaReportOperationalTelemetry(
  input: SolanaReportOperationalTelemetryInput,
): SolanaReportOperationalTelemetry {
  if (!isObject(input) || !exactKeys(input, ["requestObservations", "stageObservations", "reportElapsedMs"]) ||
      !Array.isArray(input.requestObservations) || !Array.isArray(input.stageObservations)) fail("invalid_input");
  if (!validDuration(input.reportElapsedMs)) fail("invalid_report_duration");

  const seenSequences = new Set<number>();
  const requests: SolanaProviderRequestObservation[] = [];
  for (const value of input.requestObservations as readonly unknown[]) {
    validateRequestObservation(value);
    if (seenSequences.has(value.requestSequence)) fail("duplicate_request_sequence");
    seenSequences.add(value.requestSequence);
    requests.push(cloneRequest(value));
  }
  requests.sort((left, right) => left.requestSequence - right.requestSequence);

  const seenStages = new Set<SolanaTelemetryApplicationStage>();
  const stages: SolanaApplicationStageObservation[] = [];
  for (const value of input.stageObservations as readonly unknown[]) {
    validateStageObservation(value);
    if (seenStages.has(value.stage)) fail("duplicate_stage_observation");
    seenStages.add(value.stage);
    stages.push(cloneStage(value));
  }
  stages.sort((left, right) => STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage));
  validateRequestStageConsistency(requests, stages);

  const bySection = Object.fromEntries(SECTIONS.map((section) => [section, emptySectionCounts()])) as SolanaTelemetrySectionCountMap;
  const counts = { attemptedRequestCount: 0, responseReceivedCount: 0, acceptedOperationCount: 0, failedOperationCount: 0, timeoutCount: 0 };
  for (const request of requests) {
    const section = bySection[request.section];
    counts.attemptedRequestCount += 1;
    section.attemptedRequestCount += 1;
    if (request.responseReceived) {
      counts.responseReceivedCount += 1;
      section.responseReceivedCount += 1;
    }
    if (request.outcome === "accepted") {
      counts.acceptedOperationCount += 1;
      section.acceptedOperationCount += 1;
    } else {
      counts.failedOperationCount += 1;
      section.failedOperationCount += 1;
      if (request.outcome === "request_timeout") {
        counts.timeoutCount += 1;
        section.timeoutCount += 1;
      }
    }
  }

  const coverage = deriveCoverage(requests, stages);
  return {
    schemaVersion: SOLANA_REPORT_OPERATIONAL_TELEMETRY_SCHEMA_VERSION,
    chain: "solana",
    requestObservations: requests,
    stageObservations: stages,
    counts: { ...counts, bySection },
    reportElapsedMs: input.reportElapsedMs,
    requestObservationCoverage: coverage,
    providerUsage: { status: "unknown", reason: "provider_usage_not_observed" },
    monetaryCost: { status: "unknown", reason: "monetary_cost_not_verified" },
  };
}

/** Enforces contradictions between actual request events and their acquisition stages. */
function validateRequestStageConsistency(
  requests: readonly SolanaProviderRequestObservation[],
  stages: readonly SolanaApplicationStageObservation[],
): void {
  const stageById = new Map(stages.map((stage) => [stage.stage, stage]));
  for (const [section, stageId] of Object.entries(REQUEST_STAGE) as [SolanaTelemetryReportSection, SolanaTelemetryApplicationStage][]) {
    const hasRequestEvent = requests.some((request) => request.section === section);
    const stage = stageById.get(stageId);
    if (hasRequestEvent && stage === undefined) fail("invalid_coverage_combination");
    if (stage === undefined) continue;

    if (hasRequestEvent && (
      stage.outcome === "skipped" || stage.outcome === "not_requested" ||
      stage.requestObservationCoverage.status === "not_attempted" ||
      stage.requestObservationCoverage.status === "preflight_failed"
    )) fail("invalid_coverage_combination");

    if (!hasRequestEvent && stage.outcome === "completed" && stage.requestObservationCoverage.status === "complete") {
      fail("invalid_coverage_combination");
    }
  }
}

/**
 * Missing request-capable stage coverage, dependency-only instrumentation, partial
 * observation, or observer failure prevents completeness. Explicit skips and
 * preflight failures establish no fetch occurred for that stage, but an empty event
 * list still yields `none`, never `complete`.
 */
function deriveCoverage(
  requests: readonly SolanaProviderRequestObservation[],
  stages: readonly SolanaApplicationStageObservation[],
): SolanaReportOperationalCoverage {
  const stageById = new Map(stages.map((stage) => [stage.stage, stage]));
  const applicable = Object.values(REQUEST_STAGE).filter((stage): stage is SolanaTelemetryApplicationStage => stage !== undefined);
  if (applicable.some((stageId) => !stageById.has(stageId))) return "partial";

  for (const stageId of applicable) {
    const stage = stageById.get(stageId);
    if (stage === undefined) return "partial";
    const status = stage.requestObservationCoverage.status;
    if (status === "partial" || status === "dependency_only" || status === "observation_failed") return "partial";
    const hasEvent = requests.some((request) => request.section === stage.section);
    if (stage.outcome === "completed" && status === "complete" && !hasEvent) return "partial";
    if (hasEvent && status !== "complete") return "partial";
    if (status === "complete" && (stage.outcome === "skipped" || stage.outcome === "not_requested")) return "partial";
  }
  return requests.length === 0 ? "none" : "complete";
}
