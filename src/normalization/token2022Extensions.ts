const TOKEN_2022_TOKEN_ACCOUNT_BASE_SIZE = 165;
const TOKEN_2022_ACCOUNT_TYPE_OFFSET = TOKEN_2022_TOKEN_ACCOUNT_BASE_SIZE;
const TOKEN_2022_TLV_OFFSET = TOKEN_2022_ACCOUNT_TYPE_OFFSET + 1;
const TOKEN_2022_MULTISIG_SIZE = 355;

/**
 * ExtensionType IDs and contexts pinned to solana-program/token-2022 commit
 * 8867f751c0f69367ba03af4f85510b5611989491,
 * interface/src/extension/mod.rs (ExtensionType and get_account_type()).
 * This is the TQE-selected mapping pin, not a declared project dependency.
 */
const EXTENSION_MAPPING = [
  { id: 1, name: "TransferFeeConfig", context: "mint" },
  { id: 2, name: "TransferFeeAmount", context: "account" },
  { id: 3, name: "MintCloseAuthority", context: "mint" },
  { id: 4, name: "ConfidentialTransferMint", context: "mint" },
  { id: 5, name: "ConfidentialTransferAccount", context: "account" },
  { id: 6, name: "DefaultAccountState", context: "mint" },
  { id: 7, name: "ImmutableOwner", context: "account" },
  { id: 8, name: "MemoTransfer", context: "account" },
  { id: 9, name: "NonTransferable", context: "mint" },
  { id: 10, name: "InterestBearingConfig", context: "mint" },
  { id: 11, name: "CpiGuard", context: "account" },
  { id: 12, name: "PermanentDelegate", context: "mint" },
  { id: 13, name: "NonTransferableAccount", context: "account" },
  { id: 14, name: "TransferHook", context: "mint" },
  { id: 15, name: "TransferHookAccount", context: "account" },
  { id: 16, name: "ConfidentialTransferFeeConfig", context: "mint" },
  { id: 17, name: "ConfidentialTransferFeeAmount", context: "account" },
  { id: 18, name: "MetadataPointer", context: "mint" },
  { id: 19, name: "TokenMetadata", context: "mint" },
  { id: 20, name: "GroupPointer", context: "mint" },
  { id: 21, name: "TokenGroup", context: "mint" },
  { id: 22, name: "GroupMemberPointer", context: "mint" },
  { id: 23, name: "TokenGroupMember", context: "mint" },
  { id: 24, name: "ConfidentialMintBurn", context: "mint" },
  { id: 25, name: "ScaledUiAmount", context: "mint" },
  { id: 26, name: "Pausable", context: "mint" },
  { id: 27, name: "PausableAccount", context: "account" },
  { id: 28, name: "PermissionedBurn", context: "mint" },
] as const;

const MINT_EXTENSION_TYPES = new Set<number>(
  EXTENSION_MAPPING.filter((extension) => extension.context === "mint").map((extension) => extension.id),
);
const TOKEN_ACCOUNT_EXTENSION_TYPES = new Set<number>(
  EXTENSION_MAPPING.filter((extension) => extension.context === "account").map((extension) => extension.id),
);
const KNOWN_EXTENSION_TYPES = new Set<number>([
  ...MINT_EXTENSION_TYPES,
  ...TOKEN_ACCOUNT_EXTENSION_TYPES,
]);

export interface Token2022MintExtensionEntry {
  extensionTypeId: number;
  payloadLength: number;
}

export function getToken2022ExtensionDefinition(extensionTypeId: number): {
  extensionName: string;
  context: "mint" | "account";
} | null {
  const extension = EXTENSION_MAPPING.find((candidate) => candidate.id === extensionTypeId);
  return extension === undefined
    ? null
    : { extensionName: extension.name, context: extension.context };
}

function parseTlvEntries(data: Uint8Array): Token2022MintExtensionEntry[] | null {
  const entries: Token2022MintExtensionEntry[] = [];
  let cursor = TOKEN_2022_TLV_OFFSET;

  while (cursor < data.byteLength) {
    const remaining = data.byteLength - cursor;

    // SPL accepts a final partial type byte during account reallocation.
    if (remaining < 2) return entries;

    const view = new DataView(data.buffer, data.byteOffset + cursor, remaining);
    const extensionType = view.getUint16(0, true);

    // Type zero terminates TLV iteration; allocated trailing bytes are ignored.
    if (extensionType === 0) return entries;
    if (remaining < 4) return null;

    const extensionLength = view.getUint16(2, true);
    cursor += 4 + extensionLength;
    if (cursor > data.byteLength) return null;
    entries.push({ extensionTypeId: extensionType, payloadLength: extensionLength });
  }

  return entries;
}

export function getToken2022MintExtensionName(extensionTypeId: number): string | null {
  const extension = getToken2022ExtensionDefinition(extensionTypeId);
  return extension?.context === "mint" ? extension.extensionName : null;
}

export function parseToken2022MintExtensionEntries(data: Uint8Array): Token2022MintExtensionEntry[] | null {
  const entries = parseTlvEntries(data);
  if (
    entries === null ||
    entries.some(({ extensionTypeId }) => !KNOWN_EXTENSION_TYPES.has(extensionTypeId) || !MINT_EXTENSION_TYPES.has(extensionTypeId))
  ) {
    return null;
  }
  return entries;
}

export function parseToken2022MintExtensionTypes(data: Uint8Array): number[] | null {
  const entries = parseToken2022MintExtensionEntries(data);
  return entries?.map(({ extensionTypeId }) => extensionTypeId) ?? null;
}

export function parseToken2022TokenAccountExtensionTypes(data: Uint8Array): number[] | null {
  if (
    data.byteLength < TOKEN_2022_TLV_OFFSET ||
    data.byteLength === TOKEN_2022_MULTISIG_SIZE ||
    data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] !== 2
  ) {
    return null;
  }

  const entries = parseTlvEntries(data);
  if (
    entries === null ||
    entries.some(({ extensionTypeId }) => KNOWN_EXTENSION_TYPES.has(extensionTypeId) && !TOKEN_ACCOUNT_EXTENSION_TYPES.has(extensionTypeId))
  ) {
    return null;
  }
  return entries.map(({ extensionTypeId }) => extensionTypeId);
}
