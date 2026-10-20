import { composeSolanaPublicReport } from "./solanaPublicReportComposer";
import { resolveSolanaLiveEvidenceForPublicReport } from "./solanaPublicReportCompositionService";
import type { SolanaValidatedPublicReportContextHandle } from "./solanaPublicReportCompositionService";
import type { PublicTokenReportV1 } from "../types/publicReportComposition";
import type { SolanaTokenEvidenceAdmissionPolicy, SolanaTokenEvidencePublicExecutionDependencies } from "../types/solanaTokenEvidencePublicExecution";
import type { SolanaProviderRequestBudgetController } from "../types/solanaProviderRequestBudget";
import { SolanaProviderRequestBudgetError } from "../types/solanaProviderRequestBudget";
import { SolanaTokenEvidenceAdmissionError, SolanaTokenEvidencePublicExecutionError } from "./solanaTokenEvidencePublicExecution";
import { SolanaTokenEvidenceAdmissionControllerRejectionError } from "./solanaTokenEvidenceAdmissionController";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

export const SOLANA_LIVE_PUBLIC_REPORT_DEADLINE_MS = 60_000 as const;
export type SolanaLivePublicReportErrorCode = "invalid_request" | "admission_rejected" | "budget_exhausted" | "deadline_exceeded" | "cancelled" | "evidence_unavailable" | "report_unavailable";
export type SolanaLivePublicReportResult =
  | { readonly valid: true; readonly report: PublicTokenReportV1 }
  | { readonly valid: false; readonly error: { readonly code: SolanaLivePublicReportErrorCode; readonly message: string } };

const MESSAGES: Record<SolanaLivePublicReportErrorCode, string> = {
  invalid_request: "Provide a valid Solana chain and token address.",
  admission_rejected: "Another analysis is active or analysis is unavailable.",
  budget_exhausted: "The local provider-request allowance is exhausted.",
  deadline_exceeded: "The analysis exceeded its time limit. No completed report was returned.",
  cancelled: "The analysis was cancelled. No completed report was returned.",
  evidence_unavailable: "The requested address could not be verified as a Solana token mint.",
  report_unavailable: "A report could not be prepared from the available evidence.",
};
function failure(code: SolanaLivePublicReportErrorCode): SolanaLivePublicReportResult {
  return { valid: false, error: { code, message: MESSAGES[code] } };
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function validateRequest(input: unknown): asserts input is { chain: "solana"; assetAddress: string } {
  if (!isPlainRecord(input)) throw new Error("invalid");
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes("chain") || !keys.includes("assetAddress")
    || keys.some((key) => typeof key !== "string" || !Object.getOwnPropertyDescriptor(input, key)?.enumerable
      || !("value" in (Object.getOwnPropertyDescriptor(input, key) ?? {})))) throw new Error("invalid");
  if (input.chain !== "solana" || typeof input.assetAddress !== "string" || !isSolanaPublicKeySyntax(input.assetAddress)) throw new Error("invalid");
}

/** The route's trusted composition-root dependencies; never populated from request JSON. */
export interface SolanaLivePublicReportDependencies {
  readonly admissionPolicy: SolanaTokenEvidenceAdmissionPolicy;
  readonly providerRequestBudgetController: SolanaProviderRequestBudgetController;
  readonly fetchImpl?: typeof fetch;
}

/** Runs one live request through the existing protected dispatch and returns only the safe report. */
export async function generateSolanaLivePublicReport(
  input: unknown,
  dependencies: SolanaLivePublicReportDependencies,
  callerSignal?: AbortSignal,
): Promise<SolanaLivePublicReportResult> {
  try { validateRequest(input); } catch { return failure("invalid_request"); }
  if (callerSignal?.aborted) return failure("cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SOLANA_LIVE_PUBLIC_REPORT_DEADLINE_MS);
  try {
    const protectedDependencies: SolanaTokenEvidencePublicExecutionDependencies = {
      admissionPolicy: dependencies.admissionPolicy,
      providerRequestBudgetController: dependencies.providerRequestBudgetController,
    };
    const resolved = await resolveSolanaLiveEvidenceForPublicReport(input.assetAddress, protectedDependencies, {
      signal: controller.signal,
      telemetryOptions: dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : undefined,
    });
    if (timedOut) return failure("deadline_exceeded");
    if (controller.signal.aborted) return failure("cancelled");
    if (!resolved.valid) {
      if (resolved.error.code === "live_mint_unverified") return failure("evidence_unavailable");
      if (resolved.error.code === "live_budget_rejected") return failure("budget_exhausted");
      if (resolved.error.code === "live_admission_rejected") return failure("admission_rejected");
      if (resolved.error.code === "live_execution_cancelled") return failure(callerSignal?.aborted ? "cancelled" : "deadline_exceeded");
      return failure("report_unavailable");
    }
    const handle: SolanaValidatedPublicReportContextHandle = resolved.context;
    const composed = composeSolanaPublicReport(handle);
    if (timedOut) return failure("deadline_exceeded");
    if (controller.signal.aborted) return failure("cancelled");
    return composed.valid ? { valid: true, report: composed.report } : failure("report_unavailable");
  } catch (error: unknown) {
    if (timedOut) return failure("deadline_exceeded");
    if (callerSignal?.aborted) return failure("cancelled");
    if (error instanceof SolanaProviderRequestBudgetError) {
      return error.reason === "insufficient_allowance" || error.reason === "controller_disabled" ? failure("budget_exhausted") : failure("report_unavailable");
    }
    if (error instanceof SolanaTokenEvidenceAdmissionControllerRejectionError || error instanceof SolanaTokenEvidenceAdmissionError) return failure("admission_rejected");
    if (error instanceof SolanaTokenEvidencePublicExecutionError) return failure("report_unavailable");
    return failure("report_unavailable");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
