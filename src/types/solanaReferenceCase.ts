import type { SolanaReportOperationalTelemetry } from "./solanaReportOperationalTelemetry";
import type { SolanaTokenEvidencePublicRequest } from "./solanaTokenEvidencePublicRequest";
import type { SolanaTokenEvidenceReport } from "./solanaTokenEvidenceReport";

export const SOLANA_REFERENCE_CASE_SCHEMA_VERSION = "solana-reference-case-v1" as const;
export const SOLANA_REFERENCE_CASE_CANONICALIZATION = "tqe-canonical-json-v1" as const;

/** This is a bounded pilot, not a general batch-acquisition API. */
export const SOLANA_REFERENCE_CASE_BATCH_LIMIT = 5 as const;
export const SOLANA_REFERENCE_CASE_REQUEST_BUDGET = 22 as const;

export type SolanaReferenceCaseRunnerLimitation =
  | "history_not_requested"
  | "report_not_atomic";

/**
 * A capture-path record. It describes the application path used; it is not a
 * cryptographic attestation that a provider returned authentic live data.
 */
export interface SolanaReferenceCaseCaptureMetadata {
  startedAt: string;
  completedAt: string;
  request: SolanaTokenEvidencePublicRequest & {
    historicalTransactions: { status: "not_requested" };
  };
  executionBoundary: "protected_public_execution";
  captureOrigin: "protected_application_composition" | "synthetic_test_fixture";
  requestBudgetEnvelope: typeof SOLANA_REFERENCE_CASE_REQUEST_BUDGET;
  operationalTelemetry: SolanaReportOperationalTelemetry;
}

export interface SolanaReferenceCaseContentHash {
  algorithm: "sha256";
  canonicalization: typeof SOLANA_REFERENCE_CASE_CANONICALIZATION;
  digestHex: string;
}

/** Immutable-by-convention normalized evidence capture; runner limits are not provider facts. */
export interface SolanaReferenceCaseV1 {
  schemaVersion: typeof SOLANA_REFERENCE_CASE_SCHEMA_VERSION;
  caseId: string;
  identity: { chain: "solana"; mintAddress: string };
  capture: SolanaReferenceCaseCaptureMetadata;
  evidenceReport: SolanaTokenEvidenceReport;
  limitations: readonly SolanaReferenceCaseRunnerLimitation[];
  contentHash: SolanaReferenceCaseContentHash;
}

export interface SolanaReferenceCaseAnalystNoteV1 {
  schemaVersion: "solana-reference-case-analyst-note-v1";
  caseId: string;
  caseHash: string;
  reviewerPseudonym: string;
  reviewedAt: string;
  evidenceReferences: readonly { metricId: string | null; reportFieldPath: string }[];
  observations: readonly string[];
  uncertainties: readonly string[];
  alternativeExplanations: readonly string[];
  disagreements: readonly { topic: string; position: string; rationale: string }[];
  openQuestions: readonly string[];
}

export type SolanaReferenceCaseErrorReason =
  | "invalid_request"
  | "invalid_storage_path"
  | "invalid_case"
  | "identity_mismatch"
  | "unresolved_mint"
  | "synthetic_capture_not_accepted"
  | "integrity_mismatch"
  | "case_exists"
  | "storage_failure";

export interface SolanaReferenceCaseCaptureDependencies {
  admissionPolicy: import("./solanaTokenEvidencePublicExecution").SolanaTokenEvidenceAdmissionPolicy;
  providerRequestBudgetController: import("./solanaProviderRequestBudget").SolanaProviderRequestBudgetController;
  /** Trusted local destination. Must resolve outside the repository working tree. */
  storageDirectory: string;
  signal?: AbortSignal;
}

export interface SolanaReferenceCaseCaptureResult {
  referenceCase: SolanaReferenceCaseV1;
  filePath: string;
}

export interface SolanaReferenceCaseIntegrityResult {
  referenceCase: SolanaReferenceCaseV1;
  integrity: "valid";
  /** Integrity of JSON bytes does not independently verify real-world provenance. */
  provenance: "capture_path_claim_unverified";
}
