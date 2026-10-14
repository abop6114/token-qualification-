import { observeProviderRequest, type SolanaProviderRequestObservationContext } from "../providerRequestObservation";
import { SolanaExecutionCancelledError } from "../../types/solanaTrustedExecutionContext";
import { createSolanaRequestAbortScope } from "./solanaRequestAbortScope";

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
  observationContext?: SolanaProviderRequestObservationContext,
  callerSignal?: AbortSignal,
): Promise<HeliusTransactionResult> {
  if (callerSignal?.aborted) throw new SolanaExecutionCancelledError();
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
  const scope = createSolanaRequestAbortScope(timeoutMs, callerSignal);
  let requestInvoked = false;
  try {
    return await observeProviderRequest(
      observationContext,
      { section: "transaction_enrichment", provider: "helius", operation: "getTransaction" },
      async () => {
        if (scope.cause === "caller_cancelled") throw new SolanaExecutionCancelledError(false);
        requestInvoked = true;
        try {
          return await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: scope.signal,
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
        } catch (error: unknown) {
          if (scope.isCallerAbort(error)) throw new SolanaExecutionCancelledError(requestInvoked);
          if (scope.isTimedOut()) throw new HeliusTransactionProviderError("request_timeout", "Helius transaction request timed out.");
          throw new HeliusTransactionProviderError("transport", "Helius transaction request failed.");
        }
      },
      async (response) => {
        if (scope.isTimedOut()) throw new HeliusTransactionProviderError("request_timeout", "Helius transaction request timed out.");
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
        } catch (error: unknown) {
          if (scope.isCallerAbort(error)) throw new SolanaExecutionCancelledError(requestInvoked);
          if (scope.isTimedOut()) {
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
      },
      (error, responseReceived) => {
        if (error instanceof SolanaExecutionCancelledError) return error.requestAttempted ? "request_cancelled" : null;
        if (scope.isTimedOut()) return "request_timeout";
        if (error instanceof HeliusTransactionProviderError) {
          if (error.category === "request_timeout") return responseReceived ? "malformed_response" : "transport_error";
          if (error.category === "http") return "http_error";
          if (error.category === "rpc") return "rpc_error";
          if (error.category === "malformed_response") return "malformed_response";
          if (error.category === "transport") return "transport_error";
        }
        return responseReceived ? "malformed_response" : "transport_error";
      },
    );
  } catch (error: unknown) {
    if (error instanceof SolanaExecutionCancelledError) throw error;
    if (scope.isTimedOut()) {
      throw new HeliusTransactionProviderError("request_timeout", "Helius transaction request timed out.");
    }
    if (error instanceof HeliusTransactionProviderError) throw error;
    throw new HeliusTransactionProviderError("transport", "Helius transaction request failed.");
  } finally {
    scope.dispose();
  }
}
