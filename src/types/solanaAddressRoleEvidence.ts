import type { SolanaHolderStructure } from "./holders";
import type { NormalizedMarketSnapshot, MarketProvenance } from "./market";

export type SolanaAddressRoleId =
  | "base_mint_authority_address"
  | "base_freeze_authority_address"
  | "dexscreener_reported_pool_address";

export type SolanaAuthorityRoleSource =
  | {
      status: "set";
      address: string;
      holderPopulationRelation: "observed_positive" | "not_observed_positive";
      basis: "solana_mint_resolution_base_field";
      sourceObservation: { evidence: "solana_mint_resolution"; fetchedAt: null; contextSlot: null };
    }
  | {
      status: "unset";
      address: null;
      holderPopulationRelation: "not_applicable";
      basis: "solana_mint_resolution_base_field";
      sourceObservation: { evidence: "solana_mint_resolution"; fetchedAt: null; contextSlot: null };
    };

export interface SolanaAddressRoleHolderSource {
  evidence: "solana_holder_structure";
  fetchedAt: string;
  enumeration: SolanaHolderStructure["enumeration"];
  amountCoverage: SolanaHolderStructure["amountCoverage"];
  observedPositiveOwnerAuthorityCount: number;
}

export type SolanaAddressRoleMarketInput =
  | { status: "available"; snapshot: NormalizedMarketSnapshot }
  | { status: "unavailable"; provider: "dexscreener"; reason: "provider_error" | "malformed_response" };

export type SolanaAddressRoleMarketSource =
  | {
      status: "available";
      chain: "solana";
      mintAddress: string;
      snapshotAt: string;
      provenance: MarketProvenance;
      poolCount: number;
      validPoolAddressCount: number;
      invalidPoolAddresses: string[];
      invalidPoolCount: number;
      conflictingPoolAddresses: string[];
      /** Address validity only within this supplied snapshot; not DEX or market coverage. */
      suppliedPoolAddressValidation: "all_valid" | "invalid_present";
    }
  | {
      status: "unavailable";
      provider: "dexscreener";
      chain: "solana";
      mintAddress: string;
      reason: "provider_error" | "malformed_response";
    };

export type SolanaBaseAuthorityAddressRoleFinding =
  | {
      role: "base_mint_authority_address" | "base_freeze_authority_address";
      status: "observed_match";
      ownerAuthorityAddress: string;
      authorityAddress: string;
      basis: "exact_address_equality";
      sourceEvidence: "solana_mint_resolution_base_field";
      sourceObservation: { fetchedAt: null; contextSlot: null };
    }
  | {
      role: "base_mint_authority_address" | "base_freeze_authority_address";
      status: "no_match_in_examined_evidence";
      ownerAuthorityAddress: string;
      authorityStatus: "set" | "unset";
      authorityAddress: string | null;
      basis: "exact_address_equality";
      sourceEvidence: "solana_mint_resolution_base_field";
      sourceObservation: { fetchedAt: null; contextSlot: null };
    };

export interface SolanaPoolAddressMatch {
  poolAddress: string;
  dexId: string;
  chain: "solana";
  mintAddress: string;
  provenance: MarketProvenance;
}

export type SolanaDexPoolAddressRoleFinding =
  | {
      role: "dexscreener_reported_pool_address";
      status: "observed_match";
      ownerAuthorityAddress: string;
      matches: SolanaPoolAddressMatch[];
      /** Address validity only within this supplied snapshot; not DEX or market coverage. */
      suppliedPoolAddressValidation: "all_valid" | "invalid_present";
    }
  | {
      role: "dexscreener_reported_pool_address";
      status: "no_match_in_examined_evidence";
      ownerAuthorityAddress: string;
      examinedPoolCount: number;
      provenance: MarketProvenance;
    }
  | {
      role: "dexscreener_reported_pool_address";
      status: "unavailable";
      ownerAuthorityAddress: string;
      reason:
        | "market_source_unavailable"
        | "malformed_pool_address_present"
        | "conflicting_pool_address_evidence";
    }
  | {
      role: "dexscreener_reported_pool_address";
      status: "ambiguous";
      ownerAuthorityAddress: string;
      poolAddress: string;
      conflictingDexIds: string[];
      provenance: MarketProvenance;
    };

export interface SolanaOwnerAuthorityRoleEvidence {
  ownerAuthorityAddress: string;
  /** Fixed role order: base mint authority, base freeze authority, DEX Screener pool address. */
  findings: [
    SolanaBaseAuthorityAddressRoleFinding,
    SolanaBaseAuthorityAddressRoleFinding,
    SolanaDexPoolAddressRoleFinding,
  ];
}

/** Address-role correlation evidence only; this record contains no exclusion or adjusted-balance policy. */
export interface SolanaAddressRoleEvidence {
  schemaVersion: "solana-address-role-evidence-v1";
  chain: "solana";
  mintAddress: string;
  holderSource: SolanaAddressRoleHolderSource;
  baseMintAuthoritySource: SolanaAuthorityRoleSource;
  baseFreezeAuthoritySource: SolanaAuthorityRoleSource;
  marketSource: SolanaAddressRoleMarketSource;
  /** Positive-balance owner authorities only, sorted by canonical address. */
  ownerAuthorities: SolanaOwnerAuthorityRoleEvidence[];
}

export type SolanaAuthorityRoleSourceV2 =
  | {
      status: "set";
      address: string;
      holderPopulationRelation: "observed_positive";
      basis: "solana_mint_resolution_base_field";
      sourceObservation: { evidence: "solana_mint_resolution"; fetchedAt: null; contextSlot: null };
    }
  | {
      status: "set";
      address: string;
      holderPopulationRelation: "not_observed_positive";
      basis: "solana_mint_resolution_base_field";
      sourceObservation: { evidence: "solana_mint_resolution"; fetchedAt: null; contextSlot: null };
    }
  | {
      status: "set";
      address: string;
      holderPopulationRelation: "unknown";
      reason: "enumeration_incomplete" | "amount_coverage_partial" | "supply_inconsistency";
      basis: "solana_mint_resolution_base_field";
      sourceObservation: { evidence: "solana_mint_resolution"; fetchedAt: null; contextSlot: null };
    }
  | {
      status: "unset";
      address: null;
      holderPopulationRelation: "not_applicable";
      basis: "solana_mint_resolution_base_field";
      sourceObservation: { evidence: "solana_mint_resolution"; fetchedAt: null; contextSlot: null };
    };

export interface SolanaAddressRoleHolderSourceV2 {
  evidence: "solana_holder_snapshot_record_v2";
  snapshotSchemaVersion: "solana-holder-snapshot-record-v2";
  snapshotId: string;
  fetchedAt: string;
  tokenProgram: "spl-token" | "token-2022";
  decimals: number;
  enumeration: {
    completeness: "complete" | "partial";
    slotConsistency: "not_guaranteed";
    pageCount: number;
    contextSlots: readonly number[];
  };
  acquisition: {
    stopReason: "provider_terminated" | "page_cap" | "request_timeout" | "provider_error" | "malformed_response";
    configuredMaxPages: 20;
    requestedPageSize: 5000;
  };
  amountCoverage: {
    state: "complete" | "partial";
    unsupportedExtensionTypes: readonly number[];
    reason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
  };
  currentMintSupplyRaw: string;
  supplyDifferenceRaw: string;
  observedPositiveOwnerAuthorityCount: number;
}

export interface SolanaAddressRoleEvidenceV2 {
  schemaVersion: "solana-address-role-evidence-v2";
  chain: "solana";
  mintAddress: string;
  holderSource: SolanaAddressRoleHolderSourceV2;
  baseMintAuthoritySource: SolanaAuthorityRoleSourceV2;
  baseFreezeAuthoritySource: SolanaAuthorityRoleSourceV2;
  marketSource: SolanaAddressRoleMarketSource;
  ownerAuthorities: SolanaOwnerAuthorityRoleEvidence[];
}
