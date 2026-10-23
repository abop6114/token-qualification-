import { deriveSolanaAddressRoleEvidenceV2 } from "../normalization/solanaAddressRoleEvidence";
import { assessSolanaHolderExclusionsV2 } from "../normalization/solanaHolderExclusionAssessment";
import { deriveSolanaNotExcludedOwnerAuthorityPopulationV2 } from "../normalization/solanaNotExcludedOwnerAuthorityPopulation";
import { deriveSolanaNotExcludedOwnerAuthorityConcentrationV2 } from "../normalization/solanaNotExcludedOwnerAuthorityConcentration";
import type { SolanaMintResolution } from "../normalization/solanaMint";
import type { SolanaHolderSnapshotRecordV2 } from "../types/solanaHolderSnapshot";
import type { SolanaAddressRoleMarketInput } from "../types/solanaAddressRoleEvidence";

export interface SolanaHolderAssessmentInput {
  mintResolution: Extract<SolanaMintResolution, { exists: true; isMint: true }>;
  holderSnapshot: SolanaHolderSnapshotRecordV2;
  marketInput: SolanaAddressRoleMarketInput;
}

/** Internal evidence only: includes owner addresses/raw balances and is not public-report output. */
export interface SolanaHolderAssessment {
  schemaVersion: "solana-holder-assessment-v1";
  addressRoleEvidence: ReturnType<typeof deriveSolanaAddressRoleEvidenceV2>;
  exclusionAssessment: ReturnType<typeof assessSolanaHolderExclusionsV2>;
  population: ReturnType<typeof deriveSolanaNotExcludedOwnerAuthorityPopulationV2>;
  concentration: ReturnType<typeof deriveSolanaNotExcludedOwnerAuthorityConcentrationV2>;
}

/**
 * Composes existing V2 derivations without acquisition, policy changes, or public claims.
 * The existing policy retains unresolved subjects and does not establish qualified holders.
 * Requires a resolved mint and valid snapshot; unavailable market evidence is explicit.
 * Validation errors propagate from the existing stages; no partial result is returned.
 */
export function composeSolanaHolderAssessment(input: SolanaHolderAssessmentInput): SolanaHolderAssessment {
  const { mintResolution, holderSnapshot, marketInput } = input;
  const addressRoleEvidence = deriveSolanaAddressRoleEvidenceV2(mintResolution, holderSnapshot, marketInput);
  const exclusionAssessment = assessSolanaHolderExclusionsV2({ holderSnapshot, addressRoleEvidence });
  const population = deriveSolanaNotExcludedOwnerAuthorityPopulationV2(holderSnapshot, exclusionAssessment);
  const concentration = deriveSolanaNotExcludedOwnerAuthorityConcentrationV2(population);
  return { schemaVersion: "solana-holder-assessment-v1", addressRoleEvidence, exclusionAssessment, population, concentration };
}
