const HELIUS_MAINNET_RPC_URL = "https://mainnet.helius-rpc.com/";
const RPC_REQUEST_ID = "tqe-transaction-probe";
export const HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type HeliusTransactionErrorCategory =
  | "configuration"
  | "transport"
  | "request_timeout"
  | "http"
  | "rpc"
  | "malformed_response";

export class HeliusTransactionProviderError extends Error {
  constructor(
    readonly category: HeliusTransactionErrorCategory,
    message: string,
    readonly rpcCode: number | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "HeliusTransactionProviderError";
  }
}

export type HeliusTransactionResult =
  | { status: "provider_result_null" }
  | { status: "returned"; transaction: JsonObject };

/** One-request Helius getTransaction adapter shared by the diagnostic probe and production evidence path. */
export async function getHeliusTransaction(
  signature: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS,
): Promise<HeliusTransactionResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new HeliusTransactionProviderError("configuration", "Helius request timeout is invalid.");
  }
  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new HeliusTransactionProviderError(
      "configuration",
      "HELIUS_API_KEY is not configured.",
    );
  }

  const endpoint = `${HELIUS_MAINNET_RPC_URL}?api-key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: RPC_REQUEST_ID,
        method: "getTransaction",
        params: [signature, {
          encoding: "json",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        }],
      }),
    });

    if (!response.ok) {
      throw new HeliusTransactionProviderError(
        "http",
        "Helius transaction HTTP request failed.",
        null,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new HeliusTransactionProviderError("request_timeout", "Helius transaction request timed out.");
      }
      throw new HeliusTransactionProviderError("malformed_response", "Helius returned malformed transaction JSON.");
    }

    if (!isJsonObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== RPC_REQUEST_ID) {
      throw new HeliusTransactionProviderError("malformed_response", "Helius returned a malformed transaction JSON-RPC response.");
    }
    if ("error" in payload) {
      const error = payload.error;
      if (isJsonObject(error) && typeof error.code === "number" && Number.isSafeInteger(error.code)) {
        throw new HeliusTransactionProviderError("rpc", "Helius returned a JSON-RPC transaction error.", error.code);
      }
      throw new HeliusTransactionProviderError("malformed_response", "Helius returned a malformed JSON-RPC transaction error.");
    }
    if (!("result" in payload)) {
      throw new HeliusTransactionProviderError("malformed_response", "Helius omitted the transaction result.");
    }
    if (payload.result === null) return { status: "provider_result_null" };
    if (!isJsonObject(payload.result)) {
      throw new HeliusTransactionProviderError("malformed_response", "Helius returned a malformed transaction result.");
    }
    return { status: "returned", transaction: payload.result };
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new HeliusTransactionProviderError("request_timeout", "Helius transaction request timed out.");
    }
    if (error instanceof HeliusTransactionProviderError) throw error;
    throw new HeliusTransactionProviderError("transport", "Helius transaction request failed.");
  } finally {
    clearTimeout(timeout);
  }
}
