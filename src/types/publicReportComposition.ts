import type { SolanaClaimPermissionEvidence } from "./solanaClaimPermission";
import type { SolanaQualificationMetricEvidence } from "./solanaQualificationMetricEvidence";
import type { SolanaTokenEvidenceReport } from "./solanaTokenEvidenceReport";

export const PUBLIC_REPORT_COMPOSITION_INPUT_SCHEMA_VERSION = "public-report-composition-input-v1" as const;
export const PUBLIC_REPORT_SCHEMA_VERSION = "token-public-report-v1" as const;
export const PUBLIC_RESTRICTION_OVERLAY_SCHEMA_VERSION = "token-analyst-restriction-overlay-v1" as const;
export const PUBLIC_REPORT_VALIDATION_RESULT_SCHEMA_VERSION = "public-report-validation-result-v1" as const;

export type PublicEvidenceState = "available" | "partial" | "unavailable" | "not_requested" | "conflicting" | "unknown";
export type PublicVisibilityState = "summary" | "technical_details" | "withheld";
export type PublicAnalystReviewDisposition =
  | "not_applicable"
  | "case_bound_no_restrictions_confirmed"
  | "case_bound_restrictions_applied"
  | "unresolved";

/** Inputs are normalized evidence only. Review authority is deliberately a separate parameter. */
export interface PublicReportCompositionInputV1 {
  schemaVersion: typeof PUBLIC_REPORT_COMPOSITION_INPUT_SCHEMA_VERSION;
  report: SolanaTokenEvidenceReport;
  metrics: SolanaQualificationMetricEvidence;
  claims: SolanaClaimPermissionEvidence;
}

export type PublicReportSafeValue = string | number | boolean | null;

export interface PublicReportProvenance {
  /** Fixed display labels only; never a URL or endpoint. */
  source: "helius" | "dexscreener" | "on_chain" | "normalized_report" | "unknown";
  observedAt: string | null;
  sourceUpdatedAt: string | null;
}

interface PublicReportFieldBase {
  id: PublicReportFieldId;
  evidenceState: PublicEvidenceState;
  unit: "USD" | "percent" | "addresses" | "raw_token_units" | "seconds" | null;
  explanationCode: PublicFieldExplanationCode | null;
  provenance: PublicReportProvenance | null;
}

export type PublicReportField = PublicReportFieldBase & (
  | { visibility: "withheld"; value?: never }
  | { visibility: "summary" | "technical_details"; value: PublicReportSafeValue }
);

export interface PublicReportSection {
  id: PublicReportSectionId;
  evidenceState: PublicEvidenceState;
  completeness: "complete" | "partial" | "not_established" | null;
  fields: readonly PublicReportField[];
  limitationCodes: readonly PublicLimitationCode[];
}

/** Chain-neutral output envelope; chain-native detail is carried only in allowlisted fields. */
export interface PublicTokenReportV1 {
  schemaVersion: typeof PUBLIC_REPORT_SCHEMA_VERSION;
  token: { chain: string; assetId: string; name: string | null; symbol: string | null };
  generatedAt: string;
  freshness: { state: "current_observation" | "historical_observation" | "not_established"; observedAt: string | null };
  summary: readonly PublicReportField[];
  sections: readonly PublicReportSection[];
  /** A fixed code is resolved through the application's reviewed copy catalog. */
  evidenceGaps: readonly { code: PublicEvidenceGapCode }[];
  technicalDetails: readonly PublicReportField[];
  analystReview: {
    disposition: Exclude<PublicAnalystReviewDisposition, "unresolved">;
    restrictions: readonly PublicRestrictionOverlayEntry[];
  };
}

/** Aggregate/user-facing identifiers only; raw addresses, account rows and raw amounts have no slot. */
export type PublicReportFieldId =
  | "identity.chain" | "identity.asset" | "identity.name" | "identity.symbol"
  | "market.price" | "market.liquidity" | "market.volume"
  | "market.market_cap" | "market.fdv"
  | "holders.observed_address_count" | "holders.observed_balance_distribution"
  | "holders.concentration_top1" | "holders.concentration_top5" | "holders.concentration_top10" | "holders.concentration_top20"
  | "token_controls.token_program" | "token_controls.mint_authority_state" | "token_controls.freeze_authority_state"
  | "token_controls.extension_inventory_summary"
  | "historical.sampled_activity" | "historical.integration_coverage";
export type PublicReportSectionId = "identity" | "market" | "holders" | "token_controls" | "historical";
export type PublicLimitationCode =
  | "selected_pool_only" | "single_snapshot" | "partial_enumeration" | "partial_amount_coverage"
  | "not_atomic" | "owner_authorities_not_people" | "base_authority_fields_only"
  | "extension_inventory_only" | "sampled_authorities_only" | "provider_valuation_scope_unverified";
export type PublicEvidenceGapCode =
  | "source_unavailable" | "source_not_requested" | "partial_coverage" | "completeness_not_established"
  | "observation_not_atomic" | "claim_withheld" | "analyst_restriction";
export type PublicFieldExplanationCode = PublicEvidenceGapCode
  | "valuation_scope_and_denominator_unestablished"
  | "owner_authorities_are_not_wallets_or_people"
  | "token_extension_inventory_is_presence_only";

/** Enforced by the future composer: provider_reported_only is technical-details-only and excluded
 * from summary, derived comparisons, AI inputs and conclusions; suppress_value is withheld everywhere. */
export const PUBLIC_RESTRICTION_ACTION_POLICY = {
  suppress_value: { summary: false, technicalDetails: false, metadataValue: false, aiInput: false, conclusions: false },
  provider_reported_only: { summary: false, technicalDetails: true, metadataValue: false, aiInput: false, conclusions: false },
} as const satisfies Record<PublicRestrictionAction, Record<string, boolean>>;

export type PublicRestrictionAction = "suppress_value" | "provider_reported_only";
export type PublicRestrictionExplanationCode = "valuation_scope_and_denominator_unestablished";

export type PublicRestrictionMetricId =
  | "market.primary_pool.market_cap_usd"
  | "market.primary_pool.fdv_usd";
export type PublicRestrictionClaimId = "market.market_cap_usd" | "market.fdv_usd";

export interface PublicRestrictionOverlayEntry {
  metricId: PublicRestrictionMetricId;
  claimId: PublicRestrictionClaimId;
  action: PublicRestrictionAction;
  explanationCode: PublicRestrictionExplanationCode;
}

export interface PublicRestrictionOverlayV1 {
  schemaVersion: typeof PUBLIC_RESTRICTION_OVERLAY_SCHEMA_VERSION;
  caseId: string;
  caseContentHash: string;
  analystNoteSha256: string;
  reviewerPseudonym: string;
  reviewedAt: string;
  restrictions: readonly PublicRestrictionOverlayEntry[];
}

/** Caller-supplied review assertion. This type does not authenticate its source. */
export type PublicAnalystReviewAssertion =
  | { disposition: "not_applicable" }
  | { disposition: "unresolved" }
  | {
      disposition: "case_bound_no_restrictions_confirmed";
      referenceCaseArtifactJson: string;
      analystNoteJson: string;
    }
  | {
      disposition: "case_bound_restrictions_applied";
      referenceCaseArtifactJson: string;
      analystNoteJson: string;
      overlay: unknown;
    };

export type PublicReportValidationErrorCode =
  | "malformed_input"
  | "unsupported_schema"
  | "identity_mismatch"
  | "source_linkage_mismatch"
  | "metric_ledger_mismatch"
  | "claim_permission_mismatch"
  | "review_disposition_unresolved"
  | "case_binding_invalid"
  | "analyst_note_invalid"
  | "restriction_overlay_invalid"
  | "restriction_target_invalid"
  | "restriction_conflict"
  | "restriction_basis_unsupported";

export type PublicReportValidationResult =
  | {
      schemaVersion: typeof PUBLIC_REPORT_VALIDATION_RESULT_SCHEMA_VERSION;
      valid: true;
      review: {
        assertedDisposition: Exclude<PublicAnalystReviewDisposition, "unresolved">;
        authority: "unverified_assertion";
      };
      restrictionCount: number;
    }
  | {
      schemaVersion: typeof PUBLIC_REPORT_VALIDATION_RESULT_SCHEMA_VERSION;
      valid: false;
      error: { code: PublicReportValidationErrorCode; message: string };
    };
