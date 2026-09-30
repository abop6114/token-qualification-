import type { RawMarketPoolObservation, MarketVolumeWindow } from "../../types/market";

const TOKEN_PAIRS_URL = "https://api.dexscreener.com/token-pairs/v1/solana/";
const VOLUME_WINDOWS: readonly MarketVolumeWindow[] = ["m5", "h1", "h6", "h24"];
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumeric(value: unknown, field: string): string | number | null {
  if (value === undefined || value === null) return null;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && (!DECIMAL_PATTERN.test(value) || !Number.isFinite(Number(value)))) ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error(`DEX Screener returned a malformed ${field} value.`);
  }
  return value;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("DEX Screener returned a malformed pair creation timestamp.");
  }
  return value;
}

export function parseDexScreenerPairs(payload: unknown): RawMarketPoolObservation[] {
  if (!Array.isArray(payload)) {
    throw new Error("DEX Screener returned a malformed token-pairs response.");
  }

  return payload.map((entry, index) => {
    if (!isObject(entry) || !isObject(entry.baseToken) || !isObject(entry.quoteToken)) {
      throw new Error(`DEX Screener returned a malformed pool observation at index ${index}.`);
    }
    const volume = entry.volume === undefined || entry.volume === null ? {} : entry.volume;
    const liquidity = entry.liquidity === undefined || entry.liquidity === null ? {} : entry.liquidity;
    if (!isObject(volume) || !isObject(liquidity)) {
      throw new Error(`DEX Screener returned malformed pool metrics at index ${index}.`);
    }
    const volumeUsd: Partial<Record<MarketVolumeWindow, string | number | null>> = {};
    for (const window of VOLUME_WINDOWS) {
      if (Object.prototype.hasOwnProperty.call(volume, window)) {
        volumeUsd[window] = optionalNumeric(volume[window], `volume.${window}`);
      }
    }
    const fields = ["chainId", "pairAddress", "dexId"] as const;
    for (const field of fields) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`DEX Screener returned a malformed ${field} at index ${index}.`);
      }
    }
    if (typeof entry.baseToken.address !== "string" || typeof entry.quoteToken.address !== "string") {
      throw new Error(`DEX Screener returned malformed token identities at index ${index}.`);
    }

    return {
      chainId: entry.chainId as string,
      poolAddress: entry.pairAddress as string,
      dexId: entry.dexId as string,
      baseTokenAddress: entry.baseToken.address,
      quoteTokenAddress: entry.quoteToken.address,
      priceUsd: optionalNumeric(entry.priceUsd, "priceUsd"),
      marketCapUsd: optionalNumeric(entry.marketCap, "marketCap"),
      fdvUsd: optionalNumeric(entry.fdv, "fdv"),
      liquidityUsd: optionalNumeric(liquidity.usd, "liquidity.usd"),
      volumeUsd,
      poolCreatedAt: optionalTimestamp(entry.pairCreatedAt),
    };
  });
}

export async function getSolanaMintMarkets(mintAddress: string): Promise<RawMarketPoolObservation[]> {
  let response: Response;
  try {
    response = await fetch(`${TOKEN_PAIRS_URL}${encodeURIComponent(mintAddress)}`);
  } catch {
    throw new Error("DEX Screener request failed.");
  }
  if (!response.ok) {
    throw new Error(`DEX Screener HTTP request failed (status ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("DEX Screener returned malformed JSON.");
  }
  return parseDexScreenerPairs(payload);
}
