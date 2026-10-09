import { isDeepStrictEqual } from "node:util";
import type { SolanaHolderStructure } from "../types/holders";
import type { SolanaHistoricalAuthoritySelection, SolanaHistoricalAuthoritySelectionV2 } from "../types/solanaHistoricalAuthoritySelection";
import type { SolanaHistoricalTimeWindow } from "../types/solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlan, SolanaHistoricalPlannedCandidate, SolanaHistoricalQueryPlanV2, SolanaHistoricalPlannedCandidateV2 } from "../types/solanaHistoricalQueryPlan";
import type { SolanaHolderSnapshotRecordV2 } from "../types/solanaHolderSnapshot";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";
import { selectSolanaHistoricalAuthoritiesV2 } from "./solanaHistoricalAuthoritySelector";
import { validateSolanaHolderSnapshotRecordV2 } from "./solanaHolderSnapshotComparison";

export interface BuildSolanaHistoricalQueryPlanInput {
  holderStructure: SolanaHolderStructure;
  selection: SolanaHistoricalAuthoritySelection;
  requestedWindow: SolanaHistoricalTimeWindow;
  maxPagesPerAuthority: number;
  maxRecordsPerAuthority: number;
}

export interface BuildSolanaHistoricalQueryPlanV2Input {
  snapshotRecord: SolanaHolderSnapshotRecordV2;
  selection: SolanaHistoricalAuthoritySelectionV2;
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

export function buildSolanaHistoricalQueryPlanV2(
  input: BuildSolanaHistoricalQueryPlanV2Input,
): SolanaHistoricalQueryPlanV2 {
  const { snapshotRecord, selection, requestedWindow, maxPagesPerAuthority, maxRecordsPerAuthority } = input;
  validateSolanaHolderSnapshotRecordV2(snapshotRecord);
  assertWindow(requestedWindow);
  assertPositiveSafeInteger(maxPagesPerAuthority, "maxPagesPerAuthority");
  assertPositiveSafeInteger(maxRecordsPerAuthority, "maxRecordsPerAuthority");
  assertPositiveSafeInteger(selection.configuredMaximumSelectedAuthorityCount, "Selection authority cap");

  const expectedSelection = selectSolanaHistoricalAuthoritiesV2(
    snapshotRecord,
    selection.configuredMaximumSelectedAuthorityCount,
  );
  if (!isDeepStrictEqual(selection, expectedSelection)) {
    throw new Error("V2 selection provenance, candidate frame, ranks, or selected authorities do not match the source snapshot.");
  }

  const rankedCandidates = snapshotRecord.snapshot.rawOwnerAuthorities.map((candidate) => ({
    authorityAddress: candidate.ownerAddress,
    balanceRaw: candidate.balanceRaw,
    balance: BigInt(candidate.balanceRaw),
  })).sort((left, right) => {
    if (left.balance !== right.balance) return left.balance > right.balance ? -1 : 1;
    return left.authorityAddress < right.authorityAddress ? -1 : left.authorityAddress > right.authorityAddress ? 1 : 0;
  });
  const selectedByAddress = new Map(selection.selectedAuthorities.map((candidate) => [candidate.authorityAddress, candidate]));
  const candidateAuthorities: SolanaHistoricalPlannedCandidateV2[] = rankedCandidates.map((candidate, observedCandidateFrameRank) => {
    const selected = selectedByAddress.get(candidate.authorityAddress);
    return selected
      ? {
          authorityAddress: candidate.authorityAddress,
          balanceRaw: candidate.balanceRaw,
          observedCandidateFrameRank,
          plannedDisposition: {
            status: "selected",
            selectionPosition: selected.selectionPosition,
            selectionReason: selected.selectionReason,
          },
        }
      : {
          authorityAddress: candidate.authorityAddress,
          balanceRaw: candidate.balanceRaw,
          observedCandidateFrameRank,
          plannedDisposition: { status: "not_selected" },
        };
  });

  const selectedAuthorityCount = selection.selectedAuthorityCount;
  return {
    planVersion: "solana-bounded-history-query-plan-v2",
    mintAddress: snapshotRecord.snapshot.mintAddress,
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
      snapshotSchemaVersion: snapshotRecord.schemaVersion,
      snapshotId: snapshotRecord.snapshotId,
      source: { ...snapshotRecord.source },
      mintAddress: snapshotRecord.snapshot.mintAddress,
      fetchedAt: snapshotRecord.snapshot.fetchedAt,
      acquisition: { ...snapshotRecord.acquisition },
      candidateAuthorityCount: selection.sourceHolder.candidateAuthorityCount,
      candidateFrameCompleteness: selection.sourceHolder.candidateFrameCompleteness,
      enumeration: {
        ...selection.sourceHolder.enumeration,
        contextSlots: [...selection.sourceHolder.enumeration.contextSlots],
      },
      amountCoverage: {
        ...selection.sourceHolder.amountCoverage,
        unsupportedExtensionTypes: [...selection.sourceHolder.amountCoverage.unsupportedExtensionTypes],
      },
    },
    candidateAuthorities,
  };
}

/** Validates a serialized V2 plan before execution or metric calculation. */
export function validateSolanaHistoricalQueryPlanV2(plan: SolanaHistoricalQueryPlanV2): void {
  if (plan.planVersion !== "solana-bounded-history-query-plan-v2") throw new Error("Unsupported Solana historical query plan version.");
  if (!isSolanaPublicKeySyntax(plan.mintAddress)) throw new Error("Query plan mint address is malformed.");
  assertWindow(plan.requestedWindow);
  assertPositiveSafeInteger(plan.maxPagesPerAuthority, "maxPagesPerAuthority");
  assertPositiveSafeInteger(plan.maxRecordsPerAuthority, "maxRecordsPerAuthority");
  const { sourceHolder, sourceSelection } = plan;
  if (
    sourceSelection.selectorVersion !== "solana-rank-coverage-v2" ||
    sourceSelection.selectionBasis !== "balance_descending_evenly_spaced_ranks_nearest_half_up" ||
    sourceHolder.snapshotSchemaVersion !== "solana-holder-snapshot-record-v2" ||
    !/^sha256:[0-9a-f]{64}$/.test(sourceHolder.snapshotId) ||
    sourceHolder.source.provider !== "helius" || sourceHolder.source.method !== "getProgramAccountsV2" || sourceHolder.source.commitment !== "finalized" ||
    sourceHolder.mintAddress !== plan.mintAddress ||
    typeof sourceHolder.fetchedAt !== "string" || !Number.isFinite(Date.parse(sourceHolder.fetchedAt))
  ) {
    throw new Error("V2 query plan source snapshot provenance is malformed.");
  }
  const acquisition = sourceHolder.acquisition;
  const enumeration = sourceHolder.enumeration;
  const amountCoverage = sourceHolder.amountCoverage;
  if (
    (acquisition.completeness !== "complete" && acquisition.completeness !== "partial") ||
    acquisition.configuredMaxPages !== 20 || acquisition.requestedPageSize !== 5000 ||
    !Number.isSafeInteger(enumeration.pageCount) || enumeration.pageCount <= 0 || enumeration.pageCount > 20 ||
    !Array.isArray(enumeration.contextSlots) || enumeration.contextSlots.length !== enumeration.pageCount ||
    enumeration.contextSlots.some((slot) => !Number.isSafeInteger(slot) || slot < 0) ||
    enumeration.slotConsistency !== "not_guaranteed" ||
    (enumeration.completeness !== "complete" && enumeration.completeness !== "partial") ||
    (amountCoverage.state !== "complete" && amountCoverage.state !== "partial") ||
    !Array.isArray(amountCoverage.unsupportedExtensionTypes) ||
    amountCoverage.unsupportedExtensionTypes.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 65535) ||
    amountCoverage.unsupportedExtensionTypes.some((value, index, values) => index > 0 && values[index - 1] >= value) ||
    (amountCoverage.reason !== null && amountCoverage.reason !== "unsupported_balance_affecting_extension" && amountCoverage.reason !== "supply_inconsistency")
  ) {
    throw new Error("V2 query plan source coverage or acquisition is malformed.");
  }
  if (
    (amountCoverage.state === "complete" && (amountCoverage.reason !== null || amountCoverage.unsupportedExtensionTypes.length > 0)) ||
    (amountCoverage.state === "partial" && amountCoverage.reason === null) ||
    (amountCoverage.reason === "unsupported_balance_affecting_extension" && amountCoverage.unsupportedExtensionTypes.length === 0)
  ) {
    throw new Error("V2 query plan amount coverage is contradictory.");
  }
  if (
    acquisition.completeness === "complete"
      ? enumeration.completeness !== "complete" || acquisition.stopReason !== "provider_terminated"
      : enumeration.completeness !== "partial" || !["page_cap", "request_timeout", "provider_error", "malformed_response"].includes(acquisition.stopReason) ||
        (acquisition.stopReason === "page_cap" ? enumeration.pageCount !== 20 : enumeration.pageCount >= 20)
  ) {
    throw new Error("V2 query plan acquisition contradicts enumeration completeness.");
  }
  const expectedFrameCompleteness = enumeration.completeness === "complete" && amountCoverage.state === "complete" ? "complete" : "partial";
  if (sourceHolder.candidateFrameCompleteness !== expectedFrameCompleteness) {
    throw new Error("V2 query plan candidate-frame completeness contradicts its source coverage.");
  }

  if (
    !Number.isSafeInteger(sourceHolder.candidateAuthorityCount) || sourceHolder.candidateAuthorityCount < 0 ||
    !Array.isArray(plan.candidateAuthorities) || plan.candidateAuthorities.length !== sourceHolder.candidateAuthorityCount ||
    !Number.isSafeInteger(sourceSelection.configuredMaximumSelectedAuthorityCount) || sourceSelection.configuredMaximumSelectedAuthorityCount <= 0
  ) {
    throw new Error("V2 query plan candidate frame or selection cap is malformed.");
  }
  const expectedSelectedCount = Math.min(sourceHolder.candidateAuthorityCount, sourceSelection.configuredMaximumSelectedAuthorityCount);
  if (
    plan.selectedAuthorityCount !== expectedSelectedCount || sourceSelection.selectedAuthorityCount !== expectedSelectedCount ||
    !Number.isSafeInteger(plan.selectedAuthorityCount) || plan.selectedAuthorityCount < 0
  ) {
    throw new Error("V2 query plan selected-authority counts are inconsistent.");
  }
  const expectedRanks = Array.from({ length: expectedSelectedCount }, (_, position) => sourceHolder.candidateAuthorityCount <= expectedSelectedCount
    ? position
    : expectedSelectedCount === 1
      ? 0
      : Number((2n * BigInt(position) * BigInt(sourceHolder.candidateAuthorityCount - 1) + BigInt(expectedSelectedCount - 1)) /
        (2n * BigInt(expectedSelectedCount - 1))));
  let previousBalance: bigint | null = null;
  let previousAddress: string | null = null;
  const seen = new Set<string>();
  for (let index = 0; index < plan.candidateAuthorities.length; index += 1) {
    const candidate = plan.candidateAuthorities[index];
    if (
      !isSolanaPublicKeySyntax(candidate.authorityAddress) || seen.has(candidate.authorityAddress) ||
      candidate.observedCandidateFrameRank !== index || !/^[1-9][0-9]*$/.test(candidate.balanceRaw)
    ) {
      throw new Error("V2 query plan candidate frame or observed frame rank is malformed.");
    }
    const balance = BigInt(candidate.balanceRaw);
    if (previousBalance !== null && (previousBalance < balance || (previousBalance === balance && (previousAddress as string) > candidate.authorityAddress))) {
      throw new Error("V2 query plan candidate frame is not deterministically ranked.");
    }
    const selectedPosition = expectedRanks.indexOf(index);
    if (selectedPosition >= 0) {
      if (candidate.plannedDisposition.status !== "selected" || candidate.plannedDisposition.selectionPosition !== selectedPosition || candidate.plannedDisposition.selectionReason !== "rank_position") {
        throw new Error("V2 query plan selected disposition does not match the selector algorithm.");
      }
    } else if (candidate.plannedDisposition.status !== "not_selected") {
      throw new Error("V2 query plan not-selected disposition is inconsistent.");
    }
    previousBalance = balance;
    previousAddress = candidate.authorityAddress;
    seen.add(candidate.authorityAddress);
  }
  if (
    plan.maximumProviderRequests !== safeProduct(plan.selectedAuthorityCount, plan.maxPagesPerAuthority, "Maximum provider request count") ||
    plan.maximumReturnedRecords !== safeProduct(plan.selectedAuthorityCount, plan.maxRecordsPerAuthority, "Maximum returned record count")
  ) {
    throw new Error("V2 query plan request or record bounds are inconsistent.");
  }
}
