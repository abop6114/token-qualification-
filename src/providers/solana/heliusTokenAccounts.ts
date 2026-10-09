import { isBase58Syntax, isSolanaPublicKeySyntax } from "../../validation/solanaAddress";
import type {
  RawSolanaTokenAccount,
  RawSolanaTokenAccountPage,
  SolanaTokenAccountAcquisitionResult,
} from "../../types/holders";
import { SOLANA_TOKEN_PROGRAM_IDS, type TokenProgram } from "../../types/solana";
import { HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS } from "./heliusTransaction";

const HELIUS_MAINNET_RPC_URL = "https://mainnet.helius-rpc.com/";
const RPC_REQUEST_ID = "token-accounts";
const PAGE_LIMIT = 5000 as const;
const MAX_PAGES = 20 as const;
const MAX_TIMEOUT_MS = 2_147_483_647;
type JsonObject = Record<string, unknown>;
type AcquisitionFailureReason = "request_timeout" | "provider_error" | "malformed_response";

class PageRequestFailure extends Error {
  constructor(readonly reason: AcquisitionFailureReason) {
    super("Solana token-account page acquisition failed.");
    this.name = "PageRequestFailure";
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderAccount(value: unknown, programId: string): RawSolanaTokenAccount {
  if (!isJsonObject(value) || typeof value.pubkey !== "string" || !isJsonObject(value.account)) {
    throw new Error("malformed");
  }

  const { owner, data, space } = value.account;
  if (
    typeof owner !== "string" ||
    !Array.isArray(data) ||
    typeof data[0] !== "string" ||
    data[1] !== "base64" ||
    (space !== undefined && (!Number.isSafeInteger(space) || (space as number) < 0))
  ) {
    throw new Error("malformed");
  }

  if (owner !== programId || !isSolanaPublicKeySyntax(value.pubkey)) {
    throw new Error("malformed");
  }

  return {
    address: value.pubkey,
    programOwner: owner,
    dataBase64: data[0],
    reportedSpace: typeof space === "number" ? space : null,
  };
}

async function requestPage(
  endpoint: string,
  requestBody: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  programId: string,
): Promise<RawSolanaTokenAccountPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: requestBody,
      });
    } catch {
      throw new PageRequestFailure(controller.signal.aborted ? "request_timeout" : "provider_error");
    }

    if (controller.signal.aborted) throw new PageRequestFailure("request_timeout");
    if (!response.ok) throw new PageRequestFailure("provider_error");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PageRequestFailure(controller.signal.aborted ? "request_timeout" : "malformed_response");
    }
    if (controller.signal.aborted) throw new PageRequestFailure("request_timeout");

    if (!isJsonObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== RPC_REQUEST_ID) {
      throw new PageRequestFailure("malformed_response");
    }
    if ("error" in payload) {
      const rpcError = payload.error;
      if (isJsonObject(rpcError) && typeof rpcError.code === "number") {
        throw new PageRequestFailure("provider_error");
      }
      throw new PageRequestFailure("malformed_response");
    }

    const result = payload.result;
    if (!isJsonObject(result) || !isJsonObject(result.context) || !isJsonObject(result.value)) {
      throw new PageRequestFailure("malformed_response");
    }

    const contextSlot = result.context.slot;
    const page = result.value;
    if (!Number.isSafeInteger(contextSlot) || (contextSlot as number) < 0 || !Array.isArray(page.accounts)) {
      throw new PageRequestFailure("malformed_response");
    }
    if (page.accounts.length > PAGE_LIMIT) throw new PageRequestFailure("malformed_response");
    if (page.paginationKey !== null && (typeof page.paginationKey !== "string" || !isBase58Syntax(page.paginationKey))) {
      throw new PageRequestFailure("malformed_response");
    }

    let accounts: RawSolanaTokenAccount[];
    try {
      accounts = page.accounts.map((account) => parseProviderAccount(account, programId));
    } catch {
      throw new PageRequestFailure("malformed_response");
    }

    return { accounts, paginationKey: page.paginationKey as string | null, contextSlot: contextSlot as number };
  } catch (error: unknown) {
    if (error instanceof PageRequestFailure) throw error;
    throw new PageRequestFailure(controller.signal.aborted ? "request_timeout" : "provider_error");
  } finally {
    clearTimeout(timeout);
  }
}

function unavailable(reason: "configuration_error" | AcquisitionFailureReason): SolanaTokenAccountAcquisitionResult {
  return {
    status: "unavailable",
    reason,
    configuredMaxPages: MAX_PAGES,
    requestedPageSize: PAGE_LIMIT,
    pages: [],
  };
}

function stopAfterFailure(
  pages: RawSolanaTokenAccountPage[],
  reason: AcquisitionFailureReason,
): SolanaTokenAccountAcquisitionResult {
  return pages.length === 0
    ? unavailable(reason)
    : {
        status: "available",
        completeness: "partial",
        stopReason: reason,
        configuredMaxPages: MAX_PAGES,
        requestedPageSize: PAGE_LIMIT,
        pages,
      };
}

export async function getSolanaTokenAccountPages(
  mintAddress: string,
  tokenProgram: TokenProgram,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS,
): Promise<SolanaTokenAccountAcquisitionResult> {
  if (!isSolanaPublicKeySyntax(mintAddress)) {
    throw new Error("A resolved Solana mint address is required for token-account enumeration.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Helius token-account request timeout is invalid.");
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") return unavailable("configuration_error");

  const programId = SOLANA_TOKEN_PROGRAM_IDS[tokenProgram];
  const endpoint = `${HELIUS_MAINNET_RPC_URL}?api-key=${encodeURIComponent(apiKey)}`;
  const pages: RawSolanaTokenAccountPage[] = [];
  const seenCursors = new Set<string>();
  const seenTokenAccounts = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const filters = tokenProgram === "spl-token"
      ? [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: mintAddress, encoding: "base58" } },
        ]
      : [{ memcmp: { offset: 0, bytes: mintAddress, encoding: "base58" } }];

    const config: JsonObject = {
      encoding: "base64",
      commitment: "finalized",
      withContext: true,
      limit: PAGE_LIMIT,
      filters,
    };
    if (cursor !== null) config.paginationKey = cursor;

    let page: RawSolanaTokenAccountPage;
    try {
      page = await requestPage(
        endpoint,
        JSON.stringify({
          jsonrpc: "2.0",
          id: RPC_REQUEST_ID,
          method: "getProgramAccountsV2",
          params: [programId, config],
        }),
        fetchImpl,
        timeoutMs,
        programId,
      );
    } catch (error: unknown) {
      return stopAfterFailure(pages, error instanceof PageRequestFailure ? error.reason : "provider_error");
    }

    const nextCursor = page.paginationKey;
    const pageAddresses = new Set<string>();
    if (nextCursor !== null && seenCursors.has(nextCursor)) {
      return stopAfterFailure(pages, "malformed_response");
    }
    for (const account of page.accounts) {
      if (seenTokenAccounts.has(account.address) || pageAddresses.has(account.address)) {
        return stopAfterFailure(pages, "malformed_response");
      }
      pageAddresses.add(account.address);
    }

    // Commit page and its cursor/address indexes only after every page-level check passes.
    pages.push(page);
    for (const address of pageAddresses) seenTokenAccounts.add(address);
    if (nextCursor === null) {
      return {
        status: "available",
        completeness: "complete",
        stopReason: "provider_terminated",
        configuredMaxPages: MAX_PAGES,
        requestedPageSize: PAGE_LIMIT,
        pages,
      };
    }
    seenCursors.add(nextCursor);
    if (pageNumber === MAX_PAGES) {
      return {
        status: "available",
        completeness: "partial",
        stopReason: "page_cap",
        configuredMaxPages: MAX_PAGES,
        requestedPageSize: PAGE_LIMIT,
        pages,
      };
    }
    cursor = nextCursor;
  }

  // The bounded loop returns on every accepted page; this is defensive and cannot issue page 21.
  return stopAfterFailure(pages, "malformed_response");
}
