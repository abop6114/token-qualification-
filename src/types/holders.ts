import type { TokenProgram } from "./solana";

export interface RawSolanaTokenAccount {
  address: string;
  programOwner: string;
  dataBase64: string;
  reportedSpace: number | null;
}

export interface RawSolanaTokenAccountPage {
  accounts: RawSolanaTokenAccount[];
  paginationKey: string | null;
  contextSlot: number;
}

export interface HolderOwnerBalance {
  ownerAddress: string;
  balanceRaw: string;
  tokenAccountCount: number;
}

export type HolderConcentration =
  | {
      status: "available";
      topN: 1 | 5 | 10 | 20;
      numeratorRaw: string;
      denominatorRaw: string;
      denominatorBasis: "current_mint_supply";
      percentage: string;
    }
  | {
      status: "unavailable";
      topN: 1 | 5 | 10 | 20;
      numeratorRaw: null;
      denominatorRaw: string;
      denominatorBasis: "current_mint_supply";
      percentage: null;
      reason: "zero_supply" | "unsupported_balance_affecting_extension" | "supply_inconsistency";
    };

export interface SolanaHolderStructure {
  chain: "solana";
  mintAddress: string;
  tokenProgram: TokenProgram;
  decimals: number;
  currentMintSupplyRaw: string;
  observedPositiveBalanceRaw: string;
  /** currentMintSupplyRaw - observedPositiveBalanceRaw as a signed decimal string. */
  supplyDifferenceRaw: string;
  fetchedAt: string;
  enumeration: {
    /** Complete means the GPA V2 cursor walk reached an explicit null cursor. */
    completeness: "complete";
    /** Pages can have different context slots; completeness does not imply one atomic ledger snapshot. */
    slotConsistency: "not_guaranteed";
    pageCount: number;
    contextSlots: number[];
  };
  tokenAccountCount: number;
  nonzeroTokenAccountCount: number;
  /** Distinct positive-balance token-account owner authorities, not economic owners. */
  rawOwnerCount: number;
  rawOwnerAuthorities: HolderOwnerBalance[];
  amountCoverage: {
    state: "complete" | "partial";
    unsupportedExtensionTypes: number[];
    reason: "unsupported_balance_affecting_extension" | "supply_inconsistency" | null;
  };
  concentration: {
    top1: HolderConcentration;
    top5: HolderConcentration;
    top10: HolderConcentration;
    top20: HolderConcentration;
  };
}
