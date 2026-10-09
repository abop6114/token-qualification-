import type { SolanaExclusionDecision } from "./solanaHolderExclusionAssessment";
import type { SolanaNotExcludedOwnerAuthorityPopulationEvidenceV2 } from "./solanaNotExcludedOwnerAuthorityPopulation";

export type SolanaNotExcludedTopN = 1 | 5 | 10 | 20;
export type SolanaNotExcludedTopNKey = "top1" | "top5" | "top10" | "top20";

interface SolanaNotExcludedConcentrationTopNBase {
  topN: SolanaNotExcludedTopN;
  /** Exact sum of the N largest balances in the post-exclusion population. */
  numeratorRaw: string;
}

type AvailableTopN = SolanaNotExcludedConcentrationTopNBase & { percentage: string };
type UnavailableTopN = SolanaNotExcludedConcentrationTopNBase & { percentage: null };

export interface SolanaNotExcludedOwnerAuthorityConcentrationEvidence {
  schemaVersion: "solana-not-excluded-owner-authority-concentration-v1";
  chain: "solana";
  mintAddress: string;
  policyVersion: "solana-address-exclusion-policy-v1";
  source: {
    populationSchemaVersion: "solana-not-excluded-owner-authority-population-v1";
    holderSnapshotId: string;
    exclusionAssessmentSchemaVersion: "solana-holder-exclusion-assessment-v1";
    holderFetchedAt: string;
    enumeration: {
      completeness: "complete";
      slotConsistency: "not_guaranteed";
      pageCount: number;
      contextSlots: readonly number[];
    };
    amountCoverage: {
      state: "complete" | "partial";
      unsupportedExtensionTypes: readonly number[];
      reason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
    };
    currentMintSupplyRaw: string;
    supplyDifferenceRaw: string;
    /** Holder pages and mint supply are not proven to share an atomic observation point. */
    holderSupplyAlignment: "not_proven_atomic";
  };
  population: {
    subjectType: "observed_positive_solana_owner_authorities";
    rawSubjectCount: number;
    rawObservedBalanceRaw: string;
    byDecision: Record<SolanaExclusionDecision, { subjectCount: number; observedBalanceRaw: string }>;
    notExcludedSubjectCount: number;
    notExcludedObservedBalanceRaw: string;
  };
  /** Numerator divided by the original current mint supply. */
  notExcludedTopNCurrentMintSupplyShare:
    | {
        status: "available";
        basis: "current_mint_supply";
        denominatorRaw: string;
        completeness: "complete";
        top1: AvailableTopN;
        top5: AvailableTopN;
        top10: AvailableTopN;
        top20: AvailableTopN;
      }
    | {
        status: "unavailable";
        basis: "current_mint_supply";
        denominatorRaw: string;
        reason: "zero_supply" | "partial_amount_coverage" | "supply_inconsistency";
        top1: UnavailableTopN;
        top5: UnavailableTopN;
        top10: UnavailableTopN;
        top20: UnavailableTopN;
      };
  /** Numerator divided by the exact balance total of the same observed not-excluded population. */
  notExcludedObservedPopulationTopNShare:
    | {
        status: "available";
        basis: "not_excluded_observed_balance_total";
        denominatorRaw: string;
        completeness: "complete" | "partial";
        partialReasons: readonly ("unsupported_balance_affecting_extension" | "supply_inconsistency")[];
        unsupportedExtensionTypes: readonly number[];
        top1: AvailableTopN;
        top5: AvailableTopN;
        top10: AvailableTopN;
        top20: AvailableTopN;
      }
    | {
        status: "unavailable";
        basis: "not_excluded_observed_balance_total";
        denominatorRaw: "0";
        reason: "zero_not_excluded_observed_balance_total";
        completeness: "complete" | "partial";
        partialReasons: readonly ("unsupported_balance_affecting_extension" | "supply_inconsistency")[];
        unsupportedExtensionTypes: readonly number[];
        top1: UnavailableTopN;
        top5: UnavailableTopN;
        top10: UnavailableTopN;
        top20: UnavailableTopN;
      };
}

type V2TopN = SolanaNotExcludedOwnerAuthorityConcentrationEvidence["notExcludedObservedPopulationTopNShare"]["top1"];
type V2PercentageUnavailableTopN = Omit<V2TopN, "percentage"> & { percentage: null };
type V2PartialUnavailableTopN = Omit<V2PercentageUnavailableTopN, "numeratorRaw"> & { numeratorRaw: null };
type V2PartialReason = "enumeration_incomplete" | "unsupported_balance_affecting_extension" | "supply_inconsistency";

export interface SolanaNotExcludedOwnerAuthorityConcentrationEvidenceV2 {
  schemaVersion: "solana-not-excluded-owner-authority-concentration-v2";
  chain: "solana";
  mintAddress: string;
  policyVersion: "solana-address-exclusion-policy-v1";
  source: SolanaNotExcludedOwnerAuthorityPopulationEvidenceV2["source"] & {
    populationSchemaVersion: SolanaNotExcludedOwnerAuthorityPopulationEvidenceV2["schemaVersion"];
    exclusionAssessmentSchemaVersion: "solana-holder-exclusion-assessment-v2";
    holderSupplyAlignment: "not_proven_atomic";
  };
  population: {
    subjectType: "observed_positive_solana_owner_authorities";
    rawSubjectCount: number;
    rawObservedBalanceRaw: string;
    byDecision: Record<SolanaExclusionDecision, { subjectCount: number; observedBalanceRaw: string }>;
    notExcludedSubjectCount: number;
    notExcludedObservedBalanceRaw: string;
  };
  notExcludedTopNCurrentMintSupplyShare:
    | { status: "available"; basis: "current_mint_supply"; denominatorRaw: string; completeness: "complete"; top1: V2TopN; top5: V2TopN; top10: V2TopN; top20: V2TopN }
    | { status: "unavailable"; basis: "current_mint_supply"; denominatorRaw: string; reason: "enumeration_incomplete"; top1: V2PartialUnavailableTopN; top5: V2PartialUnavailableTopN; top10: V2PartialUnavailableTopN; top20: V2PartialUnavailableTopN }
    | { status: "unavailable"; basis: "current_mint_supply"; denominatorRaw: string; reason: "zero_supply" | "partial_amount_coverage" | "supply_inconsistency"; top1: V2PercentageUnavailableTopN; top5: V2PercentageUnavailableTopN; top10: V2PercentageUnavailableTopN; top20: V2PercentageUnavailableTopN };
  notExcludedObservedPopulationTopNShare:
    | { status: "available"; basis: "not_excluded_observed_balance_total"; denominatorRaw: string; completeness: "complete" | "partial"; partialReasons: readonly V2PartialReason[]; unsupportedExtensionTypes: readonly number[]; top1: V2TopN; top5: V2TopN; top10: V2TopN; top20: V2TopN }
    | { status: "unavailable"; basis: "not_excluded_observed_balance_total"; denominatorRaw: "0"; reason: "zero_not_excluded_observed_balance_total"; completeness: "complete" | "partial"; partialReasons: readonly V2PartialReason[]; unsupportedExtensionTypes: readonly number[]; top1: V2PercentageUnavailableTopN; top5: V2PercentageUnavailableTopN; top10: V2PercentageUnavailableTopN; top20: V2PercentageUnavailableTopN };
}
