import type { TokenProgram } from "./solana";

export const SOLANA_TOKEN_2022_MINT_EXTENSION_INVENTORY_SCHEMA_VERSION =
  "solana-token-2022-mint-extension-inventory-v1" as const;

export interface SolanaToken2022MintExtensionInventoryEntry {
  extensionTypeId: number;
  extensionName: string;
  payloadLength: number;
}

interface SolanaToken2022MintExtensionInventoryBase {
  schemaVersion: typeof SOLANA_TOKEN_2022_MINT_EXTENSION_INVENTORY_SCHEMA_VERSION;
  chain: "solana";
  mintAddress: string;
  tokenProgram: TokenProgram;
}

export type SolanaToken2022MintExtensionInventory =
  | (SolanaToken2022MintExtensionInventoryBase & {
      status: "available";
      tokenProgram: "token-2022";
      extensions: SolanaToken2022MintExtensionInventoryEntry[];
    })
  | (SolanaToken2022MintExtensionInventoryBase & {
      status: "not_applicable";
      tokenProgram: "spl-token";
    })
  | (SolanaToken2022MintExtensionInventoryBase & {
      status: "malformed";
      tokenProgram: "token-2022";
      reason: "duplicate_extension_type";
    });
