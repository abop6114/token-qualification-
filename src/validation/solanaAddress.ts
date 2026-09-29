const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function isSolanaPublicKeySyntax(value: string): boolean {
  if (value.length < 32 || value.length > 44) {
    return false;
  }

  let decodedValue = 0n;

  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);

    if (digit === -1) {
      return false;
    }

    decodedValue = decodedValue * 58n + BigInt(digit);
  }

  let leadingZeroBytes = 0;
  while (value[leadingZeroBytes] === "1") {
    leadingZeroBytes += 1;
  }

  const significantByteLength =
    decodedValue === 0n ? 0 : Math.ceil(decodedValue.toString(16).length / 2);

  return leadingZeroBytes + significantByteLength === 32;
}
