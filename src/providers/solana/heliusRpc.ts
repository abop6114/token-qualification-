import { isSolanaPublicKeySyntax } from "../../validation/solanaAddress";

const HELIUS_MAINNET_RPC_URL = "https://mainnet.helius-rpc.com/";
const RPC_REQUEST_ID = 1;
const MAX_TIMEOUT_MS = 2_147_483_647;
export const HELIUS_ACCOUNT_DEFAULT_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type SolanaAccountProviderErrorCategory =
  | "configuration_error"
  | "request_timeout"
  | "transport_error"
  | "http_error"
  | "rpc_error"
  | "malformed_response";

const SAFE_MESSAGES: Record<SolanaAccountProviderErrorCategory, string> = {
  configuration_error: "Helius account request configuration is invalid.",
  request_timeout: "Helius account request timed out.",
  transport_error: "Helius account request failed.",
  http_error: "Helius account HTTP request failed.",
  rpc_error: "Helius returned an account JSON-RPC error.",
  malformed_response: "Helius returned a malformed account response.",
};

/** Sanitized provider-boundary failure. It intentionally retains no cause or provider message. */
export class SolanaAccountProviderError extends Error {
  constructor(
    readonly category: SolanaAccountProviderErrorCategory,
    readonly httpStatus: number | null = null,
    readonly rpcCode: number | null = null,
  ) {
    super(SAFE_MESSAGES[category]);
    this.name = "SolanaAccountProviderError";
  }

  toJSON(): { name: string; category: SolanaAccountProviderErrorCategory; message: string; httpStatus: number | null; rpcCode: number | null } {
    return { name: this.name, category: this.category, message: this.message, httpStatus: this.httpStatus, rpcCode: this.rpcCode };
  }
}

export interface RawSolanaAccount {
  /** The address requested by this getAccountInfo call; the RPC account value does not repeat its key. */
  requestedAddress: string;
  owner: string;
  dataBase64: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

/** Retrieves one Solana account. A valid missing account remains null. */
export async function getSolanaAccount(
  address: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HELIUS_ACCOUNT_DEFAULT_TIMEOUT_MS,
): Promise<RawSolanaAccount | null> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new SolanaAccountProviderError("configuration_error");
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new SolanaAccountProviderError("configuration_error");
  }

  const endpoint = `${HELIUS_MAINNET_RPC_URL}?api-key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  let timedOut = false;
  // Abort cancels the underlying fetch; prompt settlement still depends on fetch honoring its signal.
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: RPC_REQUEST_ID,
          method: "getAccountInfo",
          params: [address, { encoding: "base64" }],
        }),
      });
    } catch {
      if (timedOut) throw new SolanaAccountProviderError("request_timeout");
      throw new SolanaAccountProviderError("transport_error");
    }

    if (timedOut) throw new SolanaAccountProviderError("request_timeout");
    if (!response.ok) throw new SolanaAccountProviderError("http_error", response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (timedOut) throw new SolanaAccountProviderError("request_timeout");
      throw new SolanaAccountProviderError("malformed_response");
    }

    if (timedOut) throw new SolanaAccountProviderError("request_timeout");
    if (!isJsonObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== RPC_REQUEST_ID) {
      throw new SolanaAccountProviderError("malformed_response");
    }

    if ("error" in payload) {
      const rpcError = payload.error;
      if (isJsonObject(rpcError) && Number.isSafeInteger(rpcError.code)) {
        throw new SolanaAccountProviderError("rpc_error", null, rpcError.code as number);
      }
      throw new SolanaAccountProviderError("malformed_response");
    }

    const result = payload.result;
    if (
      !isJsonObject(result) ||
      !isJsonObject(result.context) ||
      !Number.isSafeInteger(result.context.slot) ||
      (result.context.slot as number) < 0 ||
      !("value" in result)
    ) {
      throw new SolanaAccountProviderError("malformed_response");
    }

    if (result.value === null) return null;
    if (!isJsonObject(result.value) || typeof result.value.owner !== "string" || !isSolanaPublicKeySyntax(result.value.owner)) {
      throw new SolanaAccountProviderError("malformed_response");
    }

    const accountData = result.value.data;
    if (
      !Array.isArray(accountData) ||
      typeof accountData[0] !== "string" ||
      accountData[1] !== "base64" ||
      !isCanonicalBase64(accountData[0])
    ) {
      throw new SolanaAccountProviderError("malformed_response");
    }

    return {
      requestedAddress: address,
      owner: result.value.owner,
      dataBase64: accountData[0],
    };
  } finally {
    clearTimeout(timeout);
  }
}
