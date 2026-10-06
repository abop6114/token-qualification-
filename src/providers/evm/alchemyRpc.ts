import type { EvmChain, EvmProviderErrorCategory, EvmRpcMethod } from "../../types/evmToken";

const RPC_URLS: Readonly<Record<EvmChain, string>> = {
  base: "https://base-mainnet.g.alchemy.com/v2/",
  ethereum: "https://eth-mainnet.g.alchemy.com/v2/",
};
const REQUEST_ID = "tqe-evm-token-evidence";
const MAX_TIMEOUT_MS = 2_147_483_647;
export const ALCHEMY_EVM_DEFAULT_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export class EvmRpcProviderError extends Error {
  constructor(
    readonly category: EvmProviderErrorCategory,
    message: string,
    readonly rpcCode: number | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "EvmRpcProviderError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function requestAlchemyRpc(
  chain: EvmChain,
  method: EvmRpcMethod,
  params: unknown[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<unknown> {
  if (chain !== "base" && chain !== "ethereum") {
    throw new EvmRpcProviderError("configuration", "An explicitly supported EVM chain is required.");
  }
  const timeoutMs = options.timeoutMs ?? ALCHEMY_EVM_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new EvmRpcProviderError("configuration", "Alchemy request timeout is invalid.");
  }
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new EvmRpcProviderError("configuration", "ALCHEMY_API_KEY is not configured.");
  }

  const endpoint = `${RPC_URLS[chain]}${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: REQUEST_ID, method, params }),
    });
    if (!response.ok) {
      throw new EvmRpcProviderError("http", `Alchemy HTTP request failed (status ${response.status}).`, null, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw new EvmRpcProviderError("transport", "Alchemy RPC request timed out.");
      throw new EvmRpcProviderError("malformed_response", "Alchemy returned malformed JSON.");
    }
    if (!isObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== REQUEST_ID) {
      throw new EvmRpcProviderError("malformed_response", "Alchemy returned a malformed JSON-RPC response.");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "error")) {
      const error = payload.error;
      if (isObject(error) && typeof error.code === "number" && Number.isSafeInteger(error.code)) {
        throw new EvmRpcProviderError("rpc", "Alchemy returned a JSON-RPC error.", error.code);
      }
      throw new EvmRpcProviderError("malformed_response", "Alchemy returned a malformed JSON-RPC error.");
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
      throw new EvmRpcProviderError("malformed_response", "Alchemy omitted the JSON-RPC result.");
    }
    return payload.result;
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new EvmRpcProviderError("transport", "Alchemy RPC request timed out.");
    if (error instanceof EvmRpcProviderError) throw error;
    throw new EvmRpcProviderError("transport", "Alchemy RPC request failed.");
  } finally {
    clearTimeout(timeout);
  }
}
