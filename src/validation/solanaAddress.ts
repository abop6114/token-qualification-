const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function isBase58Syntax(value: string): boolean {
  return value.length > 0 && [...value].every((character) => BASE58_ALPHABET.includes(character));
}

/** Decode Base58 bytes without assigning Solana public-key semantics. */
export function decodeBase58(value: string): Uint8Array | null {
  if (!isBase58Syntax(value)) return null;

  let decodedValue = 0n;
  for (const character of value) {
    decodedValue = decodedValue * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  }

  let leadingZeroBytes = 0;
  while (value[leadingZeroBytes] === "1") leadingZeroBytes += 1;

  const significantByteLength =
    decodedValue === 0n ? 0 : Math.ceil(decodedValue.toString(16).length / 2);
  const result = new Uint8Array(leadingZeroBytes + significantByteLength);
  let remaining = decodedValue;
  for (let index = result.length - 1; index >= leadingZeroBytes; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

/** A Solana transaction signature is a Base58-encoded 64-byte signature. */
export function isSolanaTransactionSignatureSyntax(value: string): boolean {
  if (value.length < 64 || value.length > 88) return false;
  return decodeBase58(value)?.byteLength === 64;
}

export function decodeSolanaPublicKey(value: string): Uint8Array | null {
  if (value.length < 32 || value.length > 44) return null;
  let decodedValue = 0n;

  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit === -1) return null;
    decodedValue = decodedValue * 58n + BigInt(digit);
  }

  let leadingZeroBytes = 0;
  while (value[leadingZeroBytes] === "1") {
    leadingZeroBytes += 1;
  }

  const significantByteLength =
    decodedValue === 0n ? 0 : Math.ceil(decodedValue.toString(16).length / 2);

  if (leadingZeroBytes + significantByteLength !== 32) return null;

  const result = new Uint8Array(32);
  let remaining = decodedValue;
  for (let index = 31; index >= leadingZeroBytes; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function encodeSolanaPublicKey(bytes: Uint8Array): string {
  if (bytes.byteLength !== 32) {
    throw new Error("A Solana public key must contain exactly 32 bytes.");
  }

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    const digit = Number(value % 58n);
    encoded = BASE58_ALPHABET[digit] + encoded;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }

  return encoded || "1";
}

export function isSolanaPublicKeySyntax(value: string): boolean {
  return decodeSolanaPublicKey(value) !== null;
}
