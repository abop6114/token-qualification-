import { composeSolanaHolderAssessment, type SolanaHolderAssessment } from "./solanaHolderAssessment";
import type { SolanaTokenEvidenceReport } from "../types/solanaTokenEvidenceReport";
import type { SolanaAddressRoleMarketInput } from "../types/solanaAddressRoleEvidence";

export type SolanaHolderAssessmentFromReportResult =
  | { status: "present"; assessment: SolanaHolderAssessment }
  | { status: "not_attempted"; reason: "mint_unresolved" | "holder_evidence_unavailable" | "market_evidence_unsupported" };

/**
 * Internal bridge for existing typed evidence reports, not a parser for untrusted JSON.
 * Uses the report's snapshot as the holder source; does not recompute it from sibling fields.
 * Returns raw internal evidence separately, without changing report/public schemas or policy.
 * Existing composition validation errors propagate; no partial assessment is returned.
 */
export function deriveSolanaHolderAssessmentFromReport(report: SolanaTokenEvidenceReport): SolanaHolderAssessmentFromReportResult {
  if (report.schemaVersion !== "solana-token-evidence-report-v1" || report.chain !== "solana") {
    throw new Error("Unsupported holder assessment report contract.");
  }
  if (report.mint.status !== "present" || !report.mint.evidence.resolution.exists || !report.mint.evidence.resolution.isMint) {
    return { status: "not_attempted", reason: "mint_unresolved" };
  }
  const mintResolution = report.mint.evidence.resolution;
  if (report.assetAddress !== mintResolution.mintAddress) {
    throw new Error("Holder assessment report identity mismatch.");
  }
  if (report.holders.status !== "present") {
    return { status: "not_attempted", reason: "holder_evidence_unavailable" };
  }
  let marketInput: SolanaAddressRoleMarketInput;
  if (report.market.status === "present") {
    marketInput = { status: "available", snapshot: report.market.evidence };
  } else if (report.market.status === "unavailable" && report.market.reason === "market_provider_unavailable"
    && ["configuration_error", "request_timeout", "transport_error", "http_error", "malformed_response"].includes(report.market.errorCategory ?? "")) {
    marketInput = {
      status: "unavailable", provider: "dexscreener",
      reason: report.market.errorCategory === "malformed_response" ? "malformed_response" : "provider_error",
    };
  } else {
    // Do not invent provider failures for not-attempted or unfamiliar report states.
    return { status: "not_attempted", reason: "market_evidence_unsupported" };
  }
  return {
    status: "present",
    assessment: composeSolanaHolderAssessment({ mintResolution, holderSnapshot: report.holders.evidence.snapshotRecord, marketInput }),
  };
}
