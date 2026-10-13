import type { OwnerAuthorityBalanceDistribution } from "./ownerAuthorityBalanceDistribution";
import type { SolanaHolderStructure, SolanaPartialHolderStructure } from "./holders";
import type { NormalizedMarketSnapshot } from "./market";
import type { SolanaToken2022MintExtensionInventory } from "./solanaToken2022MintExtensionInventory";
import type { SolanaHistoricalAuthoritySelectionV2 } from "./solanaHistoricalAuthoritySelection";
import type { SolanaHistoricalDescriptiveMetrics } from "./solanaHistoricalMetrics";
import type { SolanaHistoricalQueryPlanV2 } from "./solanaHistoricalQueryPlan";
import type { SolanaBoundedHistoricalSamplingEvidence } from "./solanaHistoricalSampling";
import type { SolanaHistoricalTransactionSelectionEvidence } from "./solanaHistoricalTransactionSelection";
import type { SolanaTransactionEnrichmentExecutionResult } from "./solanaTransactionEnrichment";
import type { SolanaTransactionEvidenceIntegrationEvidence } from "./solanaTransactionEvidenceIntegration";
import type { SolanaMintResolution } from "../normalization/solanaMint";
import type { SolanaHistoricalTimeWindow } from "./solanaHistoricalSampling";

export const SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION = "solana-token-evidence-report-v1" as const;

export type SolanaHistoricalReportRequest =
  | { status: "not_requested" }
  | { status: "requested"; requestedWindow: SolanaHistoricalTimeWindow };

export interface GenerateSolanaTokenEvidenceReportRequest {
  chain: "solana";
  assetAddress: string;
  historicalTransactions: SolanaHistoricalReportRequest;
}

/** `not_requested` is deliberately excluded; only the historical section may use it. */
export type EvidenceSection<T> =
  | { status: "not_attempted"; reason: "mint_unresolved" | "holder_evidence_unavailable" }
  | { status: "unavailable"; reason: string; errorCategory?: string }
  | { status: "present"; evidence: T };

export type HistoricalEvidenceSection<T> = EvidenceSection<T> | { status: "not_requested" };

export type SolanaResolvedMint = Extract<SolanaMintResolution, { exists: true; isMint: true }>;

export type SolanaMintReportEvidence =
  | { resolution: Extract<SolanaMintResolution, { exists: false }> }
  | { resolution: Extract<SolanaMintResolution, { exists: true; isMint: false }> }
  | {
      resolution: SolanaResolvedMint;
      token2022MintExtensionInventory: SolanaToken2022MintExtensionInventory;
    };

export interface SolanaHolderReportEvidence {
  /** Raw provider pages and opaque pagination cursors are not included. */
  holderStructure: SolanaHolderStructure | SolanaPartialHolderStructure;
  ownerAuthorityBalanceDistribution: OwnerAuthorityBalanceDistribution;
  snapshotRecord: import("./solanaHolderSnapshot").SolanaHolderSnapshotRecordV2;
}

export interface SolanaHistoricalReportEvidence {
  authoritySelection: SolanaHistoricalAuthoritySelectionV2;
  queryPlan: SolanaHistoricalQueryPlanV2;
  execution: {
    evidence: SolanaBoundedHistoricalSamplingEvidence;
    telemetry: import("../execution/solanaHistoricalQueryExecution").SolanaHistoricalExecutionTelemetry;
  };
  descriptiveMetrics: SolanaHistoricalDescriptiveMetrics;
  transactionSelection: SolanaHistoricalTransactionSelectionEvidence;
  transactionEnrichment: SolanaTransactionEnrichmentExecutionResult;
  transactionIntegration: SolanaTransactionEvidenceIntegrationEvidence;
}

export interface SolanaTokenEvidenceReport {
  schemaVersion: typeof SOLANA_TOKEN_EVIDENCE_REPORT_SCHEMA_VERSION;
  chain: "solana";
  assetAddress: string;
  /** Assembly time only; provider observations are not implied to be atomic or same-slot. */
  generatedAt: string;
  mint: EvidenceSection<SolanaMintReportEvidence>;
  market: EvidenceSection<NormalizedMarketSnapshot>;
  holders: EvidenceSection<SolanaHolderReportEvidence>;
  historicalTransactions: HistoricalEvidenceSection<SolanaHistoricalReportEvidence>;
}
