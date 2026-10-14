import type {
  SolanaProviderRequestObservation,
  SolanaTelemetryProvider,
  SolanaTelemetryProviderOperation,
  SolanaTelemetryReportSection,
  SolanaTelemetryRequestOutcome,
} from "../types/solanaReportOperationalTelemetry";

export type SolanaProviderRequestObservationLimitation =
  | "sequence_allocation_failed"
  | "timing_unavailable"
  | "observer_delivery_failed"
  | "invalid_terminal_classification";

/**
 * Report-local synchronous observation hooks. The allocator and observer are
 * intentionally required together; providers never create report-global sequence state.
 */
export interface SolanaProviderRequestObservationContext {
  allocateRequestSequence: () => number;
  /** Must complete synchronously and return undefined. */
  observeRequest: (observation: SolanaProviderRequestObservation) => undefined;
  onObservationLimitation: (reason: SolanaProviderRequestObservationLimitation) => void;
  /** Monotonic milliseconds. Defaults to performance.now(). */
  monotonicNow?: () => number;
}

export interface SolanaProviderRequestIdentity {
  section: SolanaTelemetryReportSection;
  provider: SolanaTelemetryProvider;
  operation: SolanaTelemetryProviderOperation;
}

type ErrorOutcomeClassifier = (error: unknown, responseReceived: boolean) => SolanaTelemetryRequestOutcome;

function isContext(value: unknown): value is SolanaProviderRequestObservationContext {
  if (typeof value !== "object" || value === null) return false;
  try {
    const candidate = value as SolanaProviderRequestObservationContext;
    return typeof candidate.allocateRequestSequence === "function" &&
      typeof candidate.observeRequest === "function" &&
      typeof candidate.onObservationLimitation === "function" &&
      (candidate.monotonicNow === undefined || typeof candidate.monotonicNow === "function");
  } catch {
    return false;
  }
}

function notifyLimitation(
  context: unknown,
  reason: SolanaProviderRequestObservationLimitation,
): void {
  if (typeof context !== "object" || context === null) return;
  try {
    const callback = (context as Partial<SolanaProviderRequestObservationContext>).onObservationLimitation;
    if (typeof callback === "function") callback.call(context, reason);
  } catch {
    // Instrumentation diagnostics must never affect provider behavior.
  }
}

function safeClock(context: SolanaProviderRequestObservationContext): number | null {
  try {
    const value = context.monotonicNow === undefined ? performance.now() : context.monotonicNow();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  } catch {
    // The observation remains useful with an explicitly unavailable duration.
  }
  notifyLimitation(context, "timing_unavailable");
  return null;
}

function isOutcome(value: unknown): value is SolanaTelemetryRequestOutcome {
  return value === "accepted" || value === "http_error" || value === "rpc_error" ||
    value === "malformed_response" || value === "transport_error" || value === "request_timeout";
}

function outcomeMatchesResponse(outcome: SolanaTelemetryRequestOutcome, responseReceived: boolean): boolean {
  if (outcome === "accepted" || outcome === "http_error" || outcome === "rpc_error" || outcome === "malformed_response") {
    return responseReceived;
  }
  if (outcome === "transport_error") return !responseReceived;
  return outcome === "request_timeout";
}

/**
 * Instruments exactly one adapter fetch invocation and its provider-response handling.
 * It never changes the result/error path. The observer is synchronous and is called once.
 */
export async function observeProviderRequest<T>(
  context: SolanaProviderRequestObservationContext | undefined,
  identity: SolanaProviderRequestIdentity,
  invokeFetch: () => Promise<Response>,
  handleResponse: (response: Response) => Promise<T>,
  classifyError: ErrorOutcomeClassifier,
): Promise<T> {
  let sequence: number | null = null;
  let startedAt: number | null = null;
  if (context !== undefined) {
    if (!isContext(context)) {
      notifyLimitation(context, "sequence_allocation_failed");
    } else {
      startedAt = safeClock(context);
      try {
        const allocated = context.allocateRequestSequence();
        if (Number.isSafeInteger(allocated) && allocated > 0) sequence = allocated;
        else notifyLimitation(context, "sequence_allocation_failed");
      } catch {
        notifyLimitation(context, "sequence_allocation_failed");
      }
    }
  }

  let responseReceived = false;
  const terminalOutcome: { value: SolanaTelemetryRequestOutcome | null } = { value: null };
  try {
    // No provider work is performed between sequence allocation and this invocation.
    const response = await invokeFetch();
    responseReceived = true;
    const result = await handleResponse(response);
    terminalOutcome.value = "accepted";
    return result;
  } catch (error: unknown) {
    if (context !== undefined && isContext(context) && sequence !== null) {
      try {
        const classified = classifyError(error, responseReceived);
        if (isOutcome(classified) && outcomeMatchesResponse(classified, responseReceived)) terminalOutcome.value = classified;
        else notifyLimitation(context, "invalid_terminal_classification");
      } catch {
        notifyLimitation(context, "invalid_terminal_classification");
      }
    }
    throw error;
  } finally {
    const finalOutcome = terminalOutcome.value as SolanaTelemetryRequestOutcome | null;
    if (context !== undefined && isContext(context) && sequence !== null && finalOutcome !== null) {
      const endedAt = safeClock(context);
      let elapsedMs: number | null = null;
      if (startedAt !== null && endedAt !== null && endedAt >= startedAt) elapsedMs = endedAt - startedAt;
      else if (startedAt !== null && endedAt !== null) notifyLimitation(context, "timing_unavailable");

      const base = {
        requestSequence: sequence,
        ...identity,
        requestAttempted: true as const,
        elapsedMs,
        measurementBasis: "instrumented_fetch_invocation" as const,
        providerUsage: { status: "unknown" as const, reason: "provider_usage_not_observed" as const },
      };
      let observation: SolanaProviderRequestObservation | null = null;
      if (finalOutcome === "request_timeout") {
        observation = { ...base, responseReceived, outcome: "request_timeout" };
      } else if (responseReceived && finalOutcome === "accepted") {
        observation = { ...base, responseReceived: true, outcome: "accepted" };
      } else if (responseReceived && (
        finalOutcome === "http_error" || finalOutcome === "rpc_error" || finalOutcome === "malformed_response"
      )) {
        observation = { ...base, responseReceived: true, outcome: finalOutcome };
      } else if (!responseReceived && finalOutcome === "transport_error") {
        observation = { ...base, responseReceived: false, outcome: "transport_error" };
      }
      if (observation === null) {
        notifyLimitation(context, "invalid_terminal_classification");
      } else {
        try {
          const delivery: unknown = context.observeRequest(observation);
          if (delivery !== undefined) {
            // Do not await/retry observers. Consume a rejected thenable to avoid an
            // unhandled rejection while reporting that the synchronous contract failed.
            if (typeof delivery === "object" && delivery !== null && "then" in delivery) {
              void Promise.resolve(delivery).catch(() => undefined);
            }
            notifyLimitation(context, "observer_delivery_failed");
          }
        } catch {
          notifyLimitation(context, "observer_delivery_failed");
        }
      }
    }
  }
}
