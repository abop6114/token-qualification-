import type {
  OwnerAuthorityBalanceDistribution,
  OwnerAuthorityBalanceSnapshot,
  OwnerBalanceProfilePercentile,
  CumulativeOwnerBalanceProfilePoint,
  RepeatedBalanceFrequency,
} from "../types/ownerAuthorityBalanceDistribution";

const MAX_REPEATED_BALANCE_GROUPS = 25;
const PERCENTAGE_SCALE = 1_000_000n;
const QUANTILES = [
  [25, "p25"],
  [50, "p50"],
  [75, "p75"],
  [90, "p90"],
  [99, "p99"],
] as const;
const BALANCE_PROFILE_PERCENTILES: readonly OwnerBalanceProfilePercentile[] = [10, 25, 50, 75, 90, 99, 100];

function parseRawInteger(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Holder snapshot ${label} must be a non-negative raw integer string.`);
  }
  return BigInt(value);
}

function formatPercentage(numerator: bigint, denominator: bigint): string {
  const scaled = (numerator * 100n * PERCENTAGE_SCALE + denominator / 2n) / denominator;
  const whole = scaled / PERCENTAGE_SCALE;
  const fraction = (scaled % PERCENTAGE_SCALE).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeOwnerAuthorityBalanceDistribution(
  snapshot: OwnerAuthorityBalanceSnapshot,
): OwnerAuthorityBalanceDistribution {
  if (snapshot.rawOwnerCount !== snapshot.rawOwnerAuthorities.length) {
    throw new Error("Holder snapshot owner-authority count does not match its balance records.");
  }
  if (!Number.isInteger(snapshot.decimals) || snapshot.decimals < 0 || snapshot.decimals > 255) {
    throw new Error("Holder snapshot decimals are malformed.");
  }
  const currentSupply = parseRawInteger(snapshot.currentSupplyRaw, "current supply");

  const balances = snapshot.rawOwnerAuthorities.map((owner) => {
    const balance = parseRawInteger(owner.balanceRaw, "owner-authority balance");
    if (balance === 0n) throw new Error("Holder snapshot population must contain only positive owner-authority balances.");
    return balance;
  }).sort(compareBigInt);
  const observedPositiveBalance = balances.reduce((total, balance) => total + balance, 0n);
  const supplyInconsistent = observedPositiveBalance > currentSupply;

  const cumulativeOwnerBalanceProfile: CumulativeOwnerBalanceProfilePoint[] = [];
  let cumulativeBalance = 0n;
  let nextBalanceIndex = 0;
  for (const ownerPercentile of BALANCE_PROFILE_PERCENTILES) {
    const includedOwnerAuthorityCount = balances.length === 0
      ? 0
      : Math.ceil(ownerPercentile * balances.length / 100);
    while (nextBalanceIndex < includedOwnerAuthorityCount) {
      cumulativeBalance += balances[nextBalanceIndex];
      nextBalanceIndex += 1;
    }
    cumulativeOwnerBalanceProfile.push({
      ownerPercentile,
      includedOwnerAuthorityCount,
      cumulativeObservedBalanceRaw: cumulativeBalance.toString(),
      cumulativeObservedBalanceShare: observedPositiveBalance === 0n
        ? null
        : formatPercentage(cumulativeBalance, observedPositiveBalance),
    });
  }

  const frequencyByBalance = new Map<string, number>();
  for (const balance of balances) {
    const raw = balance.toString();
    frequencyByBalance.set(raw, (frequencyByBalance.get(raw) ?? 0) + 1);
  }

  const allRepeatedGroups: RepeatedBalanceFrequency[] = [...frequencyByBalance.entries()]
    .filter(([, count]) => count > 1)
    .map(([balanceRaw, ownerAuthorityCount]) => ({ balanceRaw, ownerAuthorityCount }))
    .sort((a, b) => b.ownerAuthorityCount - a.ownerAuthorityCount || compareBigInt(BigInt(a.balanceRaw), BigInt(b.balanceRaw)));
  const authoritiesInRepeatedBalanceGroups = allRepeatedGroups
    .reduce((sum, group) => sum + group.ownerAuthorityCount, 0);

  const nearestRank = (percentile: number): string | null => {
    if (balances.length === 0) return null;
    const rank = Math.ceil(percentile * balances.length / 100);
    return balances[rank - 1].toString();
  };
  const quantiles = Object.fromEntries(
    QUANTILES.map(([percentile, key]) => [key, nearestRank(percentile)]),
  ) as OwnerAuthorityBalanceDistribution["quantilesRaw"];

  const coverageState = snapshot.enumeration.completeness === "complete" &&
    snapshot.amountCoverage.state === "complete" &&
    !supplyInconsistent
    ? "complete"
    : "partial";
  const populationCount = balances.length;
  const repeatedBalanceGroups = allRepeatedGroups.slice(0, MAX_REPEATED_BALANCE_GROUPS);

  return {
    chain: snapshot.chain,
    assetAddress: snapshot.assetAddress,
    population: "positive_owner_authorities",
    observedOwnerAuthorityCount: populationCount,
    decimals: snapshot.decimals,
    currentSupplyRaw: snapshot.currentSupplyRaw,
    observedPositiveOwnerAuthorityBalanceRaw: observedPositiveBalance.toString(),
    cumulativeOwnerBalanceProfile,
    minimumBalanceRaw: balances[0]?.toString() ?? null,
    maximumBalanceRaw: balances.at(-1)?.toString() ?? null,
    medianBalanceRaw: quantiles.p50,
    quantilesRaw: quantiles,
    distinctBalanceCount: frequencyByBalance.size,
    repeatedBalanceGroupCount: allRepeatedGroups.length,
    authoritiesInRepeatedBalanceGroups,
    authorityShareInRepeatedBalanceGroups: populationCount === 0
      ? null
      : formatPercentage(BigInt(authoritiesInRepeatedBalanceGroups), BigInt(populationCount)),
    repeatedBalanceGroups,
    repeatedBalanceGroupsOmitted: allRepeatedGroups.length - repeatedBalanceGroups.length,
    coverage: {
      state: coverageState,
      source: "normalized_holder_snapshot",
      sourceSnapshotAt: snapshot.snapshotAt,
      enumerationCompleteness: snapshot.enumeration.completeness,
      slotConsistency: snapshot.enumeration.slotConsistency,
      pageCount: snapshot.enumeration.pageCount,
      contextSlots: [...snapshot.enumeration.contextSlots],
      amountCoverageState: snapshot.amountCoverage.state,
      amountCoverageReason: snapshot.amountCoverage.reason ?? (supplyInconsistent ? "supply_inconsistency" : null),
      unsupportedExtensionTypes: [...snapshot.amountCoverage.unsupportedExtensionTypes],
    },
  };
}
