import type {
  MarketMetric,
  MarketProvenance,
  MarketVolumeWindow,
  NormalizedMarketSnapshot,
  NormalizedPoolMarket,
  RawMarketPoolObservation,
  SupportedMarketChain,
} from "../types/market";

const VOLUME_WINDOWS: readonly MarketVolumeWindow[] = ["m5", "h1", "h6", "h24"];
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function metric<T>(value: T | null, sourceField: string): MarketMetric<T> {
  return value === null
    ? { status: "unavailable", value: null, reason: "not_reported" }
    : { status: "available", value, basis: "provider_reported", sourceField };
}

function unavailable<T>(reason: "not_reported" | "orientation_unsupported"): MarketMetric<T> {
  return { status: "unavailable", value: null, reason };
}

function reportedDecimal(value: string | number | null, field: string): string | null {
  if (value === null) return null;

  const text = typeof value === "number" ? String(value) : value;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`DEX Screener returned a malformed ${field} value.`);
  }
  if (!DECIMAL_PATTERN.test(text) || !Number.isFinite(Number(text))) {
    throw new Error(`DEX Screener returned a malformed ${field} value.`);
  }
  return text;
}

function normalizePool(
  raw: RawMarketPoolObservation,
  mintAddress: string,
  provenance: MarketProvenance,
): NormalizedPoolMarket {
  const mintIsBaseToken = raw.baseTokenAddress === mintAddress;
  const counterTokenAddress = mintIsBaseToken
    ? raw.quoteTokenAddress
    : raw.baseTokenAddress;
  const volumeUsd = {} as Record<MarketVolumeWindow, MarketMetric<string>>;

  for (const window of VOLUME_WINDOWS) {
    const supplied = Object.prototype.hasOwnProperty.call(raw.volumeUsd, window)
      ? raw.volumeUsd[window]!
      : null;
    volumeUsd[window] = metric(reportedDecimal(supplied, `volume.${window}`), `volume.${window}`);
  }

  const createdAt = raw.poolCreatedAt === null ? null : new Date(raw.poolCreatedAt).toISOString();
  const tokenMetric = <T>(value: T | null, field: string): MarketMetric<T> =>
    mintIsBaseToken ? metric(value, field) : unavailable("orientation_unsupported");

  return {
    poolAddress: raw.poolAddress,
    dexId: raw.dexId,
    counterTokenAddress,
    poolCreatedAt: metric(createdAt, "pairCreatedAt"),
    priceUsd: tokenMetric(reportedDecimal(raw.priceUsd, "priceUsd"), "priceUsd"),
    marketCapUsd: tokenMetric(reportedDecimal(raw.marketCapUsd, "marketCap"), "marketCap"),
    fdvUsd: tokenMetric(reportedDecimal(raw.fdvUsd, "fdv"), "fdv"),
    liquidityUsd: metric(reportedDecimal(raw.liquidityUsd, "liquidity.usd"), "liquidity.usd"),
    volumeUsd,
    provenance,
  };
}

function semanticDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = reportedDecimal(value, "duplicate observation");
  if (normalized === null) return null;
  const [mantissa, exponentText] = normalized.toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = mantissa.split(".");
  let digits = `${whole}${fraction}`.replace(/^0+/, "");
  let scale = exponent - fraction.length;
  if (digits === "") return "0e0";
  while (digits.length > 1 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale += 1;
  }
  return `${digits}e${scale}`;
}

function semanticObservation(raw: RawMarketPoolObservation): string {
  const volumes = VOLUME_WINDOWS.map((window) => [
    window,
    semanticDecimal(Object.prototype.hasOwnProperty.call(raw.volumeUsd, window)
      ? raw.volumeUsd[window]
      : null),
  ]);
  return JSON.stringify([
    raw.chainId,
    raw.poolAddress,
    raw.dexId,
    raw.baseTokenAddress,
    raw.quoteTokenAddress,
    raw.poolCreatedAt,
    semanticDecimal(raw.priceUsd),
    semanticDecimal(raw.marketCapUsd),
    semanticDecimal(raw.fdvUsd),
    semanticDecimal(raw.liquidityUsd),
    volumes,
  ]);
}

function representationPreference(raw: RawMarketPoolObservation): string {
  const rawDecimal = (value: string | number | null | undefined): string | null =>
    value === null || value === undefined ? null : String(value);
  return JSON.stringify([
    raw.chainId,
    raw.poolAddress,
    raw.dexId,
    raw.baseTokenAddress,
    raw.quoteTokenAddress,
    raw.poolCreatedAt ?? null,
    rawDecimal(raw.priceUsd),
    rawDecimal(raw.marketCapUsd),
    rawDecimal(raw.fdvUsd),
    rawDecimal(raw.liquidityUsd),
    VOLUME_WINDOWS.map((window) => rawDecimal(raw.volumeUsd[window])),
  ]);
}

function decimalParts(value: string): { digits: string; scale: number } {
  const [mantissa, exponentText] = value.toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = mantissa.split(".");
  let digits = `${whole}${fraction}`.replace(/^0+/, "");
  let scale = exponent - fraction.length;
  while (digits.length > 1 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale += 1;
  }
  return { digits: digits || "0", scale };
}

function compareDecimals(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const aOrder = a.digits.length + a.scale;
  const bOrder = b.digits.length + b.scale;
  if (aOrder !== bOrder) return aOrder > bOrder ? 1 : -1;
  const length = Math.max(a.digits.length, b.digits.length);
  const aDigits = a.digits.padEnd(length, "0");
  const bDigits = b.digits.padEnd(length, "0");
  return aDigits > bDigits ? 1 : aDigits < bDigits ? -1 : 0;
}

function compareAvailable(left: MarketMetric<string>, right: MarketMetric<string>): number | null {
  if (left.status === "unavailable" || right.status === "unavailable") return null;
  return compareDecimals(left.value, right.value);
}

function comparePrimaryPool(left: NormalizedPoolMarket, right: NormalizedPoolMarket): number {
  const liquidityOrder = compareAvailable(left.liquidityUsd, right.liquidityUsd);
  if (liquidityOrder !== null && liquidityOrder !== 0) return -liquidityOrder;
  if (left.liquidityUsd.status !== right.liquidityUsd.status) {
    return left.liquidityUsd.status === "available" ? -1 : 1;
  }

  const volumeOrder = compareAvailable(left.volumeUsd.h24, right.volumeUsd.h24);
  if (volumeOrder !== null && volumeOrder !== 0) return -volumeOrder;
  if (left.volumeUsd.h24.status !== right.volumeUsd.h24.status) {
    return left.volumeUsd.h24.status === "available" ? -1 : 1;
  }
  return left.poolAddress < right.poolAddress ? -1 : left.poolAddress > right.poolAddress ? 1 : 0;
}

export function normalizeMarketSnapshot(
  chain: SupportedMarketChain,
  mintAddress: string,
  observations: RawMarketPoolObservation[],
  fetchedAt = new Date().toISOString(),
): NormalizedMarketSnapshot {
  const provenance: MarketProvenance = {
    provider: "dexscreener",
    fetchedAt,
    sourceUpdatedAt: null,
  };
  const eligible = observations.filter((item) =>
    item.chainId === chain &&
    (item.baseTokenAddress === mintAddress || item.quoteTokenAddress === mintAddress),
  );
  const uniqueByPool = new Map<string, RawMarketPoolObservation>();
  const canonicalByPool = new Map<string, string>();
  const preferenceByPool = new Map<string, string>();
  for (const item of eligible) {
    const key = `${item.chainId}:${item.poolAddress}`;
    const canonical = semanticObservation(item);
    const preference = representationPreference(item);
    const existing = canonicalByPool.get(key);
    if (existing !== undefined && existing !== canonical) {
      throw new Error(`Conflicting duplicate market observations for ${key}.`);
    }
    if (existing === undefined) {
      canonicalByPool.set(key, canonical);
      uniqueByPool.set(key, item);
      preferenceByPool.set(key, preference);
    } else if (preference < preferenceByPool.get(key)!) {
      // Equivalent representations can differ in formatting; select one deterministically.
      uniqueByPool.set(key, item);
      preferenceByPool.set(key, preference);
    }
  }

  const pools = Array.from(uniqueByPool.values())
    .map((item) => normalizePool(item, mintAddress, provenance))
    .sort(comparePrimaryPool);

  return {
    chain,
    mintAddress,
    snapshotAt: fetchedAt,
    tokenCreatedAt: { status: "unavailable", value: null, reason: "no_creation_evidence" },
    tokenAgeSeconds: { status: "unavailable", value: null, reason: "no_creation_evidence" },
    lifecycle: { state: "unknown", basis: "unknown", evidence: null },
    pools,
    primaryPoolAddress: pools[0]?.poolAddress ?? null,
    provenance,
  };
}
