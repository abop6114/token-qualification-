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
import { getSolanaProviderRequestBudgetEnvelope } from "./solanaProviderRequestBudgetEnvelope";
import {
  SolanaProviderRequestBudgetError,
  type SolanaProviderRequestBudgetController,
  type SolanaProviderRequestBudgetLease,
} from "../types/solanaProviderRequestBudget";

const ADMISSION_ERROR_MESSAGES: Record<SolanaTokenEvidenceAdmissionErrorCategory, string> = {
  admission_rejected: "The evidence request was rejected by admission policy.",
  admission_unavailable: "Evidence request admission is unavailable.",
};

const EXECUTION_ERROR_MESSAGES: Record<SolanaTokenEvidencePublicExecutionErrorCategory, string> = {
  admission_unavailable: "Evidence request admission is unavailable.",
  internal_operational_failure: "The evidence request could not be executed.",
  budget_settlement_failed: "The evidence request completed, but its provider budget could not be settled.",
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

function isBudgetController(value: unknown): value is SolanaProviderRequestBudgetController {
  return typeof value === "object" && value !== null &&
    typeof (value as { reserve?: unknown }).reserve === "function";
}

function isBudgetLease(value: unknown): value is SolanaProviderRequestBudgetLease {
  return typeof value === "object" && value !== null &&
    typeof (value as { consume?: unknown }).consume === "function" &&
    typeof (value as { settle?: unknown }).settle === "function";
}

/**
 * Parses untrusted input, requires explicit admission and a shared trusted budget
 * controller, then delegates one execution to the existing presentation service.
 * The application composition root must reuse that controller across requests;
 * this module does not create or configure one. It is not an HTTP endpoint.
 * Standalone report, presentation, and provider calls remain trusted internal
 * primitives and are not automatically budget-protected by this wrapper.
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
  const budgetControllerValue = typeof dependencyRecord === "object" && dependencyRecord !== null
    ? (dependencyRecord as { providerRequestBudgetController?: unknown }).providerRequestBudgetController
    : undefined;
  if (!isBudgetController(budgetControllerValue)) {
    throw new SolanaProviderRequestBudgetError("internal_operational_failure");
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

  let lease: SolanaProviderRequestBudgetLease;
  try {
    // Cancellation is checked after admission and immediately before reservation.
    throwIfSolanaExecutionCancelled(context);
    const reserved = budgetControllerValue.reserve(getSolanaProviderRequestBudgetEnvelope(request));
    if (!isBudgetLease(reserved)) throw new SolanaProviderRequestBudgetError("internal_operational_failure");
    lease = reserved;
  } catch (error: unknown) {
    try { await permit.release(); } catch { /* Reservation failure remains primary. */ }
    if (error instanceof SolanaExecutionCancelledError || error instanceof SolanaProviderRequestBudgetError) throw error;
    throw new SolanaTokenEvidencePublicExecutionError("internal_operational_failure");
  }

  const protectedContext: SolanaTrustedExecutionContext = {
    ...(context?.signal === undefined ? {} : { signal: context.signal }),
    dispatchCapability: {
      mode: "protected",
      authorizeFetchInvocation: () => lease.consume(),
    },
  };

  let execution: { status: "success"; presentation: SolanaTokenEvidencePresentationV1 }
    | { status: "failure"; error: unknown };
  try {
    // A trusted controller may synchronously observe cancellation while reserving.
    throwIfSolanaExecutionCancelled(protectedContext);
    const presentation = executorValue === undefined
      ? await generateSolanaTokenEvidencePresentation(request, {}, protectedContext)
      : await (executePresentation as NonNullable<typeof executePresentation>)(request, protectedContext);
    // This is the success-finalization boundary. Later cancellation during permit
    // cleanup cannot retroactively invalidate an already finalized result.
    throwIfSolanaExecutionCancelled(protectedContext);
    execution = { status: "success", presentation };
  } catch (error: unknown) {
    execution = { status: "failure", error };
  }

  let settlementFailed = false;
  let settlementFailure: unknown;
  try {
    lease.settle();
  } catch (error: unknown) {
    settlementFailed = true;
    settlementFailure = error;
  }

  let releaseFailed = false;
  try {
    await permit.release();
  } catch {
    releaseFailed = true;
  }

  if (execution.status === "failure") throw execution.error;
  if (settlementFailed) {
    if (settlementFailure instanceof SolanaProviderRequestBudgetError) throw settlementFailure;
    throw new SolanaTokenEvidencePublicExecutionError("budget_settlement_failed");
  }
  if (releaseFailed) {
    throw new SolanaTokenEvidencePublicExecutionError("permit_release_failed");
  }
  return execution.presentation;
}
