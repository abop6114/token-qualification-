import type {
  PublicRestrictionAction,
  PublicRestrictionClaimId,
  PublicRestrictionExplanationCode,
  PublicRestrictionMetricId,
} from "./publicReportComposition";

export const PUBLIC_REPORT_REVIEW_REGISTRY_SCHEMA_VERSION = "public-report-review-registry-v1" as const;
export const PUBLIC_REPORT_REVIEW_REGISTRY_RECORD_VERSION = 1 as const;

export type PublicReportReviewDisposition =
  | "case_bound_no_restrictions_confirmed"
  | "case_bound_restrictions_applied";

/** Exact allowlisted restriction data; free-text analyst observations are never interpreted. */
export interface PublicReportReviewRegistryRestriction {
  metricId: PublicRestrictionMetricId;
  claimId: PublicRestrictionClaimId;
  action: PublicRestrictionAction;
  explanationCode: PublicRestrictionExplanationCode;
}

/**
 * Application configuration linking one reviewed saved case to its review disposition.
 * This record is not an authentication credential or provider-authenticity attestation.
 */
export interface PublicReportReviewRegistryRecordV1 {
  recordId: string;
  recordVersion: typeof PUBLIC_REPORT_REVIEW_REGISTRY_RECORD_VERSION;
  caseId: string;
  chain: "solana";
  mintAddress: string;
  caseContentSha256: string;
  analystNoteSha256: string;
  disposition: PublicReportReviewDisposition;
  restrictions: readonly PublicReportReviewRegistryRestriction[];
  reviewerPseudonym: string;
  reviewedAt: string;
}

export interface PublicReportReviewRegistryV1 {
  schemaVersion: typeof PUBLIC_REPORT_REVIEW_REGISTRY_SCHEMA_VERSION;
  records: readonly PublicReportReviewRegistryRecordV1[];
}

export type PublicReportReviewResolutionErrorCode =
  | "malformed_registry"
  | "unsupported_registry_schema"
  | "duplicate_registry_record"
  | "registry_entry_missing"
  | "registry_entry_ambiguous"
  | "case_integrity_invalid"
  | "identity_mismatch"
  | "analyst_note_invalid"
  | "note_binding_mismatch"
  | "overlay_invalid"
  | "review_metadata_invalid"
  | "caller_authority_rejected"
  | "saved_case_reclassification_rejected";

export interface PublicReportReviewResolution {
  recordId: string;
  recordVersion: typeof PUBLIC_REPORT_REVIEW_REGISTRY_RECORD_VERSION;
  caseId: string;
  chain: "solana";
  mintAddress: string;
  caseContentSha256: string;
  analystNoteSha256: string;
  disposition: PublicReportReviewDisposition;
  reviewerPseudonym: string;
  reviewedAt: string;
  restrictions: readonly PublicReportReviewRegistryRestriction[];
  /** A D17-D1 overlay value when restrictions are applied; otherwise null. */
  restrictionOverlay: {
    schemaVersion: "token-analyst-restriction-overlay-v1";
    caseId: string;
    caseContentHash: string;
    analystNoteSha256: string;
    reviewerPseudonym: string;
    reviewedAt: string;
    restrictions: readonly PublicReportReviewRegistryRestriction[];
  } | null;
  /** Indicates deterministic resolution against supplied app configuration, not authentication. */
  authority: "application_configuration_source_unverified";
}

export type PublicReportReviewResolutionResult =
  | { valid: true; resolution: PublicReportReviewResolution }
  | { valid: false; error: { code: PublicReportReviewResolutionErrorCode; message: string } };

export type PublicReportReviewRegistryResolverCreationResult =
  | { valid: true; resolve: (input: unknown) => PublicReportReviewResolutionResult }
  | { valid: false; error: { code: PublicReportReviewResolutionErrorCode; message: string } };
