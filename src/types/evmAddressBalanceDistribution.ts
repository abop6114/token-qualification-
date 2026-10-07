import type {
  EvmHolderCoverage,
  EvmHolderEvidenceProvenance,
  EvmHolderPaginationEvidence,
} from "./evmHolders";
import type { EvmChain } from "./evmToken";

export type EvmAddressBalanceDistributionPercentile = 10 | 25 | 50 | 75 | 90 | 99 | 100;

export interface EvmRepeatedBalanceGroup {
  balanceRaw: string;
  addressCount: number;
}

export interface EvmCumulativeAddressBalanceProfilePoint {
  addressPercentile: EvmAddressBalanceDistributionPercentile;
  includedAddressCount: number;
  cumulativeObservedBalanceRaw: string;
  /** Share of observedPositiveBalanceRaw; null only when that denominator is zero. */
  cumulativeObservedBalanceShare: string | null;
}

interface EvmAddressBalanceDistributionSource {
  chain: EvmChain;
  tokenContractAddress: string;
  population: "positive_balance_addresses";
  /** Provider coverage is preserved verbatim and does not imply blockchain-complete ownership. */
  sourceCoverage: EvmHolderCoverage;
  sourceProvenance: EvmHolderEvidenceProvenance;
  sourcePagination: EvmHolderPaginationEvidence;
  sourceHolderRecordCount: number;
}

export interface EvmAddressBalanceDistributionAvailable extends EvmAddressBalanceDistributionSource {
  status: "available";
  observedPositiveAddressCount: number;
  observedPositiveBalanceRaw: string;
  minimumBalanceRaw: string | null;
  maximumBalanceRaw: string | null;
  quantilesRaw: {
    p25: string | null;
    p50: string | null;
    p75: string | null;
    p90: string | null;
    p99: string | null;
  };
  distinctBalanceCount: number;
  repeatedBalanceGroupCount: number;
  addressesInRepeatedBalanceGroups: number;
  /** Six-decimal half-up share of the positive observed address population. */
  addressShareInRepeatedBalanceGroups: string | null;
  /** First 25 groups after deterministic sorting; aggregate statistics use all groups. */
  repeatedBalanceGroups: EvmRepeatedBalanceGroup[];
  repeatedBalanceGroupsOmitted: number;
  cumulativeAddressBalanceProfile: EvmCumulativeAddressBalanceProfilePoint[];
}

export interface EvmAddressBalanceDistributionUnavailable extends EvmAddressBalanceDistributionSource {
  status: "unavailable";
  reason: "no_accepted_holder_observations";
}

/** Descriptive statistics over observed positive balance-bearing addresses, never wallets or owners. */
export type EvmAddressBalanceDistribution =
  | EvmAddressBalanceDistributionAvailable
  | EvmAddressBalanceDistributionUnavailable;
