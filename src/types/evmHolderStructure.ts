import type { EvmChain } from "./evmToken";
import type { EvmHolderCoverage } from "./evmHolders";

export interface EvmPositiveBalanceAddress {
  address: string;
  balanceRaw: string;
}

export type EvmSupplyReconciliation =
  | {
      status: "reconciled" | "less_than_supply" | "greater_than_supply";
      observedPositiveBalanceRaw: string;
      totalSupplyRaw: string;
      basis: "observed_positive_balance_addresses_vs_total_supply";
    }
  | {
      status: "not_comparable";
      observedPositiveBalanceRaw: string;
      totalSupplyRaw: string | null;
      reason: "alchemy_block_unavailable" | "goldrush_block_not_reported" | "observation_block_mismatch";
    }
  | {
      status: "unknown";
      observedPositiveBalanceRaw: string;
      totalSupplyRaw: null;
      reason: "total_supply_unavailable" | "total_supply_malformed";
    };

export type EvmTopNSupplyConcentration =
  | {
      status: "available";
      topN: 1 | 5 | 10 | 20;
      numeratorRaw: string;
      denominatorRaw: string;
      denominatorBasis: "total_supply";
      percentage: string;
    }
  | {
      status: "unavailable";
      topN: 1 | 5 | 10 | 20;
      numeratorRaw: string;
      denominatorRaw: string | null;
      denominatorBasis: "total_supply";
      percentage: null;
      reason:
        | "alchemy_block_unavailable"
        | "goldrush_block_not_reported"
        | "observation_block_mismatch"
        | "total_supply_unavailable"
        | "total_supply_malformed"
        | "zero_supply"
        | "holder_coverage_incomplete"
        | "supply_not_reconciled";
    };

/** Raw address-level evidence; addresses do not imply wallets, people, or economic owners. */
export interface EvmHolderStructure {
  chain: EvmChain;
  tokenContractAddress: string;
  /** All distinct holder rows returned/retained, including zero-balance rows. */
  observedHolderRecordCount: number;
  /** Number of distinct addresses with a positive exact raw balance. */
  balanceBearingAddressCount: number;
  /** Exact sum of positive balances among the observed, deduplicated addresses. */
  observedPositiveBalanceRaw: string;
  /** The GoldRush pagination state is carried through without implying chain-wide ownership completeness. */
  goldRushCoverage: EvmHolderCoverage;
  /** Positive-balance addresses ordered by balance descending, then normalized address ascending. */
  rankedBalanceBearingAddresses: EvmPositiveBalanceAddress[];
  supplyReconciliation: EvmSupplyReconciliation;
  topNBalanceNumeratorsRaw: {
    top1: string;
    top5: string;
    top10: string;
    top20: string;
  };
  topNSupplyConcentration: {
    top1: EvmTopNSupplyConcentration;
    top5: EvmTopNSupplyConcentration;
    top10: EvmTopNSupplyConcentration;
    top20: EvmTopNSupplyConcentration;
  };
}
