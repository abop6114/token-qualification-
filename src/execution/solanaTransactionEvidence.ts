import {
  getHeliusTransaction,
  HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS,
  HeliusTransactionProviderError,
} from "../providers/solana/heliusTransaction";
import { normalizeSolanaTransactionEvidence, SolanaTransactionNormalizationError } from "../normalization/solanaTransactionEvidence";
import { isSolanaTransactionSignatureSyntax } from "../validation/solanaAddress";
import type {
  SolanaTransactionEvidenceExecutionResult,
  SolanaTransactionFetchOutcome,
  SolanaTransactionRequestProvenance,
} from "../types/solanaTransactionEvidence";

export interface ExecuteSolanaTransactionEvidenceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1_000) / 1_000);
}

function provenance(signature: string, fetchedAt: string): SolanaTransactionRequestProvenance {
  return {
    chain: "solana",
    provider: "helius",
    method: "getTransaction",
    encoding: "json",
    maxSupportedTransactionVersion: 1,
    requestedSignature: signature,
    fetchedAt,
  };
}

function providerErrorOutcome(
  source: SolanaTransactionRequestProvenance,
  error: HeliusTransactionProviderError,
): SolanaTransactionFetchOutcome {
  if (error.category === "malformed_response") {
    return {
      status: "malformed_response",
      provenance: source,
      transaction: null,
      reason: "malformed_structure",
      message: error.message,
    };
  }
  return {
    status: "provider_error",
    provenance: source,
    transaction: null,
    error: {
      category: error.category,
      httpStatus: error.httpStatus,
      rpcCode: error.rpcCode,
      message: error.message,
    },
  };
}

/** Fetches and normalizes evidence for one explicitly supplied Solana transaction signature. */
export async function executeSolanaTransactionEvidence(
  signature: string,
  options: ExecuteSolanaTransactionEvidenceOptions = {},
): Promise<SolanaTransactionEvidenceExecutionResult> {
  if (!isSolanaTransactionSignatureSyntax(signature)) {
    throw new Error("A Base58-encoded 64-byte Solana transaction signature is required.");
  }

  const started = performance.now();
  const now = options.now ?? (() => new Date());
  const fetchedAt = now().toISOString();
  const source = provenance(signature, fetchedAt);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return {
      evidence: {
        status: "provider_error",
        provenance: source,
        transaction: null,
        error: {
          category: "configuration",
          httpStatus: null,
          rpcCode: null,
          message: "Helius request timeout is invalid.",
        },
      },
      telemetry: { requestCount: 0, elapsedMs: elapsedMs(started) },
    };
  }

  if (process.env.HELIUS_API_KEY === undefined || process.env.HELIUS_API_KEY.trim() === "") {
    return {
      evidence: {
        status: "provider_error",
        provenance: source,
        transaction: null,
        error: {
          category: "configuration",
          httpStatus: null,
          rpcCode: null,
          message: "HELIUS_API_KEY is not configured.",
        },
      },
      telemetry: { requestCount: 0, elapsedMs: elapsedMs(started) },
    };
  }

  try {
    const result = await getHeliusTransaction(signature, fetchImpl, timeoutMs);
    if (result.status === "provider_result_null") {
      return {
        evidence: { status: "provider_result_null", provenance: source, transaction: null },
        telemetry: { requestCount: 1, elapsedMs: elapsedMs(started) },
      };
    }
    const transaction = normalizeSolanaTransactionEvidence(result.transaction, signature);
    return {
      evidence: { status: "returned", provenance: source, transaction },
      telemetry: { requestCount: 1, elapsedMs: elapsedMs(started) },
    };
  } catch (error: unknown) {
    const outcome: SolanaTransactionFetchOutcome = error instanceof HeliusTransactionProviderError
      ? providerErrorOutcome(source, error)
      : error instanceof SolanaTransactionNormalizationError
        ? {
            status: "malformed_response",
            provenance: source,
            transaction: null,
            reason: error.reason,
            message: error.message,
          }
        : {
            status: "provider_error",
            provenance: source,
            transaction: null,
            error: {
              category: "transport",
              httpStatus: null,
              rpcCode: null,
              message: "Helius transaction request failed.",
            },
          };
    return {
      evidence: outcome,
      telemetry: { requestCount: 1, elapsedMs: elapsedMs(started) },
    };
  }
}
