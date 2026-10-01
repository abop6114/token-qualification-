import type { SolanaHolderStructure } from "../types/holders";
import type { SolanaHistoricalAuthoritySelection } from "../types/solanaHistoricalAuthoritySelection";
import type { SolanaHistoricalTimeWindow } from "../types/solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlan, SolanaHistoricalPlannedCandidate } from "../types/solanaHistoricalQueryPlan";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

export interface BuildSolanaHistoricalQueryPlanInput {
  holderStructure: SolanaHolderStructure;
  selection: SolanaHistoricalAuthoritySelection;
  requestedWindow: SolanaHistoricalTimeWindow;
  maxPagesPerAuthority: number;
  maxRecordsPerAuthority: number;
}

interface RankedCandidate {
  authorityAddress: string;
  balanceRaw: string;
  balance: bigint;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function sameNumberArray(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertWindow(window: SolanaHistoricalTimeWindow): void {
  if (
    !Number.isSafeInteger(window.fromUnixSecondsInclusive) || window.fromUnixSecondsInclusive < 0 ||
    !Number.isSafeInteger(window.toUnixSecondsExclusive) || window.toUnixSecondsExclusive < 0 ||
    window.toUnixSecondsExclusive <= window.fromUnixSecondsInclusive
  ) {
    throw new Error("Requested historical time window must use non-negative safe Unix seconds with an exclusive end after its start.");
  }
}

function safeProduct(left: number, right: number, label: string): number {
  const product = BigInt(left) * BigInt(right);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer range.`);
  }
  return Number(product);
}

export function buildSolanaHistoricalQueryPlan(
  input: BuildSolanaHistoricalQueryPlanInput,
): SolanaHistoricalQueryPlan {
  const { holderStructure, selection, requestedWindow, maxPagesPerAuthority, maxRecordsPerAuthority } = input;
  assertWindow(requestedWindow);
  assertPositiveSafeInteger(maxPagesPerAuthority, "maxPagesPerAuthority");
  assertPositiveSafeInteger(maxRecordsPerAuthority, "maxRecordsPerAuthority");
  assertPositiveSafeInteger(selection.configuredMaximumSelectedAuthorityCount, "Selection authority cap");

  if (!isSolanaPublicKeySyntax(holderStructure.mintAddress) || selection.mintAddress !== holderStructure.mintAddress) {
    throw new Error("Selection mint does not match the holder snapshot.");
  }
  if (selection.sourceHolderSnapshotFetchedAt !== holderStructure.fetchedAt) {
    throw new Error("Selection source snapshot time does not match the holder snapshot.");
  }
  if (!Array.isArray(holderStructure.rawOwnerAuthorities) || holderStructure.rawOwnerCount !== holderStructure.rawOwnerAuthorities.length) {
    throw new Error("Holder snapshot owner-authority count does not match its candidate records.");
  }

  const sourceCoverage = selection.sourceCoverage;
  if (
    sourceCoverage.enumeration.completeness !== holderStructure.enumeration.completeness ||
    sourceCoverage.enumeration.slotConsistency !== holderStructure.enumeration.slotConsistency ||
    sourceCoverage.enumeration.pageCount !== holderStructure.enumeration.pageCount ||
    !sameNumberArray(sourceCoverage.enumeration.contextSlots, holderStructure.enumeration.contextSlots) ||
    sourceCoverage.amountCoverage.state !== holderStructure.amountCoverage.state ||
    sourceCoverage.amountCoverage.reason !== holderStructure.amountCoverage.reason ||
    !sameNumberArray(sourceCoverage.amountCoverage.unsupportedExtensionTypes, holderStructure.amountCoverage.unsupportedExtensionTypes)
  ) {
    throw new Error("Selection source coverage does not match the holder snapshot.");
  }

  const seenCandidates = new Set<string>();
  const rankedCandidates: RankedCandidate[] = holderStructure.rawOwnerAuthorities.map((candidate) => {
    if (!isSolanaPublicKeySyntax(candidate.ownerAddress)) {
      throw new Error("Holder snapshot contains a malformed owner-authority address.");
    }
    if (seenCandidates.has(candidate.ownerAddress)) {
      throw new Error("Holder snapshot contains a duplicate owner-authority address.");
    }
    seenCandidates.add(candidate.ownerAddress);
    if (!/^[1-9][0-9]*$/.test(candidate.balanceRaw)) {
      throw new Error("Holder snapshot owner-authority balance must be a canonical positive raw integer string.");
    }
    return {
      authorityAddress: candidate.ownerAddress,
      balanceRaw: candidate.balanceRaw,
      balance: BigInt(candidate.balanceRaw),
    };
  }).sort((left, right) => {
    if (left.balance !== right.balance) return left.balance > right.balance ? -1 : 1;
    return left.authorityAddress < right.authorityAddress ? -1 : left.authorityAddress > right.authorityAddress ? 1 : 0;
  });

  const candidateAuthorityCount = rankedCandidates.length;
  if (
    selection.candidateAuthorityCount !== candidateAuthorityCount ||
    selection.selectedAuthorityCount !== selection.selectedAuthorities.length ||
    selection.selectedAuthorityCount > selection.configuredMaximumSelectedAuthorityCount ||
    selection.selectedAuthorityCount !== Math.min(candidateAuthorityCount, selection.configuredMaximumSelectedAuthorityCount)
  ) {
    throw new Error("Selection counts do not match the holder candidate frame and configured cap.");
  }

  const candidateByAddress = new Map(rankedCandidates.map((candidate, sourceRank) => [candidate.authorityAddress, { candidate, sourceRank }]));
  const selectedAddresses = new Set<string>();
  const selectedRanks = new Set<number>();
  const selectionPositions = new Set<number>();
  const selectedByAddress = new Map<string, { selectionPosition: number; selectionReason: "rank_position" }>();

  for (const selected of selection.selectedAuthorities) {
    if (selected.selectionReason !== "rank_position") {
      throw new Error("Selection contains an unsupported selection reason.");
    }
    const source = candidateByAddress.get(selected.authorityAddress);
    if (!source) throw new Error("Selected authority is absent from the holder candidate frame.");
    if (source.candidate.balanceRaw !== selected.balanceRaw) {
      throw new Error("Selected authority balance does not match the holder snapshot.");
    }
    if (!Number.isSafeInteger(selected.sourceRank) || selected.sourceRank !== source.sourceRank) {
      throw new Error("Selected authority source rank does not match the normalized holder candidate rank.");
    }
    if (!Number.isSafeInteger(selected.selectionPosition) || selected.selectionPosition < 0 || selected.selectionPosition >= selection.selectedAuthorityCount) {
      throw new Error("Selected authority has an invalid selection position.");
    }
    if (selectedAddresses.has(selected.authorityAddress) || selectedRanks.has(selected.sourceRank) || selectionPositions.has(selected.selectionPosition)) {
      throw new Error("Selection contains a duplicate authority, source rank, or selection position.");
    }
    selectedAddresses.add(selected.authorityAddress);
    selectedRanks.add(selected.sourceRank);
    selectionPositions.add(selected.selectionPosition);
    selectedByAddress.set(selected.authorityAddress, {
      selectionPosition: selected.selectionPosition,
      selectionReason: selected.selectionReason,
    });
  }

  for (let position = 0; position < selection.selectedAuthorityCount; position += 1) {
    if (!selectionPositions.has(position)) throw new Error("Selection positions must be contiguous from zero.");
  }

  const candidateAuthorities: SolanaHistoricalPlannedCandidate[] = rankedCandidates.map((candidate, sourceRank) => {
    const selected = selectedByAddress.get(candidate.authorityAddress);
    return selected
      ? {
          authorityAddress: candidate.authorityAddress,
          balanceRaw: candidate.balanceRaw,
          sourceRank,
          plannedDisposition: {
            status: "selected",
            selectionPosition: selected.selectionPosition,
            selectionReason: selected.selectionReason,
          },
        }
      : {
          authorityAddress: candidate.authorityAddress,
          balanceRaw: candidate.balanceRaw,
          sourceRank,
          plannedDisposition: { status: "not_selected" },
        };
  });

  const selectedAuthorityCount = selection.selectedAuthorityCount;
  return {
    planVersion: "solana-bounded-history-query-plan-v1",
    mintAddress: holderStructure.mintAddress,
    requestedWindow: {
      fromUnixSecondsInclusive: requestedWindow.fromUnixSecondsInclusive,
      toUnixSecondsExclusive: requestedWindow.toUnixSecondsExclusive,
    },
    maxPagesPerAuthority,
    maxRecordsPerAuthority,
    selectedAuthorityCount,
    maximumProviderRequests: safeProduct(selectedAuthorityCount, maxPagesPerAuthority, "Maximum provider request count"),
    maximumReturnedRecords: safeProduct(selectedAuthorityCount, maxRecordsPerAuthority, "Maximum returned record count"),
    sourceSelection: {
      selectorVersion: selection.selectorVersion,
      selectionBasis: selection.selectionBasis,
      configuredMaximumSelectedAuthorityCount: selection.configuredMaximumSelectedAuthorityCount,
      selectedAuthorityCount,
    },
    sourceHolder: {
      fetchedAt: holderStructure.fetchedAt,
      candidateAuthorityCount,
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
    candidateAuthorities,
  };
}
