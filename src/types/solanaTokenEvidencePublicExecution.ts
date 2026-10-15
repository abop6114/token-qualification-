import type { SolanaTokenEvidencePresentationV1 } from "./solanaTokenEvidencePresentation";
import type { GenerateSolanaTokenEvidenceReportRequest } from "./solanaTokenEvidenceReport";
import type { SolanaTrustedExecutionContext } from "./solanaTrustedExecutionContext";
import type { SolanaProviderRequestBudgetController } from "./solanaProviderRequestBudget";

export interface SolanaTokenEvidenceAdmissionPermit {
  /** Releases the single execution permit acquired for this request. */
  release(): void | Promise<void>;
}

export interface SolanaTokenEvidenceAdmissionPolicy {
  /** Receives only the validated internal request, never the public input object. */
  acquire(
    request: GenerateSolanaTokenEvidenceReportRequest,
    context?: SolanaTrustedExecutionContext,
  ): Promise<SolanaTokenEvidenceAdmissionPermit>;
}

export interface SolanaTokenEvidencePublicExecutionDependencies {
  /** Required at runtime; no allow-all policy is supplied by the application. */
  admissionPolicy: SolanaTokenEvidenceAdmissionPolicy;
  /** Shared trusted in-process budget controller; it is never configured by public JSON. */
  providerRequestBudgetController: SolanaProviderRequestBudgetController;
  /**
   * Internal trusted seam for offline tests/composition. Any provider work it
   * performs must propagate the supplied protected context; production defaults
   * to the existing presentation service.
   */
  executePresentation?: (
    request: GenerateSolanaTokenEvidenceReportRequest,
    context?: SolanaTrustedExecutionContext,
  ) => Promise<SolanaTokenEvidencePresentationV1>;
}

/** Only cancellation is caller supplied; dispatch authorization is created after lease reservation. */
export interface SolanaTokenEvidencePublicExecutionOptions {
  signal?: AbortSignal;
}

export type SolanaTokenEvidenceAdmissionErrorCategory =
  | "admission_rejected"
  | "admission_unavailable";

export type SolanaTokenEvidencePublicExecutionErrorCategory =
  | "admission_unavailable"
  | "internal_operational_failure"
  | "budget_settlement_failed"
  | "permit_release_failed";
