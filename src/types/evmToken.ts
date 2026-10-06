export type EvmChain = "base" | "ethereum";

export type EvmProviderErrorCategory = "configuration" | "transport" | "http" | "rpc" | "malformed_response";

export interface EvmProviderErrorEvidence {
  category: EvmProviderErrorCategory;
  httpStatus: number | null;
  rpcCode: number | null;
  /** Sanitized diagnostic text; never a raw provider body, URL, or transport exception. */
  message: string;
}

export type EvmRpcFact<T> =
  | { status: "available"; value: T; basis: "eth_getCode" | "eth_call" }
  | { status: "not_attempted"; value: null; reason: "block_unavailable" | "no_contract_code" | "code_unavailable" }
  | { status: "provider_error"; value: null; error: EvmProviderErrorEvidence }
  | { status: "rpc_error"; value: null; rpcCode: number }
  | { status: "malformed"; value: null; reason: "malformed_response" | "malformed_abi" };

export type EvmBlockEvidence =
  | { status: "available"; blockNumber: string; basis: "eth_blockNumber" }
  | { status: "provider_error"; blockNumber: null; error: EvmProviderErrorEvidence }
  | { status: "malformed"; blockNumber: null; reason: "malformed_response" };

export type EvmContractCodeEvidence =
  | { status: "present"; byteLength: number; basis: "eth_getCode" }
  | { status: "no_code"; byteLength: 0; basis: "eth_getCode" }
  | { status: "not_attempted"; reason: "block_unavailable" }
  | { status: "provider_error"; error: EvmProviderErrorEvidence }
  | { status: "rpc_error"; rpcCode: number }
  | { status: "malformed"; reason: "malformed_response" };

export interface EvmTokenEvidenceProvenance {
  chain: EvmChain;
  provider: "alchemy";
  fetchedAt: string;
  /** All code and ERC-20 calls, when attempted, use this exact block quantity. */
  observationBlock: EvmBlockEvidence;
}

export interface EvmTokenContractEvidence {
  schemaVersion: "evm-token-contract-evidence-v1";
  chain: EvmChain;
  submittedAddress: string;
  contractAddress: string;
  provenance: EvmTokenEvidenceProvenance;
  contractCode: EvmContractCodeEvidence;
  totalSupply: EvmRpcFact<string>;
  decimals: EvmRpcFact<number>;
  name: EvmRpcFact<string>;
  symbol: EvmRpcFact<string>;
}

export type EvmRpcMethod = "eth_blockNumber" | "eth_getCode" | "eth_call";

export interface EvmTokenEvidenceTelemetry {
  requestCount: number;
  requestsAttemptedByMethod: Record<EvmRpcMethod, number>;
  elapsedMs: number;
}

export interface EvmTokenEvidenceExecutionResult {
  evidence: EvmTokenContractEvidence;
  telemetry: EvmTokenEvidenceTelemetry;
}
