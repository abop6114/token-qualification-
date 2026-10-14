import { presentSolanaTokenEvidenceReport } from "./solanaTokenEvidencePresentation";
import {
  generateSolanaTokenEvidenceReport,
  type SolanaTokenEvidenceReportDependencies,
} from "./solanaTokenEvidenceReport";
import type { SolanaTokenEvidencePresentationV1 } from "../types/solanaTokenEvidencePresentation";
import type { GenerateSolanaTokenEvidenceReportRequest } from "../types/solanaTokenEvidenceReport";
import { throwIfSolanaExecutionCancelled } from "../types/solanaTrustedExecutionContext";
import type { SolanaTrustedExecutionContext } from "../types/solanaTrustedExecutionContext";

/** Generates one evidence report and returns its complete claim-safe presentation. */
export async function generateSolanaTokenEvidencePresentation(
  request: GenerateSolanaTokenEvidenceReportRequest,
  dependencies: Partial<SolanaTokenEvidenceReportDependencies> = {},
  context?: SolanaTrustedExecutionContext,
): Promise<SolanaTokenEvidencePresentationV1> {
  throwIfSolanaExecutionCancelled(context);
  const report = await generateSolanaTokenEvidenceReport(request, dependencies, context);
  throwIfSolanaExecutionCancelled(context);
  return presentSolanaTokenEvidenceReport(report);
}
