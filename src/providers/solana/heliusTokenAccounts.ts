import { isBase58Syntax, isSolanaPublicKeySyntax } from "../../validation/solanaAddress";
import type { RawSolanaTokenAccount, RawSolanaTokenAccountPage } from "../../types/holders";
import { SOLANA_TOKEN_PROGRAM_IDS, type TokenProgram } from "../../types/solana";

const HELIUS_MAINNET_RPC_URL = "https://mainnet.helius-rpc.com/";
const RPC_REQUEST_ID = "token-accounts";
const PAGE_LIMIT = 5000;
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderAccount(value: unknown, programId: string): RawSolanaTokenAccount {
  if (!isJsonObject(value) || typeof value.pubkey !== "string" || !isJsonObject(value.account)) {
    throw new Error("Helius GPA V2 returned a malformed token account.");
  }

  const { owner, data, space } = value.account;
  if (
    typeof owner !== "string" ||
    !Array.isArray(data) ||
    typeof data[0] !== "string" ||
    data[1] !== "base64" ||
    (space !== undefined && (!Number.isSafeInteger(space) || (space as number) < 0))
  ) {
    throw new Error("Helius GPA V2 returned malformed token-account data.");
  }

  if (owner !== programId) {
    throw new Error("Helius GPA V2 returned an account owned by an unexpected token program.");
  }
  if (!isSolanaPublicKeySyntax(value.pubkey)) {
    throw new Error("Helius GPA V2 returned a malformed token-account address.");
  }

  return {
    address: value.pubkey,
    programOwner: owner,
    dataBase64: data[0],
    reportedSpace: typeof space === "number" ? space : null,
  };
}

export async function getSolanaTokenAccountPages(
  mintAddress: string,
  tokenProgram: TokenProgram,
  fetchImpl: typeof fetch = fetch,
): Promise<RawSolanaTokenAccountPage[]> {
  if (!isSolanaPublicKeySyntax(mintAddress)) {
    throw new Error("A resolved Solana mint address is required for token-account enumeration.");
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("HELIUS_API_KEY is not configured. Set it in .env or the process environment.");
  }

  const programId = SOLANA_TOKEN_PROGRAM_IDS[tokenProgram];
  const endpoint = `${HELIUS_MAINNET_RPC_URL}?api-key=${encodeURIComponent(apiKey)}`;
  const pages: RawSolanaTokenAccountPage[] = [];
  const seenCursors = new Set<string>();
  const seenTokenAccounts = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
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

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: RPC_REQUEST_ID,
          method: "getProgramAccountsV2",
          params: [programId, config],
        }),
      });
    } catch {
      throw new Error("Helius GPA V2 token-account request failed.");
    }

    if (!response.ok) {
      throw new Error(`Helius GPA V2 HTTP request failed (status ${response.status}).`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Helius GPA V2 returned malformed JSON.");
    }

    if (
      !isJsonObject(payload) ||
      payload.jsonrpc !== "2.0" ||
      payload.id !== RPC_REQUEST_ID
    ) {
      throw new Error("Helius GPA V2 returned a malformed JSON-RPC response.");
    }

    if ("error" in payload) {
      const rpcError = payload.error;
      if (isJsonObject(rpcError) && typeof rpcError.code === "number") {
        throw new Error(`Helius GPA V2 JSON-RPC error (code ${rpcError.code}).`);
      }
      throw new Error("Helius GPA V2 returned a malformed JSON-RPC error.");
    }

    const result = payload.result;
    if (!isJsonObject(result) || !isJsonObject(result.context) || !isJsonObject(result.value)) {
      throw new Error("Helius GPA V2 returned a malformed page envelope.");
    }

    const contextSlot = result.context.slot;
    const page = result.value;
    if (!Number.isSafeInteger(contextSlot) || (contextSlot as number) < 0 || !Array.isArray(page.accounts)) {
      throw new Error("Helius GPA V2 returned malformed page context or accounts.");
    }
    if (page.paginationKey !== null && (typeof page.paginationKey !== "string" || !isBase58Syntax(page.paginationKey))) {
      throw new Error("Helius GPA V2 returned a malformed pagination cursor.");
    }

    const accounts = page.accounts.map((account) => parseProviderAccount(account, programId));
    for (const account of accounts) {
      if (seenTokenAccounts.has(account.address)) {
        throw new Error(`Helius GPA V2 repeated token-account address ${account.address}.`);
      }
      seenTokenAccounts.add(account.address);
    }

    const paginationKey = page.paginationKey as string | null;
    pages.push({ accounts, paginationKey, contextSlot: contextSlot as number });
    if (paginationKey === null) return pages;
    if (seenCursors.has(paginationKey)) {
      throw new Error("Helius GPA V2 repeated a pagination cursor.");
    }
    seenCursors.add(paginationKey);
    cursor = paginationKey;
  }
}
