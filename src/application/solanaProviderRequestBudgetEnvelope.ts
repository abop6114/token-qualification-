import type { GenerateSolanaTokenEvidenceReportRequest } from "../types/solanaTokenEvidenceReport";
import { SOLANA_HISTORICAL_MAX_PAGES_PER_AUTHORITY, SOLANA_HISTORICAL_MAX_SELECTED_AUTHORITIES } from "./solanaTokenEvidenceReport";
import { SOLANA_TOKEN_ACCOUNT_MAX_PAGES } from "../providers/solana/heliusTokenAccounts";
import { SOLANA_HISTORICAL_TRANSACTION_SIGNATURE_CAP } from "../normalization/solanaHistoricalTransactionSelector";

const MINT_ACCOUNT_REQUESTS = 1 as const;
const MARKET_REQUESTS = 1 as const;

/**
 * Fixed built-in worst-case fetch allowance. Page/signature bounds are imported
 * from their authoritative implementations so changing those limits changes this
 * calculation rather than leaving a copied private value behind.
 */
export function getSolanaProviderRequestBudgetEnvelope(
  request: GenerateSolanaTokenEvidenceReportRequest,
): 22 | 29 {
  if (typeof request !== "object" || request === null ||
    (request.historicalTransactions.status !== "requested" && request.historicalTransactions.status !== "not_requested")) {
    throw new TypeError("Validated Solana request is required for the provider budget envelope.");
  }

  const base = MINT_ACCOUNT_REQUESTS + MARKET_REQUESTS + SOLANA_TOKEN_ACCOUNT_MAX_PAGES;
  const historical = request.historicalTransactions.status === "requested"
    ? SOLANA_HISTORICAL_MAX_SELECTED_AUTHORITIES * SOLANA_HISTORICAL_MAX_PAGES_PER_AUTHORITY +
      SOLANA_HISTORICAL_TRANSACTION_SIGNATURE_CAP
    : 0;
  const envelope = base + historical;
  if (envelope !== 22 && envelope !== 29) {
    throw new Error("Built-in provider request limits no longer match the approved request envelope.");
  }
  return envelope;
}
