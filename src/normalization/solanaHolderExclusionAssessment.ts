import type { SolanaHolderStructure } from "../types/holders";
import type {
  SolanaAddressRoleEvidence,
  SolanaAddressRoleMarketSource,
  SolanaBaseAuthorityAddressRoleFinding,
  SolanaDexPoolAddressRoleFinding,
} from "../types/solanaAddressRoleEvidence";
import type { MarketProvenance } from "../types/market";
import type {
  SolanaAuthorityExclusionRuleAssessment,
  SolanaDexPoolExclusionRuleAssessment,
  SolanaExclusionDecision,
  SolanaHolderExclusionAssessment,
  SolanaHolderExclusionAssessmentInput,
} from "../types/solanaHolderExclusionAssessment";
import { decodeSolanaPublicKey, encodeSolanaPublicKey, isSolanaPublicKeySyntax } from "../validation/solanaAddress";

export const SOLANA_ADDRESS_EXCLUSION_POLICY_VERSION = "solana-address-exclusion-policy-v1" as const;

export class SolanaHolderExclusionAssessmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaHolderExclusionAssessmentInputError";
  }
}

function fail(message: string): never {
  throw new SolanaHolderExclusionAssessmentInputError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalAddress(value: unknown): value is string {
  if (typeof value !== "string" || !isSolanaPublicKeySyntax(value)) return false;
  const bytes = decodeSolanaPublicKey(value);
  return bytes !== null && encodeSolanaPublicKey(bytes) === value;
}

function sameNumberArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isSortedStringArray(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] <= value);
}

function sameMarketProvenance(left: unknown, right: unknown): boolean {
  return isObject(left) && isObject(right)
    && left.provider === right.provider
    && left.fetchedAt === right.fetchedAt
    && left.sourceUpdatedAt === right.sourceUpdatedAt;
}

function validateMarketProvenance(value: unknown): value is MarketProvenance {
  return isObject(value) && value.provider === "dexscreener"
    && typeof value.fetchedAt === "string" && Number.isFinite(Date.parse(value.fetchedAt))
    && (value.sourceUpdatedAt === null
      || typeof value.sourceUpdatedAt === "string" && Number.isFinite(Date.parse(value.sourceUpdatedAt)));
}

function validateHolder(holder: unknown): asserts holder is SolanaHolderStructure {
  if (!isObject(holder) || holder.chain !== "solana" || !canonicalAddress(holder.mintAddress)
    || typeof holder.fetchedAt !== "string" || !Number.isFinite(Date.parse(holder.fetchedAt))
    || !isObject(holder.enumeration) || holder.enumeration.completeness !== "complete"
    || holder.enumeration.slotConsistency !== "not_guaranteed"
    || !Number.isSafeInteger(holder.enumeration.pageCount) || (holder.enumeration.pageCount as number) < 1
    || !Array.isArray(holder.enumeration.contextSlots)
    || holder.enumeration.contextSlots.length !== holder.enumeration.pageCount
    || !holder.enumeration.contextSlots.every((slot) => Number.isSafeInteger(slot) && slot >= 0)
    || !isObject(holder.amountCoverage)
    || (holder.amountCoverage.state !== "complete" && holder.amountCoverage.state !== "partial")
    || !Array.isArray(holder.amountCoverage.unsupportedExtensionTypes)
    || !Number.isSafeInteger(holder.rawOwnerCount) || (holder.rawOwnerCount as number) < 0
    || !Array.isArray(holder.rawOwnerAuthorities)
    || holder.rawOwnerCount !== holder.rawOwnerAuthorities.length
    || typeof holder.currentMintSupplyRaw !== "string" || !/^(0|[1-9][0-9]*)$/.test(holder.currentMintSupplyRaw)
    || typeof holder.supplyDifferenceRaw !== "string") {
    fail("Solana holder structure is malformed.");
  }
  const seen = new Set<string>();
  let total = 0n;
  for (const row of holder.rawOwnerAuthorities) {
    if (!isObject(row) || !canonicalAddress(row.ownerAddress) || seen.has(row.ownerAddress)
      || typeof row.balanceRaw !== "string" || !/^[1-9][0-9]*$/.test(row.balanceRaw)) {
      fail("Solana holder structure contains malformed or duplicate positive owner authorities.");
    }
    seen.add(row.ownerAddress);
    total += BigInt(row.balanceRaw);
  }
  if (typeof holder.observedPositiveBalanceRaw !== "string"
    || holder.observedPositiveBalanceRaw !== total.toString(10)
    || holder.supplyDifferenceRaw !== (BigInt(holder.currentMintSupplyRaw) - total).toString(10)) {
    fail("Solana holder positive balances do not reconcile.");
  }
  const extensions = holder.amountCoverage.unsupportedExtensionTypes;
  if (!extensions.every((type) => Number.isInteger(type) && type >= 1 && type <= 65535)
    || new Set(extensions).size !== extensions.length
    || extensions.some((type, index) => index > 0 && extensions[index - 1] >= type)) {
    fail("Solana holder amount-coverage extension types are malformed.");
  }
  const supply = BigInt(holder.currentMintSupplyRaw);
  const supplyInconsistent = total > supply;
  if (holder.amountCoverage.state === "complete") {
    if (holder.amountCoverage.reason !== null || extensions.length !== 0 || supplyInconsistent) {
      fail("Complete Solana amount coverage contradicts its supporting evidence.");
    }
  } else {
    if (holder.amountCoverage.reason !== "unsupported_balance_affecting_extension"
      && holder.amountCoverage.reason !== "supply_inconsistency") {
      fail("Partial Solana amount coverage has an unsupported reason.");
    }
    if ((holder.amountCoverage.reason === "supply_inconsistency") !== supplyInconsistent
      || holder.amountCoverage.reason === "unsupported_balance_affecting_extension" && extensions.length === 0) {
      fail("Partial Solana amount coverage contradicts its balance or extension evidence.");
    }
  }
}

function validateMarketSource(value: unknown, mintAddress: string): asserts value is SolanaAddressRoleMarketSource {
  if (!isObject(value) || value.chain !== "solana" || value.mintAddress !== mintAddress) {
    fail("Solana market source identity is malformed or mismatched.");
  }
  if (value.status === "unavailable") {
    if (value.provider !== "dexscreener"
      || (value.reason !== "provider_error" && value.reason !== "malformed_response")) {
      fail("Solana unavailable market source is malformed.");
    }
    return;
  }
  if (value.status !== "available"
    || typeof value.snapshotAt !== "string" || !Number.isFinite(Date.parse(value.snapshotAt))
    || !validateMarketProvenance(value.provenance) || value.snapshotAt !== value.provenance.fetchedAt
    || !isNonNegativeSafeInteger(value.poolCount)
    || !isNonNegativeSafeInteger(value.validPoolAddressCount)
    || !isNonNegativeSafeInteger(value.invalidPoolCount)
    || value.validPoolAddressCount + value.invalidPoolCount !== value.poolCount
    || !Array.isArray(value.invalidPoolAddresses)
    || !value.invalidPoolAddresses.every((address) => typeof address === "string" && !canonicalAddress(address))
    || value.invalidPoolAddresses.length > value.invalidPoolCount
    || !isSortedStringArray(value.invalidPoolAddresses)
    || !Array.isArray(value.conflictingPoolAddresses)
    || !value.conflictingPoolAddresses.every(canonicalAddress)
    || new Set(value.conflictingPoolAddresses).size !== value.conflictingPoolAddresses.length
    || !isSortedStringArray(value.conflictingPoolAddresses)
    || value.conflictingPoolAddresses.length > value.validPoolAddressCount
    || (value.suppliedPoolAddressValidation !== "all_valid" && value.suppliedPoolAddressValidation !== "invalid_present")
    || value.suppliedPoolAddressValidation !== (value.invalidPoolCount === 0 ? "all_valid" : "invalid_present")) {
    fail("Solana available market source is malformed or internally inconsistent.");
  }
}

function validateAuthorityFinding(
  value: unknown,
  role: "base_mint_authority_address" | "base_freeze_authority_address",
  ownerAddress: string,
  source: SolanaAddressRoleEvidence["baseMintAuthoritySource"],
): asserts value is SolanaBaseAuthorityAddressRoleFinding {
  if (!isObject(value) || value.role !== role || value.ownerAuthorityAddress !== ownerAddress
    || value.basis !== "exact_address_equality" || value.sourceEvidence !== "solana_mint_resolution_base_field"
    || !isObject(value.sourceObservation) || value.sourceObservation.fetchedAt !== null
    || value.sourceObservation.contextSlot !== null) {
    fail("Solana base-authority role evidence is malformed or misattributed.");
  }
  if (value.status === "observed_match") {
    if (source.status !== "set" || value.authorityAddress !== source.address || value.authorityAddress !== ownerAddress) {
      fail("Solana base-authority match contradicts its source evidence.");
    }
    return;
  }
  if (value.status !== "no_match_in_examined_evidence"
    || value.authorityStatus !== source.status || value.authorityAddress !== source.address
    || (source.status === "set" && source.address === ownerAddress)) {
    fail("Solana base-authority no-match contradicts its source evidence.");
  }
}

function validateDexFinding(value: unknown, ownerAddress: string, evidence: SolanaAddressRoleEvidence): asserts value is SolanaDexPoolAddressRoleFinding {
  if (!isObject(value) || value.role !== "dexscreener_reported_pool_address"
    || value.ownerAuthorityAddress !== ownerAddress) {
    fail("Solana DEX role evidence is malformed or misattributed.");
  }
  if (value.status === "observed_match") {
    if (evidence.marketSource.status !== "available"
      || evidence.marketSource.conflictingPoolAddresses.includes(ownerAddress)
      || !Array.isArray(value.matches) || value.matches.length === 0
      || value.suppliedPoolAddressValidation !== evidence.marketSource.suppliedPoolAddressValidation) {
      fail("Solana DEX match evidence is malformed.");
    }
    for (const match of value.matches) {
      if (!isObject(match) || match.poolAddress !== ownerAddress || !canonicalAddress(match.poolAddress)
        || match.chain !== "solana" || match.mintAddress !== evidence.mintAddress
        || typeof match.dexId !== "string" || match.dexId.length === 0
        || !sameMarketProvenance(match.provenance, evidence.marketSource.provenance)) {
        fail("Solana DEX pool match does not identify the assessed subject and mint.");
      }
    }
    return;
  }
  if (value.status === "no_match_in_examined_evidence") {
    if (evidence.marketSource.status !== "available" || !Number.isSafeInteger(value.examinedPoolCount)
      || value.examinedPoolCount !== evidence.marketSource.validPoolAddressCount
      || evidence.marketSource.invalidPoolCount !== 0
      || evidence.marketSource.suppliedPoolAddressValidation !== "all_valid"
      || evidence.marketSource.invalidPoolAddresses.length !== 0
      || evidence.marketSource.conflictingPoolAddresses.length !== 0
      || !sameMarketProvenance(value.provenance, evidence.marketSource.provenance)) {
      fail("Solana DEX no-match is not supported by a clean examined snapshot.");
    }
    return;
  }
  if (value.status === "ambiguous") {
    if (evidence.marketSource.status !== "available" || value.poolAddress !== ownerAddress
      || !evidence.marketSource.conflictingPoolAddresses.includes(ownerAddress)
      || !Array.isArray(value.conflictingDexIds) || value.conflictingDexIds.length < 2
      || !value.conflictingDexIds.every((dexId) => typeof dexId === "string" && dexId.length > 0)
      || new Set(value.conflictingDexIds).size !== value.conflictingDexIds.length
      || !isSortedStringArray(value.conflictingDexIds)
      || !sameMarketProvenance(value.provenance, evidence.marketSource.provenance)) {
      fail("Solana DEX ambiguity is malformed.");
    }
    return;
  }
  if (value.status !== "unavailable"
    || (value.reason === "market_source_unavailable" && evidence.marketSource.status !== "unavailable")
    || (value.reason === "malformed_pool_address_present"
      && (evidence.marketSource.status !== "available" || evidence.marketSource.invalidPoolCount === 0
        || evidence.marketSource.conflictingPoolAddresses.includes(ownerAddress)))
    || (value.reason === "conflicting_pool_address_evidence"
      && (evidence.marketSource.status !== "available" || evidence.marketSource.invalidPoolCount !== 0
        || evidence.marketSource.conflictingPoolAddresses.length === 0
        || evidence.marketSource.conflictingPoolAddresses.includes(ownerAddress)))
    || (value.reason !== "market_source_unavailable" && value.reason !== "malformed_pool_address_present"
      && value.reason !== "conflicting_pool_address_evidence")) {
    fail("Solana DEX unavailable evidence contradicts its source state.");
  }
}

function validateRoleEvidence(value: unknown, holder: SolanaHolderStructure): asserts value is SolanaAddressRoleEvidence {
  if (!isObject(value) || value.schemaVersion !== "solana-address-role-evidence-v1"
    || value.chain !== "solana" || value.mintAddress !== holder.mintAddress
    || !Array.isArray(value.ownerAuthorities)
    || !isObject(value.holderSource) || value.holderSource.evidence !== "solana_holder_structure"
    || value.holderSource.observedPositiveOwnerAuthorityCount !== holder.rawOwnerCount
    || value.holderSource.fetchedAt !== holder.fetchedAt
    || !isObject(value.holderSource.enumeration)
    || value.holderSource.enumeration.completeness !== holder.enumeration.completeness
    || value.holderSource.enumeration.slotConsistency !== holder.enumeration.slotConsistency
    || value.holderSource.enumeration.pageCount !== holder.enumeration.pageCount
    || !sameNumberArray(value.holderSource.enumeration.contextSlots, holder.enumeration.contextSlots)
    || !isObject(value.holderSource.amountCoverage)
    || value.holderSource.amountCoverage.state !== holder.amountCoverage.state
    || value.holderSource.amountCoverage.reason !== holder.amountCoverage.reason
    || !sameNumberArray(value.holderSource.amountCoverage.unsupportedExtensionTypes, holder.amountCoverage.unsupportedExtensionTypes)
    || !isObject(value.marketSource) || value.marketSource.chain !== "solana"
    || value.marketSource.mintAddress !== holder.mintAddress
    || !isObject(value.baseMintAuthoritySource) || !isObject(value.baseFreezeAuthoritySource)) {
    fail("Solana address-role evidence has an incompatible chain, mint, or source identity.");
  }
  const evidence = value as unknown as SolanaAddressRoleEvidence;
  validateMarketSource(evidence.marketSource, holder.mintAddress);
  const holderAddresses = new Set(holder.rawOwnerAuthorities.map((row) => row.ownerAddress));
  for (const source of [evidence.baseMintAuthoritySource, evidence.baseFreezeAuthoritySource]) {
    if ((source.status !== "set" && source.status !== "unset")
      || (source.status === "set" && !canonicalAddress(source.address))
      || (source.status === "unset" && (source.address !== null || source.holderPopulationRelation !== "not_applicable"))
      || source.basis !== "solana_mint_resolution_base_field"
      || !isObject(source.sourceObservation) || source.sourceObservation.evidence !== "solana_mint_resolution"
      || source.sourceObservation.fetchedAt !== null || source.sourceObservation.contextSlot !== null
      || (source.status === "set" && source.holderPopulationRelation !== (holderAddresses.has(source.address) ? "observed_positive" : "not_observed_positive"))) {
      fail("Solana base-authority source evidence is malformed.");
    }
  }
  const roleAddresses = new Set<string>();
  for (const subject of evidence.ownerAuthorities) {
    if (!isObject(subject) || !canonicalAddress(subject.ownerAuthorityAddress)
      || roleAddresses.has(subject.ownerAuthorityAddress) || !holderAddresses.has(subject.ownerAuthorityAddress)
      || !Array.isArray(subject.findings) || subject.findings.length !== 3) {
      fail("Solana address-role subject set is malformed or differs from the holder population.");
    }
    roleAddresses.add(subject.ownerAuthorityAddress);
    validateAuthorityFinding(subject.findings[0], "base_mint_authority_address", subject.ownerAuthorityAddress, evidence.baseMintAuthoritySource);
    validateAuthorityFinding(subject.findings[1], "base_freeze_authority_address", subject.ownerAuthorityAddress, evidence.baseFreezeAuthoritySource);
    validateDexFinding(subject.findings[2], subject.ownerAuthorityAddress, evidence);
  }
  if (roleAddresses.size !== holderAddresses.size || [...holderAddresses].some((address) => !roleAddresses.has(address))) {
    fail("Solana address-role subject set does not exactly match positive holder authorities.");
  }
}

function authorityAssessment(finding: SolanaBaseAuthorityAddressRoleFinding): SolanaAuthorityExclusionRuleAssessment {
  if (finding.status === "observed_match") {
    return {
      ruleId: finding.role,
      decision: "unresolved",
      evidenceSufficiency: "insufficient",
      reasonCode: "matched_role_requires_more_evidence",
      finding: structuredClone(finding),
    };
  }
  return {
    ruleId: finding.role,
    decision: "retain",
    evidenceSufficiency: "sufficient",
    reasonCode: "no_supported_exclusion_rule_matched",
    finding: structuredClone(finding),
  };
}

function dexAssessment(finding: SolanaDexPoolAddressRoleFinding): SolanaDexPoolExclusionRuleAssessment {
  if (finding.status === "no_match_in_examined_evidence") {
    return {
      ruleId: finding.role,
      decision: "retain",
      evidenceSufficiency: "sufficient",
      reasonCode: "no_supported_exclusion_rule_matched",
      finding: structuredClone(finding),
    };
  }
  if (finding.status === "ambiguous") {
    return {
      ruleId: finding.role,
      decision: "unresolved",
      evidenceSufficiency: "conflicting",
      reasonCode: "conflicting_market_evidence",
      finding: structuredClone(finding),
    };
  }
  if (finding.status === "unavailable") {
    return {
      ruleId: finding.role,
      decision: "unresolved",
      evidenceSufficiency: finding.reason === "conflicting_pool_address_evidence" ? "conflicting" : "insufficient",
      reasonCode: finding.reason === "market_source_unavailable"
        ? "market_evidence_unavailable"
        : finding.reason === "conflicting_pool_address_evidence"
          ? "conflicting_market_evidence"
          : "market_evidence_malformed_or_incomplete",
      finding: structuredClone(finding),
    };
  }
  return {
    ruleId: finding.role,
    decision: "unresolved",
    evidenceSufficiency: "insufficient",
    reasonCode: "matched_role_requires_more_evidence",
    finding: structuredClone(finding),
  };
}

function aggregateDecision(decisions: readonly SolanaExclusionDecision[]): SolanaExclusionDecision {
  if (decisions.includes("exclude")) return "exclude";
  if (decisions.includes("unresolved")) return "unresolved";
  return "retain";
}

/** Applies a fixed, versioned assessment policy. It never removes or adjusts holder balances. */
export function assessSolanaHolderExclusions(
  input: SolanaHolderExclusionAssessmentInput,
): SolanaHolderExclusionAssessment {
  validateHolder(input?.holderStructure);
  validateRoleEvidence(input?.addressRoleEvidence, input.holderStructure);

  const holderByAddress = new Map(input.holderStructure.rawOwnerAuthorities.map((row) => [row.ownerAddress, row]));
  const roleByAddress = new Map(input.addressRoleEvidence.ownerAuthorities.map((row) => [row.ownerAuthorityAddress, row]));
  const subjects = [...holderByAddress.keys()].sort().map((subjectAddress) => {
    const findings = roleByAddress.get(subjectAddress)!.findings;
    const ruleAssessments: [
      SolanaAuthorityExclusionRuleAssessment,
      SolanaAuthorityExclusionRuleAssessment,
      SolanaDexPoolExclusionRuleAssessment,
    ] = [
      authorityAssessment(findings[0]),
      authorityAssessment(findings[1]),
      dexAssessment(findings[2]),
    ];
    return {
      subjectType: "positive_owner_authority" as const,
      subjectAddress,
      balanceRaw: holderByAddress.get(subjectAddress)!.balanceRaw,
      decision: aggregateDecision(ruleAssessments.map((item) => item.decision)),
      ruleAssessments,
    };
  });

  return {
    schemaVersion: "solana-holder-exclusion-assessment-v1",
    chain: "solana",
    mintAddress: input.holderStructure.mintAddress,
    policyVersion: SOLANA_ADDRESS_EXCLUSION_POLICY_VERSION,
    sourceEvidence: {
      holderFetchedAt: input.holderStructure.fetchedAt,
      holderEnumeration: structuredClone(input.holderStructure.enumeration),
      holderAmountCoverage: structuredClone(input.holderStructure.amountCoverage),
      addressRoleEvidenceSchemaVersion: input.addressRoleEvidence.schemaVersion,
      baseMintAuthoritySource: structuredClone(input.addressRoleEvidence.baseMintAuthoritySource),
      baseFreezeAuthoritySource: structuredClone(input.addressRoleEvidence.baseFreezeAuthoritySource),
      marketSource: structuredClone(input.addressRoleEvidence.marketSource),
    },
    subjects,
    summary: {
      subjectCount: subjects.length,
      excludeCount: subjects.filter((subject) => subject.decision === "exclude").length,
      retainCount: subjects.filter((subject) => subject.decision === "retain").length,
      unresolvedCount: subjects.filter((subject) => subject.decision === "unresolved").length,
    },
  };
}
