import { verifySolanaReferenceCaseArtifact } from "./solanaReferenceCase";
import { deriveSolanaHolderAssessmentFromReport, type SolanaHolderAssessmentFromReportResult } from "./solanaHolderAssessmentFromReport";
import type { SolanaReferenceCaseContentHash, SolanaReferenceCaseIntegrityResult } from "../types/solanaReferenceCase";

export interface SolanaHolderAssessmentReplay {
  source: {
    caseId: string;
    contentHash: SolanaReferenceCaseContentHash;
    integrity: SolanaReferenceCaseIntegrityResult["integrity"];
    provenance: SolanaReferenceCaseIntegrityResult["provenance"];
  };
  result: SolanaHolderAssessmentFromReportResult;
}

/**
 * Offline, internal replay of one canonical reference-case artifact.
 * Verification precedes derivation; errors propagate without a partial result.
 * Hash validity does not authenticate a capture or establish qualification.
 * Does not load/write files, acquire evidence, or alter the saved report/schema.
 */
export function replaySolanaHolderAssessment(serialized: string): SolanaHolderAssessmentReplay {
  const verified = verifySolanaReferenceCaseArtifact(serialized);
  return {
    source: {
      caseId: verified.referenceCase.caseId,
      contentHash: { ...verified.referenceCase.contentHash },
      integrity: verified.integrity,
      provenance: verified.provenance,
    },
    result: deriveSolanaHolderAssessmentFromReport(verified.referenceCase.evidenceReport),
  };
}
