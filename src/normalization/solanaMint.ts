import type { RawSolanaAccount } from "../providers/solana/heliusRpc";
import { SOLANA_TOKEN_PROGRAM_IDS, type TokenProgram } from "../types/solana";
import {
  parseToken2022MintExtensionTypes,
  parseToken2022TokenAccountExtensionTypes,
} from "./token2022Extensions";

const MINT_BASE_SIZE = 82;
const TOKEN_ACCOUNT_BASE_SIZE = 165;
const TOKEN_2022_ACCOUNT_TYPE_OFFSET = TOKEN_ACCOUNT_BASE_SIZE;
const TOKEN_2022_TLV_OFFSET = TOKEN_2022_ACCOUNT_TYPE_OFFSET + 1;
const TOKEN_2022_MINT_ACCOUNT_TYPE = 1;
const TOKEN_2022_TOKEN_ACCOUNT_TYPE = 2;
const TOKEN_2022_MULTISIG_SIZE = 355;

export type { TokenProgram } from "../types/solana";

export type SolanaMintResolution =
  | { exists: false; isMint: false }
  | { exists: true; isMint: false }
  | {
      exists: true;
      isMint: true;
      tokenProgram: TokenProgram;
      decimals: number;
      rawSupply: string;
    };

function decodeBase64(value: string): Uint8Array {
  const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  if (!base64Pattern.test(value)) {
    throw new Error("Helius RPC returned malformed base64 account data.");
  }

  const decoded = Buffer.from(value, "base64");

  if (decoded.toString("base64") !== value) {
    throw new Error("Helius RPC returned malformed base64 account data.");
  }

  return decoded;
}

function hasValidCOptionTag(data: Uint8Array, offset: number): boolean {
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  return tag === 0 || tag === 1;
}

function isInitializedMintBase(data: Uint8Array): boolean {
  return (
    data.byteLength >= MINT_BASE_SIZE &&
    hasValidCOptionTag(data, 0) &&
    data[45] === 1 &&
    hasValidCOptionTag(data, 46)
  );
}

function isInitializedTokenAccountBase(data: Uint8Array): boolean {
  if (data.byteLength < TOKEN_ACCOUNT_BASE_SIZE) {
    return false;
  }

  const state = data[108];

  return (
    (state === 1 || state === 2) &&
    hasValidCOptionTag(data, 72) &&
    hasValidCOptionTag(data, 109) &&
    hasValidCOptionTag(data, 129)
  );
}

function isToken2022Mint(data: Uint8Array): boolean {
  if (!isInitializedMintBase(data)) {
    return false;
  }

  if (data.byteLength === MINT_BASE_SIZE) {
    return true;
  }

  if (data.byteLength === TOKEN_2022_MULTISIG_SIZE || data.byteLength < TOKEN_2022_TLV_OFFSET) {
    return false;
  }

  const mintPadding = data.subarray(MINT_BASE_SIZE, TOKEN_2022_ACCOUNT_TYPE_OFFSET);

  return (
    mintPadding.every((byte) => byte === 0) &&
    data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] === TOKEN_2022_MINT_ACCOUNT_TYPE &&
    parseToken2022MintExtensionTypes(data) !== null
  );
}

function isToken2022TokenAccount(data: Uint8Array): boolean {
  if (!isInitializedTokenAccountBase(data)) {
    return false;
  }

  if (data.byteLength === TOKEN_ACCOUNT_BASE_SIZE) {
    return true;
  }

  if (data.byteLength === TOKEN_2022_MULTISIG_SIZE || data.byteLength < TOKEN_2022_TLV_OFFSET) {
    return false;
  }

  return (
    data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] === TOKEN_2022_TOKEN_ACCOUNT_TYPE &&
    parseToken2022TokenAccountExtensionTypes(data) !== null
  );
}

export function getSolanaMintExtensionTypes(
  account: RawSolanaAccount,
  tokenProgram: TokenProgram,
): number[] {
  if (tokenProgram === "spl-token") return [];

  const data = decodeBase64(account.dataBase64);
  if (!isToken2022Mint(data)) {
    throw new Error("Resolved Token-2022 mint account has an invalid extension layout.");
  }
  if (data.byteLength === MINT_BASE_SIZE) return [];

  const extensionTypes = parseToken2022MintExtensionTypes(data);
  if (extensionTypes === null) {
    throw new Error("Resolved Token-2022 mint has malformed extension data.");
  }
  return extensionTypes;
}

function normalizeMint(data: Uint8Array, tokenProgram: TokenProgram): SolanaMintResolution {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawSupply = view.getBigUint64(36, true).toString(10);

  return {
    exists: true,
    isMint: true,
    tokenProgram,
    decimals: data[44],
    rawSupply,
  };
}

export function normalizeSolanaMintAccount(
  account: RawSolanaAccount | null,
): SolanaMintResolution {
  if (account === null) {
    return { exists: false, isMint: false };
  }

  if (account.owner === SOLANA_TOKEN_PROGRAM_IDS["spl-token"]) {
    const data = decodeBase64(account.dataBase64);

    return data.byteLength === MINT_BASE_SIZE && isInitializedMintBase(data)
      ? normalizeMint(data, "spl-token")
      : { exists: true, isMint: false };
  }

  if (account.owner === SOLANA_TOKEN_PROGRAM_IDS["token-2022"]) {
    const data = decodeBase64(account.dataBase64);
    const isMint = isToken2022Mint(data);
    const isTokenAccount = isToken2022TokenAccount(data);

    return isMint && !isTokenAccount
      ? normalizeMint(data, "token-2022")
      : { exists: true, isMint: false };
  }

  return { exists: true, isMint: false };
}
