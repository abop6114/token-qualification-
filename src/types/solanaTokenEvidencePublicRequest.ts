export type SolanaTokenEvidencePublicHistoryRequest =
  | { status: "not_requested" }
  | {
      status: "requested";
      startTimeUnixSeconds: number;
      endTimeUnixSecondsExclusive: number;
    };

/** Transport-neutral public input. History is opt-in when this property is omitted. */
export interface SolanaTokenEvidencePublicRequest {
  chain: "solana";
  assetAddress: string;
  historicalTransactions?: SolanaTokenEvidencePublicHistoryRequest;
}

export type SolanaTokenEvidencePublicRequestErrorCategory =
  | "invalid_request_shape"
  | "unsupported_chain"
  | "invalid_asset_address"
  | "invalid_historical_request";
