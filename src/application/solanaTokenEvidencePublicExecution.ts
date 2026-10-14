import { parseSolanaTokenEvidencePublicRequest } from "./solanaTokenEvidencePublicRequest";
import { generateSolanaTokenEvidencePresentation } from "./solanaTokenEvidencePresentationService";
import type {
  SolanaTokenEvidenceAdmissionErrorCategory,
  SolanaTokenEvidencePublicExecutionErrorCategory,
  SolanaTokenEvidencePublicExecutionDependencies,
  SolanaTokenEvidenceAdmissionPermit,
} from "../types/solanaTokenEvidencePublicExecution";
import type { GenerateSolanaTokenEvidenceReportRequest } from "../types/solanaTokenEvidenceReport";
import type { SolanaTokenEvidencePresentationV1 } from "../types/solanaTokenEvidencePresentation";
import { SolanaExecutionCancelledError, throwIfSolanaExecutionCancelled } from "../types/solanaTrustedExecutionContext";
import type { SolanaTrustedExecutionContext } from "../types/solanaTrustedExecutionContext";
import type { SolanaTokenEvidencePublicExecutionOptions } from "../types/solanaTokenEvidencePublicExecution";

const ADMISSION_ERROR_MESSAGES: Record<SolanaTokenEvidenceAdmissionErrorCategory, string> = {
  admission_rejected: "The evidence request was rejected by admission policy.",
  admission_unavailable: "Evidence request admission is unavailable.",
};

const EXECUTION_ERROR_MESSAGES: Record<SolanaTokenEvidencePublicExecutionErrorCategory, string> = {
  admission_unavailable: "Evidence request admission is unavailable.",
  internal_operational_failure: "The evidence request could not be executed.",
  permit_release_failed: "The evidence execution completed, but its admission permit could not be released.",
};

/** Stable, transport-neutral errors a concrete admission policy may deliberately return. */
export class SolanaTokenEvidenceAdmissionError extends Error {
  constructor(readonly category: SolanaTokenEvidenceAdmissionErrorCategory) {
    super(ADMISSION_ERROR_MESSAGES[category]);
    this.name = "SolanaTokenEvidenceAdmissionError";
  }
}

/** Sanitized execution-boundary error for admission configuration and operational failures. */
export class SolanaTokenEvidencePublicExecutionError extends Error {
  constructor(readonly category: SolanaTokenEvidencePublicExecutionErrorCategory) {
    super(EXECUTION_ERROR_MESSAGES[category]);
    this.name = "SolanaTokenEvidencePublicExecutionError";
  }
}

function copyValidatedRequest(
  request: GenerateSolanaTokenEvidenceReportRequest,
): GenerateSolanaTokenEvidenceReportRequest {
  return request.historicalTransactions.status === "not_requested"
    ? {
        chain: request.chain,
        assetAddress: request.assetAddress,
        historicalTransactions: { status: "not_requested" },
      }
    : {
        chain: request.chain,
        assetAddress: request.assetAddress,
        historicalTransactions: {
          status: "requested",
          requestedWindow: {
            fromUnixSecondsInclusive: request.historicalTransactions.requestedWindow.fromUnixSecondsInclusive,
            toUnixSecondsExclusive: request.historicalTransactions.requestedWindow.toUnixSecondsExclusive,
          },
        },
      };
}

function isAdmissionPolicy(value: unknown): value is SolanaTokenEvidencePublicExecutionDependencies["admissionPolicy"] {
  return typeof value === "object" && value !== null &&
    typeof (value as { acquire?: unknown }).acquire === "function";
}

/**
 * Parses untrusted input, requires explicit admission, then delegates one execution
 * to the existing presentation service. It is not an HTTP endpoint or admission controller.
 */
export async function executeSolanaTokenEvidencePublicRequest(
  input: unknown,
  dependencies: SolanaTokenEvidencePublicExecutionDependencies,
  options: SolanaTokenEvidencePublicExecutionOptions = {},
): Promise<SolanaTokenEvidencePresentationV1> {
  const request = parseSolanaTokenEvidencePublicRequest(input);
  const context: SolanaTrustedExecutionContext | undefined = options.signal === undefined
    ? undefined
    : { signal: options.signal };
  throwIfSolanaExecutionCancelled(context);

  const dependencyRecord: unknown = dependencies;
  const policyValue = typeof dependencyRecord === "object" && dependencyRecord !== null
    ? (dependencyRecord as { admissionPolicy?: unknown }).admissionPolicy
    : undefined;
  if (!isAdmissionPolicy(policyValue)) {
    throw new SolanaTokenEvidenceAdmissionError("admission_unavailable");
  }

  const executorValue = typeof dependencyRecord === "object" && dependencyRecord !== null
    ? (dependencyRecord as { executePresentation?: unknown }).executePresentation
    : undefined;
  if (executorValue !== undefined && typeof executorValue !== "function") {
    throw new SolanaTokenEvidencePublicExecutionError("internal_operational_failure");
  }
  const executePresentation = executorValue === undefined
    ? generateSolanaTokenEvidencePresentation
    : executorValue as SolanaTokenEvidencePublicExecutionDependencies["executePresentation"];
  if (executePresentation === undefined) {
    throw new SolanaTokenEvidencePublicExecutionError("internal_operational_failure");
  }

  let permit: SolanaTokenEvidenceAdmissionPermit;
  try {
    permit = await policyValue.acquire(copyValidatedRequest(request), context);
  } catch (error: unknown) {
    if (error instanceof SolanaExecutionCancelledError) throw error;
    if (error instanceof SolanaTokenEvidenceAdmissionError) throw error;
    // Cancellation is causal only when the admission dependency rejects with the
    // trusted signal's reason; an unrelated failure can race a later abort.
    if (context?.signal?.aborted && error === context.signal.reason) throw new SolanaExecutionCancelledError();
    throw new SolanaTokenEvidencePublicExecutionError("internal_operational_failure");
  }
  if (typeof permit !== "object" || permit === null || typeof permit.release !== "function") {
    throw new SolanaTokenEvidencePublicExecutionError("internal_operational_failure");
  }

  if (context?.signal?.aborted) {
    try { await permit.release(); } catch { /* Keep cancellation as the primary outcome. */ }
    throw new SolanaExecutionCancelledError();
  }

  let execution: { status: "success"; presentation: SolanaTokenEvidencePresentationV1 }
    | { status: "failure"; error: unknown };
  try {
    const presentation = executorValue === undefined
      ? await generateSolanaTokenEvidencePresentation(request, {}, context)
      : await (executePresentation as NonNullable<typeof executePresentation>)(request, context);
    // This is the success-finalization boundary. Later cancellation during permit
    // cleanup cannot retroactively invalidate an already finalized result.
    throwIfSolanaExecutionCancelled(context);
    execution = { status: "success", presentation };
  } catch (error: unknown) {
    execution = { status: "failure", error };
  }

  let releaseFailed = false;
  try {
    await permit.release();
  } catch {
    releaseFailed = true;
  }

  if (execution.status === "failure") throw execution.error;
  if (releaseFailed) {
    throw new SolanaTokenEvidencePublicExecutionError("permit_release_failed");
  }
  return execution.presentation;
}
