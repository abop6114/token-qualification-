import type { SolanaTokenEvidencePresentationV1 } from "./solanaTokenEvidencePresentation";
import type { GenerateSolanaTokenEvidenceReportRequest } from "./solanaTokenEvidenceReport";

export interface SolanaTokenEvidenceAdmissionPermit {
  /** Releases the single execution permit acquired for this request. */
  release(): void | Promise<void>;
}

export interface SolanaTokenEvidenceAdmissionPolicy {
  /** Receives only the validated internal request, never the public input object. */
  acquire(
    request: GenerateSolanaTokenEvidenceReportRequest,
  ): Promise<SolanaTokenEvidenceAdmissionPermit>;
}

export interface SolanaTokenEvidencePublicExecutionDependencies {
  /** Required at runtime; no allow-all policy is supplied by the application. */
  admissionPolicy: SolanaTokenEvidenceAdmissionPolicy;
  /** Internal offline-test seam. Production defaults to the existing composition service. */
  executePresentation?: (
    request: GenerateSolanaTokenEvidenceReportRequest,
  ) => Promise<SolanaTokenEvidencePresentationV1>;
}

export type SolanaTokenEvidenceAdmissionErrorCategory =
  | "admission_rejected"
  | "admission_unavailable";

export type SolanaTokenEvidencePublicExecutionErrorCategory =
  | "admission_unavailable"
  | "internal_operational_failure"
  | "permit_release_failed";
