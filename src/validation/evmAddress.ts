/** Normalize an explicitly supplied EVM address without inferring its chain. */
export function normalizeEvmAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 42 || !value.startsWith("0x")) return null;
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isDigit = code >= 48 && code <= 57;
    const isLowerHex = code >= 97 && code <= 102;
    const isUpperHex = code >= 65 && code <= 70;
    if (!isDigit && !isLowerHex && !isUpperHex) return null;
  }
  return value.toLowerCase();
}
