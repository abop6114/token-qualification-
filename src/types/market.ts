export type SupportedMarketChain = "solana" | "base" | "ethereum";
export type MarketVolumeWindow = "m5" | "h1" | "h6" | "h24";

export type MarketMetric<T> =
  | {
      status: "available";
      value: T;
      basis: "provider_reported" | "calculated";
      sourceField?: string;
    }
  | {
      status: "unavailable";
      value: null;
      reason: "not_reported" | "no_market" | "no_creation_evidence" | "orientation_unsupported";
    };

export interface RawMarketPoolObservation {
  chainId: string;
  poolAddress: string;
  dexId: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  priceUsd: string | number | null;
  marketCapUsd: string | number | null;
  fdvUsd: string | number | null;
  liquidityUsd: string | number | null;
  volumeUsd: Partial<Record<MarketVolumeWindow, string | number | null>>;
  poolCreatedAt: number | null;
}

export interface MarketProvenance {
  provider: "dexscreener";
  fetchedAt: string;
  sourceUpdatedAt: string | null;
}

export interface NormalizedPoolMarket {
  poolAddress: string;
  dexId: string;
  counterTokenAddress: string | null;
  poolCreatedAt: MarketMetric<string>;
  priceUsd: MarketMetric<string>;
  marketCapUsd: MarketMetric<string>;
  fdvUsd: MarketMetric<string>;
  liquidityUsd: MarketMetric<string>;
  volumeUsd: Record<MarketVolumeWindow, MarketMetric<string>>;
  provenance: MarketProvenance;
}

export interface NormalizedMarketSnapshot {
  chain: SupportedMarketChain;
  mintAddress: string;
  snapshotAt: string;
  tokenCreatedAt: MarketMetric<string>;
  tokenAgeSeconds: MarketMetric<number>;
  lifecycle: {
    state: "bonding" | "graduated" | "unknown";
    basis: "on_chain" | "provider_reported" | "unknown";
    evidence: string | null;
  };
  pools: NormalizedPoolMarket[];
  primaryPoolAddress: string | null;
  provenance: MarketProvenance;
}
