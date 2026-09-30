const TOKEN_2022_TOKEN_ACCOUNT_BASE_SIZE = 165;
const TOKEN_2022_ACCOUNT_TYPE_OFFSET = TOKEN_2022_TOKEN_ACCOUNT_BASE_SIZE;
const TOKEN_2022_TLV_OFFSET = TOKEN_2022_ACCOUNT_TYPE_OFFSET + 1;
const TOKEN_2022_MULTISIG_SIZE = 355;

const MINT_EXTENSION_TYPES = new Set([
  1, 3, 4, 6, 9, 10, 12, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28,
]);
const TOKEN_ACCOUNT_EXTENSION_TYPES = new Set([2, 5, 7, 8, 11, 13, 15, 17, 27]);
const KNOWN_EXTENSION_TYPES = new Set([
  ...MINT_EXTENSION_TYPES,
  ...TOKEN_ACCOUNT_EXTENSION_TYPES,
]);

function parseTlvTypes(data: Uint8Array): number[] | null {
  const types: number[] = [];
  let cursor = TOKEN_2022_TLV_OFFSET;

  while (cursor < data.byteLength) {
    const remaining = data.byteLength - cursor;

    // SPL accepts a final partial type byte during account reallocation.
    if (remaining < 2) return types;

    const view = new DataView(data.buffer, data.byteOffset + cursor, remaining);
    const extensionType = view.getUint16(0, true);

    // Type zero terminates TLV iteration; allocated trailing bytes are ignored.
    if (extensionType === 0) return types;
    if (remaining < 4) return null;

    const extensionLength = view.getUint16(2, true);
    cursor += 4 + extensionLength;
    if (cursor > data.byteLength) return null;
    types.push(extensionType);
  }

  return types;
}

export function parseToken2022MintExtensionTypes(data: Uint8Array): number[] | null {
  const types = parseTlvTypes(data);
  if (types === null || types.some((type) => !KNOWN_EXTENSION_TYPES.has(type) || !MINT_EXTENSION_TYPES.has(type))) {
    return null;
  }
  return types;
}

export function parseToken2022TokenAccountExtensionTypes(data: Uint8Array): number[] | null {
  if (
    data.byteLength < TOKEN_2022_TLV_OFFSET ||
    data.byteLength === TOKEN_2022_MULTISIG_SIZE ||
    data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] !== 2
  ) {
    return null;
  }

  const types = parseTlvTypes(data);
  if (
    types === null ||
    types.some((type) => KNOWN_EXTENSION_TYPES.has(type) && !TOKEN_ACCOUNT_EXTENSION_TYPES.has(type))
  ) {
    return null;
  }
  return types;
}
