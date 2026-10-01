import type { SolanaHolderStructure } from "../types/holders";
import type { SolanaHistoricalAuthoritySelection } from "../types/solanaHistoricalAuthoritySelection";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

export const SOLANA_HISTORICAL_AUTHORITY_SELECTOR_VERSION = "solana-rank-coverage-v1" as const;

function nearestRankHalfUp(selectionPosition: number, candidateCount: number, selectedCount: number): number {
  if (selectedCount === 1) return 0;
  const denominator = BigInt(selectedCount - 1);
  const numerator = BigInt(selectionPosition) * BigInt(candidateCount - 1);
  // Round the exact rational rank to nearest integer; exact halves go upward.
  return Number((2n * numerator + denominator) / (2n * denominator));
}

export function selectSolanaHistoricalAuthorities(
  holderStructure: SolanaHolderStructure,
  configuredMaximumSelectedAuthorityCount: number,
): SolanaHistoricalAuthoritySelection {
  if (!Number.isSafeInteger(configuredMaximumSelectedAuthorityCount) || configuredMaximumSelectedAuthorityCount <= 0) {
    throw new Error("Maximum selected-authority count must be a positive safe integer.");
  }
  if (!isSolanaPublicKeySyntax(holderStructure.mintAddress)) {
    throw new Error("Holder snapshot mint address is malformed.");
  }
  if (!Array.isArray(holderStructure.rawOwnerAuthorities) || holderStructure.rawOwnerCount !== holderStructure.rawOwnerAuthorities.length) {
    throw new Error("Holder snapshot owner-authority count does not match its candidate records.");
  }

  const seenAuthorities = new Set<string>();
  const ranked = holderStructure.rawOwnerAuthorities.map((candidate) => {
    if (!isSolanaPublicKeySyntax(candidate.ownerAddress)) {
      throw new Error("Holder snapshot contains a malformed owner-authority address.");
    }
    if (seenAuthorities.has(candidate.ownerAddress)) {
      throw new Error("Holder snapshot contains a duplicate owner-authority address.");
    }
    seenAuthorities.add(candidate.ownerAddress);
    if (!/^[1-9][0-9]*$/.test(candidate.balanceRaw)) {
      throw new Error("Holder snapshot owner-authority balance must be a canonical positive raw integer string.");
    }
    return { ownerAddress: candidate.ownerAddress, balanceRaw: candidate.balanceRaw, balance: BigInt(candidate.balanceRaw) };
  }).sort((left, right) => {
    if (left.balance !== right.balance) return left.balance > right.balance ? -1 : 1;
    return left.ownerAddress < right.ownerAddress ? -1 : left.ownerAddress > right.ownerAddress ? 1 : 0;
  });

  const candidateAuthorityCount = ranked.length;
  const selectedAuthorityCount = Math.min(candidateAuthorityCount, configuredMaximumSelectedAuthorityCount);
  const selectedAuthorities = Array.from({ length: selectedAuthorityCount }, (_, selectionPosition) => {
    const sourceRank = candidateAuthorityCount <= configuredMaximumSelectedAuthorityCount
      ? selectionPosition
      : nearestRankHalfUp(selectionPosition, candidateAuthorityCount, selectedAuthorityCount);
    const candidate = ranked[sourceRank];
    return {
      authorityAddress: candidate.ownerAddress,
      balanceRaw: candidate.balanceRaw,
      sourceRank,
      selectionPosition,
      selectionReason: "rank_position" as const,
    };
  });

  return {
    selectorVersion: SOLANA_HISTORICAL_AUTHORITY_SELECTOR_VERSION,
    selectionBasis: "balance_descending_evenly_spaced_ranks_nearest_half_up",
    mintAddress: holderStructure.mintAddress,
    sourceHolderSnapshotFetchedAt: holderStructure.fetchedAt,
    candidateAuthorityCount,
    selectedAuthorityCount,
    configuredMaximumSelectedAuthorityCount,
    sourceCoverage: {
      enumeration: {
        completeness: holderStructure.enumeration.completeness,
        slotConsistency: holderStructure.enumeration.slotConsistency,
        pageCount: holderStructure.enumeration.pageCount,
        contextSlots: [...holderStructure.enumeration.contextSlots],
      },
      amountCoverage: {
        state: holderStructure.amountCoverage.state,
        reason: holderStructure.amountCoverage.reason,
        unsupportedExtensionTypes: [...holderStructure.amountCoverage.unsupportedExtensionTypes],
      },
    },
    selectedAuthorities,
  };
}
