import type { EvmChain } from "../../types/evmToken";
import type { EvmHolderProviderErrorCategory } from "../../types/evmHolders";

const PROVIDER_SLUGS: Readonly<Record<EvmChain, "base-mainnet" | "eth-mainnet">> = {
  base: "base-mainnet",
  ethereum: "eth-mainnet",
};
const BASE_URL = "https://api.covalenthq.com/v1";
const MAX_TIMEOUT_MS = 2_147_483_647;

type JsonObject = Record<string, unknown>;

export class GoldRushHolderProviderError extends Error {
  constructor(
    readonly category: EvmHolderProviderErrorCategory,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "GoldRushHolderProviderError";
  }
}

export interface GoldRushHolderPageRequest {
  chain: EvmChain;
  tokenAddress: string;
  blockHeight: string;
  pageNumber: number;
  pageSize: 100;
  timeoutMs: number;
}

export function getGoldRushProviderChainSlug(chain: EvmChain): "base-mainnet" | "eth-mainnet" {
  if (chain !== "base" && chain !== "ethereum") {
    throw new GoldRushHolderProviderError("configuration", "An explicitly supported EVM chain is required.");
  }
  return PROVIDER_SLUGS[chain];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Performs one authenticated page request and returns only the provider data envelope. */
export async function getGoldRushHolderPage(
  request: GoldRushHolderPageRequest,
  options: { fetchImpl?: typeof fetch; onRequestStart?: () => void } = {},
): Promise<unknown> {
  if (request.chain !== "base" && request.chain !== "ethereum") {
    throw new GoldRushHolderProviderError("configuration", "An explicitly supported EVM chain is required.");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > MAX_TIMEOUT_MS) {
    throw new GoldRushHolderProviderError("configuration", "GoldRush request timeout is invalid.");
  }
  if (!Number.isSafeInteger(request.pageNumber) || request.pageNumber < 0) {
    throw new GoldRushHolderProviderError("configuration", "GoldRush page number is invalid.");
  }
  const apiKey = process.env.GOLDRUSH_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new GoldRushHolderProviderError("configuration", "GOLDRUSH_API_KEY is not configured.");
  }

  // Keep provider-specific chain routing inside this adapter.
  const providerSlug = getGoldRushProviderChainSlug(request.chain);
  const url = new URL(`${BASE_URL}/${providerSlug}/tokens/${request.tokenAddress}/token_holders_v2/`);
  url.searchParams.set("block-height", request.blockHeight);
  url.searchParams.set("page-number", String(request.pageNumber));
  url.searchParams.set("page-size", String(request.pageSize));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    // Count at the adapter boundary, immediately before invoking the network implementation.
    options.onRequestStart?.();
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new GoldRushHolderProviderError("http", "GoldRush HTTP request failed.", response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw new GoldRushHolderProviderError("transport", "GoldRush request timed out.");
      throw new GoldRushHolderProviderError("malformed_response", "GoldRush returned malformed JSON.");
    }
    if (!isObject(payload)) {
      throw new GoldRushHolderProviderError("malformed_response", "GoldRush returned a malformed response envelope.");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "error") && typeof payload.error !== "boolean") {
      throw new GoldRushHolderProviderError("malformed_response", "GoldRush returned malformed provider status fields.");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "error_message") && payload.error_message !== null && typeof payload.error_message !== "string") {
      throw new GoldRushHolderProviderError("malformed_response", "GoldRush returned malformed provider status fields.");
    }
    const providerError = payload.error === true
      || isNonEmptyString(payload.error_message)
      || (payload.error_code !== null && payload.error_code !== undefined && payload.error_code !== "");
    if (providerError) {
      throw new GoldRushHolderProviderError("provider", "GoldRush reported a provider error.");
    }
    if (!isObject(payload.data)) {
      throw new GoldRushHolderProviderError("malformed_response", "GoldRush omitted its data object.");
    }
    return payload.data;
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new GoldRushHolderProviderError("transport", "GoldRush request timed out.");
    if (error instanceof GoldRushHolderProviderError) throw error;
    throw new GoldRushHolderProviderError("transport", "GoldRush request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

/** Used by execution preflight so missing credentials do not count as network requests. */
export function isGoldRushConfigured(): boolean {
  const apiKey = process.env.GOLDRUSH_API_KEY;
  return apiKey !== undefined && apiKey.trim() !== "";
}
