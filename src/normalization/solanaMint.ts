import type { RawSolanaAccount } from "../providers/solana/heliusRpc";

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT_BASE_SIZE = 82;
const TOKEN_ACCOUNT_BASE_SIZE = 165;
const TOKEN_2022_ACCOUNT_TYPE_OFFSET = TOKEN_ACCOUNT_BASE_SIZE;
const TOKEN_2022_TLV_OFFSET = TOKEN_2022_ACCOUNT_TYPE_OFFSET + 1;
const TOKEN_2022_MINT_ACCOUNT_TYPE = 1;
const TOKEN_2022_TOKEN_ACCOUNT_TYPE = 2;
const TOKEN_2022_MULTISIG_SIZE = 355;

const MINT_EXTENSION_TYPES = new Set([
  1, 3, 4, 6, 9, 10, 12, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28,
]);
const TOKEN_ACCOUNT_EXTENSION_TYPES = new Set([2, 5, 7, 8, 11, 13, 15, 17, 27]);
const KNOWN_EXTENSION_TYPES = new Set([
  ...MINT_EXTENSION_TYPES,
  ...TOKEN_ACCOUNT_EXTENSION_TYPES,
]);

export type TokenProgram = "spl-token" | "token-2022";

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

function hasValidExtensions(
  data: Uint8Array,
  accountType: "mint" | "token-account",
): boolean {
  const allowedTypes = accountType === "mint" ? MINT_EXTENSION_TYPES : TOKEN_ACCOUNT_EXTENSION_TYPES;
  let cursor = TOKEN_2022_TLV_OFFSET;

  while (cursor < data.byteLength) {
    const remaining = data.byteLength - cursor;

    // SPL permits one trailing byte during a reallocating account-size change.
    if (remaining < 2) {
      return true;
    }

    const view = new DataView(data.buffer, data.byteOffset + cursor, remaining);
    const extensionType = view.getUint16(0, true);

    // An uninitialized TLV type terminates iteration; trailing allocated bytes are ignored.
    if (extensionType === 0) {
      return true;
    }

    if (!KNOWN_EXTENSION_TYPES.has(extensionType) || !allowedTypes.has(extensionType)) {
      return false;
    }

    if (remaining < 4) {
      return false;
    }

    const extensionLength = view.getUint16(2, true);
    cursor += 4 + extensionLength;

    if (cursor > data.byteLength) {
      return false;
    }
  }

  return true;
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
    hasValidExtensions(data, "mint")
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
    hasValidExtensions(data, "token-account")
  );
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

  if (account.owner === SPL_TOKEN_PROGRAM_ID) {
    const data = decodeBase64(account.dataBase64);

    return data.byteLength === MINT_BASE_SIZE && isInitializedMintBase(data)
      ? normalizeMint(data, "spl-token")
      : { exists: true, isMint: false };
  }

  if (account.owner === TOKEN_2022_PROGRAM_ID) {
    const data = decodeBase64(account.dataBase64);
    const isMint = isToken2022Mint(data);
    const isTokenAccount = isToken2022TokenAccount(data);

    return isMint && !isTokenAccount
      ? normalizeMint(data, "token-2022")
      : { exists: true, isMint: false };
  }

  return { exists: true, isMint: false };
}
