import type { HeliusTransferObservation } from "../src/providers/solana/heliusTransfersByAddress";
import type {
  SolanaBoundedHistoricalSamplingEvidence,
  SolanaHistoricalAuthorityEvidence,
  SolanaHistoricalAmountEvidence,
  SolanaHistoricalPageEvidence,
  SolanaHistoricalTransferObservation,
} from "../src/types/solanaHistoricalSampling";

const heliusRecord: HeliusTransferObservation = {
  signature: "signature",
  slot: 1,
  blockTime: 1_700_000_000,
  amount: {
    rawAmount: "18446744073709551615",
    exactRawAvailable: true,
    reportedAmount: "18446744073709551615",
    reportedAmountType: "integer_string",
  },
};

const observation: SolanaHistoricalTransferObservation = {
  providerRecord: {
    ...heliusRecord,
    amount: {
      rawAmount: "18446744073709551615",
      exactRawAvailable: true,
      exactnessBasis: "provider_integer_string",
      unavailableReason: null,
      reportedAmount: "18446744073709551615",
      reportedAmountType: "integer_string",
    },
  },
  observedTime: { status: "available", unixSeconds: 1_700_000_000, basis: "provider_reported" },
};

const numericAmount: SolanaHistoricalAmountEvidence = {
  rawAmount: null,
  exactRawAvailable: false,
  exactnessBasis: null,
  unavailableReason: "provider_representation_not_exact",
  reportedAmount: "42",
  reportedAmountType: "safe_integer_number",
};

const numericObservation: SolanaHistoricalTransferObservation = {
  providerRecord: {
    ...heliusRecord,
    amount: numericAmount,
  },
  observedTime: { status: "unavailable", value: null, reason: "null" },
};

const page: SolanaHistoricalPageEvidence = {
  pageNumber: 1,
  requestLimit: 100,
  recordCount: 1,
  startRecordIndex: 0,
  endRecordIndexExclusive: 1,
  continuationTokenUsed: false,
  continuationTokenReturned: false,
  firstUsableBlockTime: 1_700_000_000,
  lastUsableBlockTime: 1_700_000_000,
  minimumUsableBlockTime: 1_700_000_000,
  maximumUsableBlockTime: 1_700_000_000,
  recordsWithoutUsableBlockTime: 0,
};

const common = {
  authorityAddress: "authority",
  requestCount: 1,
  pages: [page],
  observations: [observation],
};

const successWithRecords: SolanaHistoricalAuthorityEvidence = {
  ...common,
  queryStatus: "success",
  paginationStatus: "complete",
  terminalReason: "natural_termination",
  providerError: null,
};

const successEmpty: SolanaHistoricalAuthorityEvidence = {
  authorityAddress: "empty-authority",
  requestCount: 1,
  pages: [{ ...page, recordCount: 0, startRecordIndex: 0, endRecordIndexExclusive: 0,
    firstUsableBlockTime: null, lastUsableBlockTime: null, minimumUsableBlockTime: null,
    maximumUsableBlockTime: null, recordsWithoutUsableBlockTime: 0 }],
  observations: [],
  queryStatus: "success",
  paginationStatus: "complete",
  terminalReason: "natural_termination",
  providerError: null,
};

const truncated: SolanaHistoricalAuthorityEvidence = {
  ...common,
  queryStatus: "success",
  paginationStatus: "truncated",
  terminalReason: "page_and_record_caps",
  providerError: null,
};

const failedAfterPage: SolanaHistoricalAuthorityEvidence = {
  ...common,
  requestCount: 2,
  queryStatus: "provider_error",
  paginationStatus: "not_applicable",
  terminalReason: "provider_error",
  providerError: { category: "rpc", message: "sanitized failure" },
};

const notQueried: SolanaHistoricalAuthorityEvidence = {
  authorityAddress: "unqueried-authority",
  queryStatus: "not_queried",
  reason: "budget_limit",
  paginationStatus: "not_applicable",
  terminalReason: "not_queried",
  requestCount: 0,
  pages: [],
  observations: [],
  providerError: null,
};

const evidence: SolanaBoundedHistoricalSamplingEvidence = {
  chain: "solana",
  mintAddress: "mint",
  provenance: {
    provider: "helius",
    method: "getTransfersByAddress",
    fetchedAt: "2026-10-01T00:00:00.000Z",
    requestedWindow: { fromUnixSecondsInclusive: 1_700_000_000, toUnixSecondsExclusive: 1_700_100_000 },
    maxAuthorities: 3,
    maxPagesPerAuthority: 2,
    maxRecordsPerAuthority: 150,
  },
  authorityScope: { source: "holder_snapshot", candidateAuthorityCount: 3, candidateSetCompleteness: "complete" },
  authorities: [successWithRecords, successEmpty, truncated, failedAfterPage, notQueried],
  applicationDerivedEvidence: { status: "not_calculated", metrics: null },
};

// @ts-expect-error A not-queried authority cannot represent a successful empty query.
const invalidNotQueried: SolanaHistoricalAuthorityEvidence = { authorityAddress: "x", queryStatus: "not_queried", reason: "not_selected", paginationStatus: "complete", terminalReason: "natural_termination", requestCount: 0, pages: [], observations: [], providerError: null };
// @ts-expect-error A truncated query cannot claim natural termination.
const invalidTruncated: SolanaHistoricalAuthorityEvidence = { ...common, queryStatus: "success", paginationStatus: "truncated", terminalReason: "natural_termination", providerError: null };
// @ts-expect-error A provider failure cannot claim complete pagination.
const invalidFailure: SolanaHistoricalAuthorityEvidence = { ...common, queryStatus: "provider_error", paginationStatus: "complete", terminalReason: "provider_error", providerError: { category: "rpc", message: "failure" } };
// @ts-expect-error The production evidence page has cursor flags, never an opaque cursor value.
const invalidPage: SolanaHistoricalPageEvidence = { ...page, continuationToken: "opaque-secret" };
// @ts-expect-error An integer string cannot be labeled non-raw in the normalized evidence projection.
const invalidAmount: SolanaHistoricalAmountEvidence = { rawAmount: null, exactRawAvailable: false, exactnessBasis: null, unavailableReason: "provider_representation_not_exact", reportedAmount: "42", reportedAmountType: "integer_string" };
// @ts-expect-error A numeric provider amount cannot be made exact raw evidence inside the authoritative record.
const invalidNumericProviderAmount: SolanaHistoricalTransferObservation = { providerRecord: { ...heliusRecord, amount: { rawAmount: "42", exactRawAvailable: true, exactnessBasis: "provider_integer_string", unavailableReason: null, reportedAmount: "42", reportedAmountType: "safe_integer_number" } }, observedTime: { status: "available", unixSeconds: 1_700_000_000, basis: "provider_reported" } };
// @ts-expect-error Amount evidence cannot be supplied a second time beside the provider record.
const invalidDuplicatedAmountEvidence: SolanaHistoricalTransferObservation = { providerRecord: observation.providerRecord, observedTime: observation.observedTime, amountEvidence: numericAmount };

void [evidence, numericObservation, invalidNotQueried, invalidTruncated, invalidFailure, invalidPage, invalidAmount, invalidNumericProviderAmount, invalidDuplicatedAmountEvidence];
