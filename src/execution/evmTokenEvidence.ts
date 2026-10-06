import { requestAlchemyRpc, EvmRpcProviderError, ALCHEMY_EVM_DEFAULT_TIMEOUT_MS } from "../providers/evm/alchemyRpc";
import {
  normalizeEvmAbiString,
  normalizeEvmBlockNumber,
  normalizeEvmContractCode,
  normalizeEvmDecimals,
  normalizeEvmUint256,
} from "../normalization/evmToken";
import type {
  EvmBlockEvidence,
  EvmChain,
  EvmContractCodeEvidence,
  EvmProviderErrorEvidence,
  EvmRpcFact,
  EvmRpcMethod,
  EvmTokenContractEvidence,
  EvmTokenEvidenceExecutionResult,
} from "../types/evmToken";
import { normalizeEvmAddress } from "../validation/evmAddress";

export type EvmRpcRequester = (chain: EvmChain, method: EvmRpcMethod, params: unknown[]) => Promise<unknown>;

export interface ExecuteEvmTokenEvidenceOptions {
  requestRpc?: EvmRpcRequester;
  timeoutMs?: number;
  now?: () => Date;
}

const SELECTORS = {
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
} as const;

const PROVIDER_ERROR_CATEGORIES = ["configuration", "transport", "http", "rpc", "malformed_response"] as const;

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1_000) / 1_000);
}

function providerErrorEvidence(error: unknown): EvmProviderErrorEvidence {
  if (error instanceof EvmRpcProviderError) {
    const category = PROVIDER_ERROR_CATEGORIES.includes(error.category) ? error.category : "transport";
    const safeMessage = category === "configuration" ? "Alchemy configuration is invalid or missing."
      : category === "transport" ? "Alchemy RPC request failed."
        : category === "http" ? "Alchemy HTTP request failed."
          : category === "rpc" ? "Alchemy returned a JSON-RPC error."
            : "Alchemy returned a malformed JSON-RPC response.";
    return {
      category,
      httpStatus: Number.isSafeInteger(error.httpStatus) ? error.httpStatus : null,
      rpcCode: Number.isSafeInteger(error.rpcCode) ? error.rpcCode : null,
      message: safeMessage,
    };
  }
  return { category: "transport", httpStatus: null, rpcCode: null, message: "Alchemy RPC request failed." };
}

function failedFact<T>(error: unknown): EvmRpcFact<T> {
  const sanitized = providerErrorEvidence(error);
  if (sanitized.category === "rpc" && sanitized.rpcCode !== null) {
    return { status: "rpc_error", value: null, rpcCode: sanitized.rpcCode };
  }
  if (sanitized.category === "malformed_response") {
    return { status: "malformed", value: null, reason: "malformed_response" };
  }
  return { status: "provider_error", value: null, error: sanitized };
}

function failedCode(error: unknown): EvmContractCodeEvidence {
  const sanitized = providerErrorEvidence(error);
  if (sanitized.category === "rpc" && sanitized.rpcCode !== null) {
    return { status: "rpc_error", rpcCode: sanitized.rpcCode };
  }
  if (sanitized.category === "malformed_response") {
    return { status: "malformed", reason: "malformed_response" };
  }
  return { status: "provider_error", error: sanitized };
}

function blockFailure(error: unknown): EvmBlockEvidence {
  const sanitized = providerErrorEvidence(error);
  if (sanitized.category === "malformed_response") {
    return { status: "malformed", blockNumber: null, reason: "malformed_response" };
  }
  return { status: "provider_error", blockNumber: null, error: sanitized };
}

function notAttempted<T>(reason: "block_unavailable" | "no_contract_code" | "code_unavailable"): EvmRpcFact<T> {
  return { status: "not_attempted", value: null, reason };
}

function notAttemptedCode(): EvmContractCodeEvidence {
  return { status: "not_attempted", reason: "block_unavailable" };
}

function increment(counts: Record<EvmRpcMethod, number>, method: EvmRpcMethod): void {
  counts[method] += 1;
}

/** Acquires sequential Base/Ethereum contract evidence, pinned to one selected block. */
export async function executeEvmTokenEvidence(
  chain: EvmChain,
  submittedAddress: string,
  options: ExecuteEvmTokenEvidenceOptions = {},
): Promise<EvmTokenEvidenceExecutionResult> {
  if (chain !== "base" && chain !== "ethereum") throw new Error("An explicit supported EVM chain (base or ethereum) is required.");
  const contractAddress = normalizeEvmAddress(submittedAddress);
  if (contractAddress === null) throw new Error("A 0x-prefixed 20-byte EVM contract address is required.");

  const started = performance.now();
  const now = options.now ?? (() => new Date());
  const fetchedAt = now().toISOString();
  const requestRpc = options.requestRpc ?? ((requestChain, method, params) =>
    requestAlchemyRpc(requestChain, method, params, { timeoutMs: options.timeoutMs ?? ALCHEMY_EVM_DEFAULT_TIMEOUT_MS }));
  const requestsAttemptedByMethod: Record<EvmRpcMethod, number> = {
    eth_blockNumber: 0,
    eth_getCode: 0,
    eth_call: 0,
  };
  const request = async (method: EvmRpcMethod, params: unknown[]): Promise<unknown> => {
    increment(requestsAttemptedByMethod, method);
    return requestRpc(chain, method, params);
  };

  let observationBlock: EvmBlockEvidence;
  const timeoutMs = options.timeoutMs ?? ALCHEMY_EVM_DEFAULT_TIMEOUT_MS;
  const preflightError = options.requestRpc === undefined &&
    (process.env.ALCHEMY_API_KEY === undefined || process.env.ALCHEMY_API_KEY.trim() === "")
    ? new EvmRpcProviderError("configuration", "ALCHEMY_API_KEY is not configured.")
    : options.requestRpc === undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      ? new EvmRpcProviderError("configuration", "Alchemy request timeout is invalid.")
      : null;
  if (preflightError !== null) {
    observationBlock = blockFailure(preflightError);
  } else {
    try {
      observationBlock = normalizeEvmBlockNumber(await request("eth_blockNumber", []));
    } catch (error: unknown) {
      observationBlock = blockFailure(error);
    }
  }

  let contractCode: EvmContractCodeEvidence;
  let totalSupply: EvmRpcFact<string>;
  let decimals: EvmRpcFact<number>;
  let name: EvmRpcFact<string>;
  let symbol: EvmRpcFact<string>;

  if (observationBlock.status !== "available") {
    contractCode = notAttemptedCode();
    totalSupply = notAttempted("block_unavailable");
    decimals = notAttempted("block_unavailable");
    name = notAttempted("block_unavailable");
    symbol = notAttempted("block_unavailable");
  } else {
    try {
      contractCode = normalizeEvmContractCode(await request("eth_getCode", [contractAddress, observationBlock.blockNumber]));
    } catch (error: unknown) {
      contractCode = failedCode(error);
    }

    if (contractCode.status !== "present") {
      const reason = contractCode.status === "no_code" ? "no_contract_code" : "code_unavailable";
      totalSupply = notAttempted(reason);
      decimals = notAttempted(reason);
      name = notAttempted(reason);
      symbol = notAttempted(reason);
    } else {
      const call = async <T>(selector: string, normalize: (value: unknown) => EvmRpcFact<T>): Promise<EvmRpcFact<T>> => {
        try {
          const result = await request("eth_call", [{ to: contractAddress, data: selector }, observationBlock.blockNumber]);
          return normalize(result);
        } catch (error: unknown) {
          return failedFact<T>(error);
        }
      };
      totalSupply = await call(SELECTORS.totalSupply, normalizeEvmUint256);
      decimals = await call(SELECTORS.decimals, normalizeEvmDecimals);
      name = await call(SELECTORS.name, normalizeEvmAbiString);
      symbol = await call(SELECTORS.symbol, normalizeEvmAbiString);
    }
  }

  const evidence: EvmTokenContractEvidence = {
    schemaVersion: "evm-token-contract-evidence-v1",
    chain,
    submittedAddress,
    contractAddress,
    provenance: { chain, provider: "alchemy", fetchedAt, observationBlock },
    contractCode,
    totalSupply,
    decimals,
    name,
    symbol,
  };
  return {
    evidence,
    telemetry: {
      requestCount: Object.values(requestsAttemptedByMethod).reduce((sum, count) => sum + count, 0),
      requestsAttemptedByMethod,
      elapsedMs: elapsedMs(started),
    },
  };
}
