import type { SolanaHistoricalAmountEvidence } from "./solanaHistoricalSampling";

export type SolanaTransactionAvailability<T, R extends string> =
  | { status: "available"; value: T }
  | { status: "unavailable"; value: null; reason: R };

export type SolanaTransactionSafeIntegerEvidence<R extends string> =
  | { status: "available"; value: number; exactness: "safe_json_integer" }
  | { status: "unavailable"; value: null; reason: R };

export interface SolanaTransactionRequestProvenance {
  chain: "solana";
  provider: "helius";
  method: "getTransaction";
  encoding: "json";
  commitment: "finalized";
  maxSupportedTransactionVersion: 0;
  requestedSignature: string;
  /** Application time at which the single request is started. */
  fetchedAt: string;
}

export interface SolanaTransactionProviderError {
  category: "configuration" | "transport" | "request_timeout" | "http" | "rpc";
  httpStatus: number | null;
  rpcCode: number | null;
  message: string;
}

export type SolanaTransactionMalformedReason =
  | "signature_mismatch"
  | "malformed_structure"
  | "unsupported_version";

export type SolanaTransactionFetchOutcome =
  | {
      status: "returned";
      provenance: SolanaTransactionRequestProvenance;
      transaction: SolanaTransactionEvidence;
    }
  | {
      status: "provider_result_null";
      provenance: SolanaTransactionRequestProvenance;
      transaction: null;
    }
  | {
      status: "provider_error";
      provenance: SolanaTransactionRequestProvenance;
      transaction: null;
      error: SolanaTransactionProviderError;
    }
  | {
      status: "malformed_response";
      provenance: SolanaTransactionRequestProvenance;
      transaction: null;
      reason: SolanaTransactionMalformedReason;
      message: string;
    };

export type SolanaTransactionJsonValue =
  | string
  | number
  | boolean
  | null
  | SolanaTransactionJsonValue[]
  | { [key: string]: SolanaTransactionJsonValue };

export type SolanaTransactionExecutionEvidence =
  | { status: "succeeded"; basis: "provider_meta_err_null" }
  | {
      status: "failed";
      basis: "provider_meta_err_non_null";
      reportedError: SolanaTransactionJsonValue;
    }
  | {
      status: "unavailable";
      reason: "meta_missing" | "meta_null" | "meta_malformed" | "err_missing";
    };

export interface SolanaTransactionLookupEvidence {
  accountKey: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface SolanaTransactionLoadedAddresses {
  writable: string[];
  readonly: string[];
}

export interface SolanaTransactionAccount {
  accountIndex: number;
  address: string;
  source: "static" | "loaded_writable" | "loaded_readonly";
  signer: boolean | null;
  writable: boolean | null;
}

export type SolanaTransactionAccountReference =
  | { accountIndex: number; status: "resolved"; address: string }
  | {
      accountIndex: number;
      status: "unresolved";
      address: null;
      reason: "account_space_partial" | "address_unusable" | "index_out_of_range";
    };

export interface SolanaTransactionAccountSpace {
  canonicalOrder: "static_loaded_writable_loaded_readonly";
  status: "complete" | "partial" | "unavailable";
  reason:
    | null
    | "lookup_metadata_missing"
    | "lookup_metadata_malformed"
    | "loaded_addresses_missing"
    | "loaded_addresses_null"
    | "loaded_addresses_malformed"
    | "lookup_loaded_count_mismatch"
    | "static_keys_unusable";
  addressTableLookups: SolanaTransactionAvailability<
    SolanaTransactionLookupEvidence[],
    "missing" | "malformed"
  >;
  loadedAddresses: SolanaTransactionAvailability<
    SolanaTransactionLoadedAddresses,
    "meta_missing" | "meta_null" | "field_missing" | "field_null" | "malformed"
  >;
  /** Only addresses whose canonical indices are known are included. */
  accounts: SolanaTransactionAccount[];
  signerWritableStatus: "available" | "unavailable";
  header:
    | {
        status: "available";
        numRequiredSignatures: number;
        numReadonlySignedAccounts: number;
        numReadonlyUnsignedAccounts: number;
      }
    | { status: "unavailable"; reason: "missing" | "malformed" };
}

export interface SolanaCompiledInstructionEvidence {
  position: number;
  programIdIndex: number;
  program: SolanaTransactionAccountReference;
  accountIndices: number[];
  accounts: SolanaTransactionAccountReference[];
  /** Original base58-encoded instruction data; not protocol-decoded. */
  data: string;
  status: "complete" | "partial";
}

export type SolanaInstructionEntry =
  | { status: "available"; instruction: SolanaCompiledInstructionEvidence }
  | { status: "malformed"; position: number; reason: string };

export interface SolanaInstructionCollection {
  status: "available" | "partial" | "unavailable";
  reason: "field_missing" | "field_null" | "malformed" | null;
  reportedCount: number | null;
  entries: SolanaInstructionEntry[];
}

export type SolanaInnerInstructionGroup =
  | {
      status: "available";
      parentOuterInstructionIndex: number;
      instructions: SolanaInstructionEntry[];
    }
  | { status: "malformed"; groupPosition: number; reason: string };

export interface SolanaInnerInstructionCollection {
  status: "available" | "partial" | "unavailable";
  reason: "meta_missing" | "meta_null" | "field_missing" | "field_null" | "malformed" | null;
  reportedGroupCount: number | null;
  groups: SolanaInnerInstructionGroup[];
}

export type SolanaTokenField<T> =
  | { status: "available"; value: T }
  | {
      status: "unavailable";
      value: null;
      reason: "missing" | "null" | "malformed" | "unresolved_account";
    };

export type SolanaTokenAmountField =
  | { status: "available"; evidence: SolanaHistoricalAmountEvidence }
  | { status: "unavailable"; evidence: null; reason: "missing" | "null" | "malformed" };

export interface SolanaTokenBalanceObservation {
  providerArrayIndex: number;
  accountIndex: SolanaTokenField<number>;
  tokenAccountAddress: SolanaTokenField<string>;
  mint: SolanaTokenField<string>;
  owner: SolanaTokenField<string>;
  amount: SolanaTokenAmountField;
  decimals: SolanaTokenField<number>;
}

export type SolanaTokenBalanceEntry =
  | { status: "available"; observation: SolanaTokenBalanceObservation }
  | { status: "partial"; observation: SolanaTokenBalanceObservation };

export type SolanaTokenBalanceSide =
  | {
      status: "available" | "partial";
      entries: SolanaTokenBalanceEntry[];
      reportedEntryCount: number;
    }
  | {
      status: "unavailable";
      entries: [];
      reportedEntryCount: null;
      reason: "meta_missing" | "meta_null" | "meta_malformed" | "field_missing" | "field_null" | "malformed";
    };

export type SolanaReportedSolBalance =
  | { status: "reported"; accountIndex: number; value: number; exactRawAvailable: false }
  | { status: "malformed"; accountIndex: number; reason: "not_a_number" | "negative" };

export type SolanaSolBalanceSide =
  | {
      status: "available" | "partial";
      values: SolanaReportedSolBalance[];
      reportedEntryCount: number;
      exactness: "non_exact_json_number_observations";
    }
  | {
      status: "unavailable";
      values: [];
      reportedEntryCount: null;
      exactness: "non_exact_json_number_observations";
      reason: "meta_missing" | "meta_null" | "meta_malformed" | "field_missing" | "field_null" | "malformed";
    };

export interface SolanaTransactionEvidence {
  signatures: string[];
  slot: SolanaTransactionSafeIntegerEvidence<"missing" | "null" | "unsafe_or_malformed">;
  blockTime: SolanaTransactionSafeIntegerEvidence<"missing" | "null" | "unsafe_or_malformed">;
  version: SolanaTransactionAvailability<"legacy" | number, "missing" | "malformed">;
  execution: SolanaTransactionExecutionEvidence;
  accountSpace: SolanaTransactionAccountSpace;
  outerInstructions: SolanaInstructionCollection;
  innerInstructions: SolanaInnerInstructionCollection;
  tokenBalances: { pre: SolanaTokenBalanceSide; post: SolanaTokenBalanceSide };
  solBalances: { pre: SolanaSolBalanceSide; post: SolanaSolBalanceSide };
  structuralCompleteness: "complete" | "partial";
  /** This one-transaction response says nothing about history coverage. */
  historicalCoverage: "not_assessed";
}

export interface SolanaTransactionExecutionTelemetry {
  requestCount: 0 | 1;
  elapsedMs: number;
}

export interface SolanaTransactionEvidenceExecutionResult {
  evidence: SolanaTransactionFetchOutcome;
  telemetry: SolanaTransactionExecutionTelemetry;
}
