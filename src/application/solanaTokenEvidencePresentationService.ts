import { presentSolanaTokenEvidenceReport } from "./solanaTokenEvidencePresentation";
import {
  generateSolanaTokenEvidenceReport,
  type SolanaTokenEvidenceReportDependencies,
} from "./solanaTokenEvidenceReport";
import type { SolanaTokenEvidencePresentationV1 } from "../types/solanaTokenEvidencePresentation";
import type { GenerateSolanaTokenEvidenceReportRequest } from "../types/solanaTokenEvidenceReport";

/** Generates one evidence report and returns its complete claim-safe presentation. */
export async function generateSolanaTokenEvidencePresentation(
  request: GenerateSolanaTokenEvidenceReportRequest,
  dependencies: Partial<SolanaTokenEvidenceReportDependencies> = {},
): Promise<SolanaTokenEvidencePresentationV1> {
  const report = await generateSolanaTokenEvidenceReport(request, dependencies);
  return presentSolanaTokenEvidenceReport(report);
}
