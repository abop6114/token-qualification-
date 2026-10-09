import type { RawSolanaAccount } from "../providers/solana/heliusRpc";
import { SOLANA_TOKEN_PROGRAM_IDS } from "../types/solana";
import type { SolanaMintResolution } from "./solanaMint";
import { getSolanaMintExtensionEntries, normalizeSolanaMintAccount } from "./solanaMint";
import { getToken2022MintExtensionName } from "./token2022Extensions";
import {
  SOLANA_TOKEN_2022_MINT_EXTENSION_INVENTORY_SCHEMA_VERSION,
  type SolanaToken2022MintExtensionInventory,
} from "../types/solanaToken2022MintExtensionInventory";

type ResolvedMint = Extract<SolanaMintResolution, { exists: true; isMint: true }>;

/**
 * Produces presence-only structural inventory. It does not interpret payloads
 * or establish safety, risk, authority, restrictions, or mutability.
 */
export function normalizeSolanaToken2022MintExtensionInventory(input: {
  account: RawSolanaAccount;
  mint: ResolvedMint;
}): SolanaToken2022MintExtensionInventory {
  const { account, mint } = input;
  if (account.requestedAddress !== mint.mintAddress) {
    throw new Error("Mint inventory account identity does not match the resolved mint.");
  }

  const expectedProgramId = SOLANA_TOKEN_PROGRAM_IDS[mint.tokenProgram];
  if (account.owner !== expectedProgramId) {
    throw new Error("Mint inventory account owner does not match the resolved token program.");
  }

  const normalizedMint = normalizeSolanaMintAccount(account);
  if (
    normalizedMint.exists !== true || normalizedMint.isMint !== true ||
    normalizedMint.mintAddress !== mint.mintAddress ||
    normalizedMint.tokenProgram !== mint.tokenProgram
  ) {
    throw new Error("Mint inventory account bytes do not match the resolved mint evidence.");
  }

  const base = {
    schemaVersion: SOLANA_TOKEN_2022_MINT_EXTENSION_INVENTORY_SCHEMA_VERSION,
    chain: "solana" as const,
    mintAddress: mint.mintAddress,
  };

  if (mint.tokenProgram === "spl-token") {
    return { ...base, tokenProgram: "spl-token", status: "not_applicable" };
  }

  const parsedEntries = getSolanaMintExtensionEntries(account, "token-2022");
  const seen = new Set<number>();
  for (const entry of parsedEntries) {
    if (seen.has(entry.extensionTypeId)) {
      return { ...base, tokenProgram: "token-2022", status: "malformed", reason: "duplicate_extension_type" };
    }
    seen.add(entry.extensionTypeId);
  }

  const extensions = parsedEntries
    .map((entry) => {
      const extensionName = getToken2022MintExtensionName(entry.extensionTypeId);
      if (extensionName === null) {
        // The shared parser rejects unknown/context-invalid mint IDs. Keep this
        // guard as a defensive assertion at the evidence construction boundary.
        throw new Error("Mint inventory parser returned an unsupported extension type.");
      }
      return {
        extensionTypeId: entry.extensionTypeId,
        extensionName,
        payloadLength: entry.payloadLength,
      };
    })
    .sort((left, right) => left.extensionTypeId - right.extensionTypeId);

  return { ...base, tokenProgram: "token-2022", status: "available", extensions };
}
