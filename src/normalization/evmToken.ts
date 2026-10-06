import type { EvmBlockEvidence, EvmContractCodeEvidence, EvmRpcFact } from "../types/evmToken";

const UINT256_MAX = (1n << 256n) - 1n;

function isHexDigit(character: string): boolean {
  if (character.length !== 1) return false;
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/** Validate the complete input; no regex end-anchor or trailing-text tolerance. */
function isHexData(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("0x")) return false;
  const digits = value.slice(2);
  if (digits.length % 2 !== 0) return false;
  for (const digit of digits) if (!isHexDigit(digit)) return false;
  return true;
}

function isHexQuantity(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("0x")) return false;
  const digits = value.slice(2);
  if (digits.length === 0 || (digits.length > 1 && digits[0] === "0")) return false;
  for (const digit of digits) if (!isHexDigit(digit)) return false;
  return true;
}

export function normalizeEvmBlockNumber(value: unknown): EvmBlockEvidence {
  if (!isHexQuantity(value)) {
    return { status: "malformed", blockNumber: null, reason: "malformed_response" };
  }
  const integer = BigInt(value);
  if (integer > UINT256_MAX) return { status: "malformed", blockNumber: null, reason: "malformed_response" };
  return { status: "available", blockNumber: `0x${integer.toString(16)}`, basis: "eth_blockNumber" };
}

export function normalizeEvmContractCode(value: unknown): EvmContractCodeEvidence {
  if (!isHexData(value)) return { status: "malformed", reason: "malformed_response" };
  if (value === "0x") return { status: "no_code", byteLength: 0, basis: "eth_getCode" };
  return { status: "present", byteLength: (value.length - 2) / 2, basis: "eth_getCode" };
}

function decodeWord(value: unknown): bigint | null {
  if (!isHexData(value) || value.length !== 66) return null;
  return BigInt(value);
}

export function normalizeEvmUint256(value: unknown): EvmRpcFact<string> {
  const word = decodeWord(value);
  return word === null
    ? { status: "malformed", value: null, reason: "malformed_abi" }
    : { status: "available", value: word.toString(10), basis: "eth_call" };
}

export function normalizeEvmDecimals(value: unknown): EvmRpcFact<number> {
  const word = decodeWord(value);
  if (word === null || word > 255n) return { status: "malformed", value: null, reason: "malformed_abi" };
  return { status: "available", value: Number(word), basis: "eth_call" };
}

export function normalizeEvmAbiString(value: unknown): EvmRpcFact<string> {
  if (!isHexData(value)) {
    return { status: "malformed", value: null, reason: "malformed_abi" };
  }
  const hex = value.slice(2);
  if (hex.length < 128) return { status: "malformed", value: null, reason: "malformed_abi" };

  const bytes = Buffer.from(hex, "hex");
  const offset = BigInt(`0x${hex.slice(0, 64)}`);
  if (offset !== 32n) return { status: "malformed", value: null, reason: "malformed_abi" };
  const length = BigInt(`0x${hex.slice(64, 128)}`);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) return { status: "malformed", value: null, reason: "malformed_abi" };
  const byteLength = Number(length);
  const paddedLength = Math.ceil(byteLength / 32) * 32;
  if (bytes.length !== 64 + paddedLength || byteLength > paddedLength) {
    return { status: "malformed", value: null, reason: "malformed_abi" };
  }
  for (let index = 64 + byteLength; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) return { status: "malformed", value: null, reason: "malformed_abi" };
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(64, 64 + byteLength));
    return { status: "available", value: decoded, basis: "eth_call" };
  } catch {
    return { status: "malformed", value: null, reason: "malformed_abi" };
  }
}
