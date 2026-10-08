import type { SolanaHolderSnapshotRecord } from "../types/solanaHolderSnapshot";
import type { SolanaHolderExclusionAssessment, SolanaExclusionDecision } from "../types/solanaHolderExclusionAssessment";
import type { SolanaNotExcludedOwnerAuthorityPopulationEvidence } from "../types/solanaNotExcludedOwnerAuthorityPopulation";
import { SOLANA_ADDRESS_EXCLUSION_POLICY_VERSION } from "./solanaHolderExclusionAssessment";
import { validateSolanaHolderSnapshotRecord } from "./solanaHolderSnapshotComparison";
import { decodeSolanaPublicKey, encodeSolanaPublicKey, isSolanaPublicKeySyntax } from "../validation/solanaAddress";

const ASSESSMENT_VERSION = "solana-holder-exclusion-assessment-v1" as const;
const DECISIONS: readonly SolanaExclusionDecision[] = ["exclude", "retain", "unresolved"];
const POSITIVE_RAW = /^[1-9][0-9]*$/;

export class SolanaNotExcludedOwnerAuthorityPopulationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaNotExcludedOwnerAuthorityPopulationInputError";
  }
}

function fail(message: string): never {
  throw new SolanaNotExcludedOwnerAuthorityPopulationInputError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalAddress(value: unknown): value is string {
  if (typeof value !== "string" || !isSolanaPublicKeySyntax(value)) return false;
  const decoded = decodeSolanaPublicKey(value);
  return decoded !== null && encodeSolanaPublicKey(decoded) === value;
}

function sameArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sortedStrings(value: unknown, predicate: (item: string) => boolean): value is string[] {
  return Array.isArray(value) && value.every((item, index) => typeof item === "string" && predicate(item)
    && (index === 0 || value[index - 1] <= item));
}

function sortedUniqueStrings(value: unknown, predicate: (item: string) => boolean): value is string[] {
  return sortedStrings(value, predicate) && new Set(value).size === value.length;
}

function sameEnumeration(left: unknown, right: unknown): boolean {
  return isObject(left) && isObject(right)
    && left.completeness === right.completeness
    && left.slotConsistency === right.slotConsistency
    && left.pageCount === right.pageCount
    && sameArray(left.contextSlots, right.contextSlots);
}

function sameCoverage(left: unknown, right: unknown): boolean {
  return isObject(left) && isObject(right)
    && left.state === right.state && left.reason === right.reason
    && sameArray(left.unsupportedExtensionTypes, right.unsupportedExtensionTypes);
}

function expectedOutcome(finding: Record<string, unknown>): {
  decision: SolanaExclusionDecision;
  evidenceSufficiency: string;
  reasonCode: string;
} {
  if (finding.status === "observed_match" || finding.status === "ambiguous") {
    return finding.status === "ambiguous"
      ? { decision: "unresolved", evidenceSufficiency: "conflicting", reasonCode: "conflicting_market_evidence" }
      : { decision: "unresolved", evidenceSufficiency: "insufficient", reasonCode: "matched_role_requires_more_evidence" };
  }
  if (finding.status === "no_match_in_examined_evidence") {
    return { decision: "retain", evidenceSufficiency: "sufficient", reasonCode: "no_supported_exclusion_rule_matched" };
  }
  if (finding.status === "unavailable") {
    if (finding.reason === "market_source_unavailable") {
      return { decision: "unresolved", evidenceSufficiency: "insufficient", reasonCode: "market_evidence_unavailable" };
    }
    if (finding.reason === "malformed_pool_address_present") {
      return { decision: "unresolved", evidenceSufficiency: "insufficient", reasonCode: "market_evidence_malformed_or_incomplete" };
    }
    if (finding.reason === "conflicting_pool_address_evidence") {
      return { decision: "unresolved", evidenceSufficiency: "conflicting", reasonCode: "conflicting_market_evidence" };
    }
  }
  fail("Assessment contains an unsupported current-policy finding.");
}

function validateFinding(
  finding: unknown,
  ruleId: string,
  address: string,
  assessment: SolanaHolderExclusionAssessment,
): asserts finding is Record<string, unknown> {
  if (!isObject(finding) || finding.ruleId !== ruleId || !isObject(finding.finding)
    || finding.finding.ownerAuthorityAddress !== address) {
    fail("Assessment rule finding is malformed or misattributed.");
  }
  const underlying = finding.finding;
  if (ruleId === "base_mint_authority_address" || ruleId === "base_freeze_authority_address") {
    const source = ruleId === "base_mint_authority_address"
      ? assessment.sourceEvidence.baseMintAuthoritySource
      : assessment.sourceEvidence.baseFreezeAuthoritySource;
    if (!isObject(source) || underlying.role !== ruleId || underlying.basis !== "exact_address_equality"
      || underlying.sourceEvidence !== "solana_mint_resolution_base_field"
      || !isObject(underlying.sourceObservation) || underlying.sourceObservation.fetchedAt !== null
      || underlying.sourceObservation.contextSlot !== null) {
      fail("Assessment base-authority finding is malformed.");
    }
    if (underlying.status === "observed_match") {
      if (source.status !== "set" || underlying.authorityAddress !== source.address || source.address !== address) {
        fail("Assessment base-authority match contradicts its source.");
      }
    } else if (underlying.status !== "no_match_in_examined_evidence"
      || underlying.authorityStatus !== source.status || underlying.authorityAddress !== source.address
      || (source.status === "set" && source.address === address)) {
      fail("Assessment base-authority no-match contradicts its source.");
    }
  } else {
    validateDexFinding(underlying, address, assessment);
  }
  const expected = expectedOutcome(underlying);
  if (finding.decision !== expected.decision || finding.evidenceSufficiency !== expected.evidenceSufficiency
    || finding.reasonCode !== expected.reasonCode) {
    fail("Assessment rule outcome contradicts its finding.");
  }
}

function validateDexFinding(
  finding: Record<string, unknown>,
  address: string,
  assessment: SolanaHolderExclusionAssessment,
): void {
  const source = assessment.sourceEvidence.marketSource as unknown as Record<string, unknown>;
  if (finding.role !== "dexscreener_reported_pool_address") fail("Assessment DEX finding has an invalid role.");
  if (finding.status === "no_match_in_examined_evidence") {
    if (source.status !== "available" || !Number.isSafeInteger(finding.examinedPoolCount)
      || finding.examinedPoolCount !== source.validPoolAddressCount || source.invalidPoolCount !== 0
      || source.suppliedPoolAddressValidation !== "all_valid"
      || !Array.isArray(source.invalidPoolAddresses) || source.invalidPoolAddresses.length !== 0
      || !Array.isArray(source.conflictingPoolAddresses) || source.conflictingPoolAddresses.length !== 0
      || !sameMarketProvenance(finding.provenance, source.provenance)) {
      fail("Assessment DEX no-match is not supported by a clean examined snapshot.");
    }
    return;
  }
  if (finding.status === "observed_match") {
    if (source.status !== "available" || !Array.isArray(finding.matches) || finding.matches.length === 0
      || finding.suppliedPoolAddressValidation !== source.suppliedPoolAddressValidation
      || !Array.isArray(source.conflictingPoolAddresses) || source.conflictingPoolAddresses.includes(address)) {
      fail("Assessment DEX match is malformed.");
    }
    for (const match of finding.matches) {
      if (!isObject(match) || match.poolAddress !== address || !canonicalAddress(match.poolAddress)
        || match.chain !== "solana" || match.mintAddress !== assessment.mintAddress
        || typeof match.dexId !== "string" || match.dexId.length === 0
        || !sameMarketProvenance(match.provenance, source.provenance)) {
        fail("Assessment DEX match contradicts subject or source identity.");
      }
    }
    return;
  }
  if (finding.status === "ambiguous") {
    if (source.status !== "available" || finding.poolAddress !== address
      || !Array.isArray(source.conflictingPoolAddresses) || !source.conflictingPoolAddresses.includes(address)
      || !Array.isArray(finding.conflictingDexIds) || finding.conflictingDexIds.length < 2
      || !finding.conflictingDexIds.every((id) => typeof id === "string" && id.length > 0)
      || new Set(finding.conflictingDexIds).size !== finding.conflictingDexIds.length
      || finding.conflictingDexIds.some((id, index, list) => index > 0 && list[index - 1] > id)
      || !sameMarketProvenance(finding.provenance, source.provenance)) {
      fail("Assessment DEX ambiguity is malformed.");
    }
    return;
  }
  if (finding.status !== "unavailable"
    || (finding.reason === "market_source_unavailable" && source.status !== "unavailable")
    || (finding.reason === "malformed_pool_address_present"
      && (source.status !== "available" || (source.invalidPoolCount as number) < 1
        || !Array.isArray(source.conflictingPoolAddresses) || source.conflictingPoolAddresses.includes(address)))
    || (finding.reason === "conflicting_pool_address_evidence"
      && (source.status !== "available" || source.invalidPoolCount !== 0
        || !Array.isArray(source.conflictingPoolAddresses) || source.conflictingPoolAddresses.length < 1
        || source.conflictingPoolAddresses.includes(address)))
    || !["market_source_unavailable", "malformed_pool_address_present", "conflicting_pool_address_evidence"].includes(String(finding.reason))) {
    fail("Assessment DEX unavailable finding contradicts its source.");
  }
}

function sameMarketProvenance(left: unknown, right: unknown): boolean {
  const validDateOrNull = (value: unknown) => value === null
    || typeof value === "string" && Number.isFinite(Date.parse(value));
  return isObject(left) && isObject(right) && left.provider === "dexscreener"
    && left.provider === right.provider && left.fetchedAt === right.fetchedAt
    && Number.isFinite(Date.parse(String(left.fetchedAt)))
    && validDateOrNull(left.sourceUpdatedAt) && left.sourceUpdatedAt === right.sourceUpdatedAt;
}

function validateAssessment(
  assessment: unknown,
  snapshot: SolanaHolderSnapshotRecord["snapshot"],
): asserts assessment is SolanaHolderExclusionAssessment {
  if (!isObject(assessment) || assessment.schemaVersion !== ASSESSMENT_VERSION
    || assessment.chain !== "solana" || assessment.mintAddress !== snapshot.mintAddress
    || assessment.policyVersion !== SOLANA_ADDRESS_EXCLUSION_POLICY_VERSION
    || !isObject(assessment.sourceEvidence) || !Array.isArray(assessment.subjects)
    || !isObject(assessment.summary)) {
    fail("Exclusion assessment schema, identity, or policy is invalid.");
  }
  const source = assessment.sourceEvidence;
  if (source.holderFetchedAt !== snapshot.fetchedAt
    || !sameEnumeration(source.holderEnumeration, snapshot.enumeration)
    || !sameCoverage(source.holderAmountCoverage, snapshot.amountCoverage)
    || source.addressRoleEvidenceSchemaVersion !== "solana-address-role-evidence-v1"
    || !isObject(source.marketSource) || source.marketSource.chain !== "solana"
    || source.marketSource.mintAddress !== snapshot.mintAddress
    || !isObject(source.baseMintAuthoritySource) || !isObject(source.baseFreezeAuthoritySource)) {
    fail("Exclusion assessment source metadata does not match the holder snapshot.");
  }
  const holderAddresses = new Set(snapshot.rawOwnerAuthorities.map((row) => row.ownerAddress));
  for (const authority of [source.baseMintAuthoritySource, source.baseFreezeAuthoritySource]) {
    if ((authority.status !== "set" && authority.status !== "unset")
      || (authority.status === "set" && !canonicalAddress(authority.address))
      || (authority.status === "set" && authority.holderPopulationRelation !== (holderAddresses.has(authority.address as string) ? "observed_positive" : "not_observed_positive"))
      || (authority.status === "unset" && (authority.address !== null || authority.holderPopulationRelation !== "not_applicable"))
      || authority.basis !== "solana_mint_resolution_base_field"
      || !isObject(authority.sourceObservation) || authority.sourceObservation.evidence !== "solana_mint_resolution"
      || authority.sourceObservation.fetchedAt !== null || authority.sourceObservation.contextSlot !== null) {
      fail("Exclusion assessment authority source metadata is malformed.");
    }
  }
  validateMarketSource(source.marketSource, snapshot.mintAddress);

  const holderRows = new Map(snapshot.rawOwnerAuthorities.map((row) => [row.ownerAddress, row.balanceRaw]));
  const seen = new Set<string>();
  const totals = new Map<SolanaExclusionDecision, { count: number; balance: bigint }>(
    DECISIONS.map((decision) => [decision, { count: 0, balance: 0n }]),
  );
  for (const subject of assessment.subjects) {
    if (!isObject(subject) || subject.subjectType !== "positive_owner_authority"
      || !canonicalAddress(subject.subjectAddress) || seen.has(subject.subjectAddress)
      || !holderRows.has(subject.subjectAddress) || typeof subject.balanceRaw !== "string"
      || !POSITIVE_RAW.test(subject.balanceRaw) || holderRows.get(subject.subjectAddress) !== subject.balanceRaw
      || !DECISIONS.includes(subject.decision as SolanaExclusionDecision)
      || !Array.isArray(subject.ruleAssessments) || subject.ruleAssessments.length !== 3) {
      fail("Exclusion assessment subject set or balance does not exactly match the holder snapshot.");
    }
    seen.add(subject.subjectAddress);
    const rules = subject.ruleAssessments;
    validateFinding(rules[0], "base_mint_authority_address", subject.subjectAddress, assessment as unknown as SolanaHolderExclusionAssessment);
    validateFinding(rules[1], "base_freeze_authority_address", subject.subjectAddress, assessment as unknown as SolanaHolderExclusionAssessment);
    validateFinding(rules[2], "dexscreener_reported_pool_address", subject.subjectAddress, assessment as unknown as SolanaHolderExclusionAssessment);
    const ruleDecisions = rules.map((rule) => (rule as unknown as Record<string, unknown>).decision as SolanaExclusionDecision);
    const aggregate = ruleDecisions.includes("exclude") ? "exclude"
      : ruleDecisions.includes("unresolved") ? "unresolved" : "retain";
    if (subject.decision !== aggregate) fail("Exclusion assessment aggregate decision contradicts its rule decisions.");
    // The current policy has no exclusion-producing rule; a forged exclusion is invalid.
    if (subject.decision === "exclude" || ruleDecisions.includes("exclude")) {
      fail("The current exclusion policy cannot produce exclude decisions.");
    }
    const total = totals.get(subject.decision as SolanaExclusionDecision)!;
    total.count += 1;
    total.balance += BigInt(subject.balanceRaw);
  }
  if (seen.size !== holderRows.size || [...holderRows.keys()].some((address) => !seen.has(address))) {
    fail("Exclusion assessment omits a positive holder subject.");
  }
  const summary = assessment.summary;
  if (summary.subjectCount !== assessment.subjects.length
    || summary.excludeCount !== totals.get("exclude")!.count
    || summary.retainCount !== totals.get("retain")!.count
    || summary.unresolvedCount !== totals.get("unresolved")!.count) {
    fail("Exclusion assessment summary does not reconcile with subject decisions.");
  }
}

function validateMarketSource(value: unknown, mintAddress: string): void {
  if (!isObject(value) || value.chain !== "solana" || value.mintAddress !== mintAddress) {
    fail("Exclusion assessment market source identity is malformed.");
  }
  if (value.status === "unavailable") {
    if (value.provider !== "dexscreener" || (value.reason !== "provider_error" && value.reason !== "malformed_response")) {
      fail("Exclusion assessment unavailable market source is malformed.");
    }
    return;
  }
  if (value.status !== "available" || typeof value.snapshotAt !== "string"
    || !Number.isFinite(Date.parse(value.snapshotAt)) || value.snapshotAt !== (value.provenance as Record<string, unknown> | undefined)?.fetchedAt
    || !sameMarketProvenance(value.provenance, value.provenance)
    || !Number.isSafeInteger(value.poolCount) || (value.poolCount as number) < 0
    || !Number.isSafeInteger(value.validPoolAddressCount) || (value.validPoolAddressCount as number) < 0
    || !Number.isSafeInteger(value.invalidPoolCount) || (value.invalidPoolCount as number) < 0
    || (value.validPoolAddressCount as number) + (value.invalidPoolCount as number) !== value.poolCount
    || !sortedStrings(value.invalidPoolAddresses, (address) => !canonicalAddress(address))
    || value.invalidPoolAddresses.length > (value.invalidPoolCount as number)
    || !sortedUniqueStrings(value.conflictingPoolAddresses, canonicalAddress)
    || value.conflictingPoolAddresses.length > (value.validPoolAddressCount as number)
    || (value.suppliedPoolAddressValidation !== "all_valid" && value.suppliedPoolAddressValidation !== "invalid_present")
    || value.suppliedPoolAddressValidation !== ((value.invalidPoolCount as number) === 0 ? "all_valid" : "invalid_present")) {
    fail("Exclusion assessment available market source is malformed.");
  }
}

/** Validates and partitions the observed positive owner-authority rows without adjusting balances. */
export function deriveSolanaNotExcludedOwnerAuthorityPopulation(
  snapshotRecord: SolanaHolderSnapshotRecord,
  assessment: SolanaHolderExclusionAssessment,
): SolanaNotExcludedOwnerAuthorityPopulationEvidence {
  try {
    validateSolanaHolderSnapshotRecord(snapshotRecord);
  } catch {
    fail("Holder snapshot record is invalid.");
  }
  if (snapshotRecord.snapshot.enumeration.completeness !== "complete") {
    fail("Holder snapshot enumeration completeness is unsupported.");
  }
  validateAssessment(assessment, snapshotRecord.snapshot);

  const sorted = [...assessment.subjects].sort((left, right) => left.subjectAddress < right.subjectAddress ? -1 : left.subjectAddress > right.subjectAddress ? 1 : 0);
  const totals = new Map<SolanaExclusionDecision, { count: number; balance: bigint }>(
    DECISIONS.map((decision) => [decision, { count: 0, balance: 0n }]),
  );
  let rawBalance = 0n;
  for (const subject of sorted) {
    const balance = BigInt(subject.balanceRaw);
    rawBalance += balance;
    const total = totals.get(subject.decision)!;
    total.count += 1;
    total.balance += balance;
  }
  const rawCount = sorted.length;
  const excluded = totals.get("exclude")!;
  const retained = totals.get("retain")!;
  const unresolved = totals.get("unresolved")!;
  const notExcludedCount = retained.count + unresolved.count;
  const notExcludedBalance = retained.balance + unresolved.balance;
  if (rawCount !== excluded.count + retained.count + unresolved.count
    || rawBalance !== excluded.balance + retained.balance + unresolved.balance
    || notExcludedCount !== retained.count + unresolved.count
    || notExcludedBalance !== retained.balance + unresolved.balance
    || rawBalance !== BigInt(snapshotRecord.snapshot.observedPositiveBalanceRaw)) {
    fail("Decision categories do not exactly partition the observed positive holder rows.");
  }

  return {
    schemaVersion: "solana-not-excluded-owner-authority-population-v1",
    chain: "solana",
    mintAddress: snapshotRecord.snapshot.mintAddress,
    policyVersion: SOLANA_ADDRESS_EXCLUSION_POLICY_VERSION,
    source: {
      holderSnapshotId: snapshotRecord.snapshotId,
      exclusionAssessmentSchemaVersion: ASSESSMENT_VERSION,
      holderFetchedAt: snapshotRecord.snapshot.fetchedAt,
      enumeration: structuredClone(snapshotRecord.snapshot.enumeration),
      amountCoverage: structuredClone(snapshotRecord.snapshot.amountCoverage),
      currentMintSupplyRaw: snapshotRecord.snapshot.currentMintSupplyRaw,
      supplyDifferenceRaw: snapshotRecord.snapshot.supplyDifferenceRaw,
    },
    subjects: sorted.map(({ subjectAddress, balanceRaw, decision }) => ({ subjectAddress, balanceRaw, decision })),
    raw: { subjectCount: rawCount, observedPositiveBalanceRaw: rawBalance.toString(10) },
    byDecision: Object.fromEntries(DECISIONS.map((decision) => {
      const total = totals.get(decision)!;
      return [decision, { subjectCount: total.count, observedBalanceRaw: total.balance.toString(10) }];
    })) as SolanaNotExcludedOwnerAuthorityPopulationEvidence["byDecision"],
    notExcluded: { subjectCount: notExcludedCount, observedBalanceRaw: notExcludedBalance.toString(10) },
    reconciliation: {
      status: "reconciled",
      basis: "decision_categories_partition_observed_positive_owner_authority_rows",
    },
  };
}
