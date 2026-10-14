import type { RawMarketPoolObservation, MarketVolumeWindow } from "../../types/market";
import { observeProviderRequest, type SolanaProviderRequestObservationContext } from "../providerRequestObservation";

const TOKEN_PAIRS_URL = "https://api.dexscreener.com/token-pairs/v1/solana/";
const VOLUME_WINDOWS: readonly MarketVolumeWindow[] = ["m5", "h1", "h6", "h24"];
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_TIMEOUT_MS = 2_147_483_647;
type JsonObject = Record<string, unknown>;

export const DEX_SCREENER_DEFAULT_TIMEOUT_MS = 30_000;

export type DexScreenerProviderErrorCategory =
  | "configuration_error"
  | "request_timeout"
  | "transport_error"
  | "http_error"
  | "malformed_response";

const SAFE_MESSAGES: Record<DexScreenerProviderErrorCategory, string> = {
  configuration_error: "DEX Screener request configuration is invalid.",
  request_timeout: "DEX Screener request timed out.",
  transport_error: "DEX Screener request failed.",
  http_error: "DEX Screener HTTP request failed.",
  malformed_response: "DEX Screener returned a malformed response.",
};

/** Sanitized provider-boundary failure; provider bodies and transport causes are discarded. */
export class DexScreenerProviderError extends Error {
  constructor(
    readonly category: DexScreenerProviderErrorCategory,
    readonly httpStatus: number | null = null,
  ) {
    super(SAFE_MESSAGES[category]);
    this.name = "DexScreenerProviderError";
  }

  toJSON(): { name: string; category: DexScreenerProviderErrorCategory; message: string; httpStatus: number | null } {
    return { name: this.name, category: this.category, message: this.message, httpStatus: this.httpStatus };
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFullDecimal(value: string): boolean {
  // `$` may match before a final line terminator; trim equality closes that JavaScript regex edge case.
  return value.trim() === value && DECIMAL_PATTERN.test(value);
}

function optionalNumeric(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && (!isFullDecimal(value) || !Number.isFinite(Number(value)))) ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new DexScreenerProviderError("malformed_response");
  }
  return value;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new DexScreenerProviderError("malformed_response");
  }
  return value;
}

/** Validates and normalizes a DEX Screener token-pairs payload without provider access. */
export function parseDexScreenerPairs(payload: unknown): RawMarketPoolObservation[] {
  if (!Array.isArray(payload)) {
    throw new DexScreenerProviderError("malformed_response");
  }

  return payload.map((entry) => {
    if (!isObject(entry) || !isObject(entry.baseToken) || !isObject(entry.quoteToken)) {
      throw new DexScreenerProviderError("malformed_response");
    }
    const volume = entry.volume === undefined || entry.volume === null ? {} : entry.volume;
    const liquidity = entry.liquidity === undefined || entry.liquidity === null ? {} : entry.liquidity;
    if (!isObject(volume) || !isObject(liquidity)) {
      throw new DexScreenerProviderError("malformed_response");
    }
    const volumeUsd: Partial<Record<MarketVolumeWindow, string | number | null>> = {};
    for (const window of VOLUME_WINDOWS) {
      if (Object.prototype.hasOwnProperty.call(volume, window)) {
        volumeUsd[window] = optionalNumeric(volume[window]);
      }
    }
    const fields = ["chainId", "pairAddress", "dexId"] as const;
    for (const field of fields) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new DexScreenerProviderError("malformed_response");
      }
    }
    if (typeof entry.baseToken.address !== "string" || typeof entry.quoteToken.address !== "string") {
      throw new DexScreenerProviderError("malformed_response");
    }

    return {
      chainId: entry.chainId as string,
      poolAddress: entry.pairAddress as string,
      dexId: entry.dexId as string,
      baseTokenAddress: entry.baseToken.address,
      quoteTokenAddress: entry.quoteToken.address,
      priceUsd: optionalNumeric(entry.priceUsd),
      marketCapUsd: optionalNumeric(entry.marketCap),
      fdvUsd: optionalNumeric(entry.fdv),
      liquidityUsd: optionalNumeric(liquidity.usd),
      volumeUsd,
      poolCreatedAt: optionalTimestamp(entry.pairCreatedAt),
    };
  });
}

/** Retrieves one Solana mint market snapshot. A valid empty response remains []. */
export async function getSolanaMintMarkets(
  mintAddress: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEX_SCREENER_DEFAULT_TIMEOUT_MS,
  observationContext?: SolanaProviderRequestObservationContext,
): Promise<RawMarketPoolObservation[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new DexScreenerProviderError("configuration_error");
  }

  const controller = new AbortController();
  let timedOut = false;
  // Abort cancels the underlying fetch; prompt settlement still depends on fetch honoring its signal.
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await observeProviderRequest(
      observationContext,
      { section: "market", provider: "dexscreener", operation: "tokenPairs" },
      async () => {
        try {
          return await fetchImpl(`${TOKEN_PAIRS_URL}${encodeURIComponent(mintAddress)}`, { signal: controller.signal });
        } catch {
          if (timedOut) throw new DexScreenerProviderError("request_timeout");
          throw new DexScreenerProviderError("transport_error");
        }
      },
      async (response) => {
        if (timedOut) throw new DexScreenerProviderError("request_timeout");
        if (!response.ok) throw new DexScreenerProviderError("http_error", response.status);

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          if (timedOut) throw new DexScreenerProviderError("request_timeout");
          throw new DexScreenerProviderError("malformed_response");
        }

        if (timedOut) throw new DexScreenerProviderError("request_timeout");
        return parseDexScreenerPairs(payload);
      },
      (error, responseReceived) => {
        if (error instanceof DexScreenerProviderError) {
          if (error.category === "request_timeout") return "request_timeout";
          if (error.category === "http_error") return "http_error";
          if (error.category === "malformed_response") return "malformed_response";
          if (error.category === "transport_error") return "transport_error";
        }
        return responseReceived ? "malformed_response" : "transport_error";
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}
