import type {
  SolanaAddressRoleId,
  SolanaAddressRoleEvidence,
  SolanaBaseAuthorityAddressRoleFinding,
  SolanaDexPoolAddressRoleFinding,
} from "./solanaAddressRoleEvidence";
import type { SolanaHolderStructure } from "./holders";
import type { SolanaHolderSnapshotAcquisitionV2, SolanaHolderSnapshotRecordV2 } from "./solanaHolderSnapshot";
import type { SolanaAddressRoleEvidenceV2 } from "./solanaAddressRoleEvidence";

export type SolanaExclusionDecision = "exclude" | "retain" | "unresolved";
export type SolanaExclusionEvidenceSufficiency = "sufficient" | "insufficient" | "conflicting";

export type SolanaExclusionReasonCode =
  | "no_supported_exclusion_rule_matched"
  | "matched_role_requires_more_evidence"
  | "market_evidence_unavailable"
  | "market_evidence_malformed_or_incomplete"
  | "conflicting_market_evidence";

type RuleOutcome = {
  /** Sufficiency to apply this versioned exclusion rule, not overall TQE confidence. */
  decision: SolanaExclusionDecision;
  evidenceSufficiency: SolanaExclusionEvidenceSufficiency;
  reasonCode: SolanaExclusionReasonCode;
};

export type SolanaAuthorityExclusionRuleAssessment = RuleOutcome & {
  ruleId: "base_mint_authority_address" | "base_freeze_authority_address";
  finding: SolanaBaseAuthorityAddressRoleFinding;
};

export type SolanaDexPoolExclusionRuleAssessment = RuleOutcome & {
  ruleId: "dexscreener_reported_pool_address";
  finding: SolanaDexPoolAddressRoleFinding;
};

export interface SolanaHolderExclusionSubjectAssessment {
  subjectType: "positive_owner_authority";
  subjectAddress: string;
  /** Copied unchanged from the raw holder structure for later audit/reconciliation. */
  balanceRaw: string;
  /** Retain means only that this policy did not exclude the subject; it is not an ordinary-holder label. */
  decision: SolanaExclusionDecision;
  /** Fixed order: mint authority, freeze authority, DEX Screener pool address. */
  ruleAssessments: [
    SolanaAuthorityExclusionRuleAssessment,
    SolanaAuthorityExclusionRuleAssessment,
    SolanaDexPoolExclusionRuleAssessment,
  ];
}

export interface SolanaHolderExclusionAssessment {
  schemaVersion: "solana-holder-exclusion-assessment-v1";
  chain: "solana";
  mintAddress: string;
  policyVersion: "solana-address-exclusion-policy-v1";
  sourceEvidence: {
    holderFetchedAt: string;
    holderEnumeration: SolanaHolderStructure["enumeration"];
    holderAmountCoverage: SolanaHolderStructure["amountCoverage"];
    addressRoleEvidenceSchemaVersion: SolanaAddressRoleEvidence["schemaVersion"];
    baseMintAuthoritySource: SolanaAddressRoleEvidence["baseMintAuthoritySource"];
    baseFreezeAuthoritySource: SolanaAddressRoleEvidence["baseFreezeAuthoritySource"];
    marketSource: SolanaAddressRoleEvidence["marketSource"];
  };
  /** One row per positive owner authority, sorted by canonical address. */
  subjects: SolanaHolderExclusionSubjectAssessment[];
  summary: {
    subjectCount: number;
    excludeCount: number;
    retainCount: number;
    unresolvedCount: number;
  };
}

export type SolanaHolderExclusionAssessmentInput = {
  holderStructure: SolanaHolderStructure;
  addressRoleEvidence: SolanaAddressRoleEvidence;
};

export type SolanaHolderExclusionRuleId = SolanaAddressRoleId;

export interface SolanaHolderExclusionAssessmentV2 {
  schemaVersion: "solana-holder-exclusion-assessment-v2";
  chain: "solana";
  mintAddress: string;
  policyVersion: "solana-address-exclusion-policy-v1";
  sourceEvidence: {
    holderSnapshotSchemaVersion: "solana-holder-snapshot-record-v2";
    holderSnapshotId: string;
    holderFetchedAt: string;
    holderAcquisition: SolanaHolderSnapshotAcquisitionV2;
    holderEnumeration: {
      completeness: "complete" | "partial";
      slotConsistency: "not_guaranteed";
      pageCount: number;
      contextSlots: readonly number[];
    };
    holderAmountCoverage: SolanaHolderSnapshotRecordV2["snapshot"]["amountCoverage"];
    currentMintSupplyRaw: string;
    supplyDifferenceRaw: string;
    addressRoleEvidenceSchemaVersion: SolanaAddressRoleEvidenceV2["schemaVersion"];
    baseMintAuthoritySource: SolanaAddressRoleEvidenceV2["baseMintAuthoritySource"];
    baseFreezeAuthoritySource: SolanaAddressRoleEvidenceV2["baseFreezeAuthoritySource"];
    marketSource: SolanaAddressRoleEvidenceV2["marketSource"];
  };
  /** The frame is exactly the observed positive owner-authority rows; partial enumeration may omit subjects. */
  subjects: SolanaHolderExclusionAssessment["subjects"];
  summary: SolanaHolderExclusionAssessment["summary"];
}

export type SolanaHolderExclusionAssessmentInputV2 = {
  holderSnapshot: SolanaHolderSnapshotRecordV2;
  addressRoleEvidence: SolanaAddressRoleEvidenceV2;
};
