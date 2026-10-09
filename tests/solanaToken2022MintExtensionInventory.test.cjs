const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeSolanaMintAccount } = require("../dist/normalization/solanaMint.js");
const { normalizeSolanaToken2022MintExtensionInventory } = require("../dist/normalization/solanaToken2022MintExtensionInventory.js");
const {
  getToken2022ExtensionDefinition,
  parseToken2022MintExtensionEntries,
  parseToken2022MintExtensionTypes,
  parseToken2022TokenAccountExtensionTypes,
} = require("../dist/normalization/token2022Extensions.js");

const MINT_ADDRESS = "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP";
const SPL_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT_IDS = [1, 3, 4, 6, 9, 10, 12, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28];
const ACCOUNT_IDS = [2, 5, 7, 8, 11, 13, 15, 17, 27];
const MAPPING = [
  [1, "TransferFeeConfig", "mint"],
  [2, "TransferFeeAmount", "account"],
  [3, "MintCloseAuthority", "mint"],
  [4, "ConfidentialTransferMint", "mint"],
  [5, "ConfidentialTransferAccount", "account"],
  [6, "DefaultAccountState", "mint"],
  [7, "ImmutableOwner", "account"],
  [8, "MemoTransfer", "account"],
  [9, "NonTransferable", "mint"],
  [10, "InterestBearingConfig", "mint"],
  [11, "CpiGuard", "account"],
  [12, "PermanentDelegate", "mint"],
  [13, "NonTransferableAccount", "account"],
  [14, "TransferHook", "mint"],
  [15, "TransferHookAccount", "account"],
  [16, "ConfidentialTransferFeeConfig", "mint"],
  [17, "ConfidentialTransferFeeAmount", "account"],
  [18, "MetadataPointer", "mint"],
  [19, "TokenMetadata", "mint"],
  [20, "GroupPointer", "mint"],
  [21, "TokenGroup", "mint"],
  [22, "GroupMemberPointer", "mint"],
  [23, "TokenGroupMember", "mint"],
  [24, "ConfidentialMintBurn", "mint"],
  [25, "ScaledUiAmount", "mint"],
  [26, "Pausable", "mint"],
  [27, "PausableAccount", "account"],
  [28, "PermissionedBurn", "mint"],
];

function mintBase() {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(123n, 36);
  data[44] = 6;
  data[45] = 1;
  return data;
}

function token2022Mint(entries = [], options = {}) {
  const payloadLengths = entries.map((entry) => entry.payloadLength ?? 0);
  const tlvLength = entries.reduce((sum, _entry, index) => sum + 4 + payloadLengths[index], 0);
  const data = Buffer.alloc(options.totalLength ?? 166 + tlvLength);
  mintBase().copy(data);
  data[165] = options.discriminator ?? 1;
  let cursor = 166;
  for (let index = 0; index < entries.length; index += 1) {
    data.writeUInt16LE(entries[index].id, cursor);
    data.writeUInt16LE(payloadLengths[index], cursor + 2);
    cursor += 4 + payloadLengths[index];
  }
  if (options.terminator) data.writeUInt16LE(0, cursor);
  if (options.nonzeroPadding) data[100] = 1;
  return data;
}

function account(data, owner = TOKEN_2022_PROGRAM_ID) {
  return { requestedAddress: MINT_ADDRESS, owner, dataBase64: data.toString("base64") };
}

function mintResolution(rawAccount) {
  const result = normalizeSolanaMintAccount(rawAccount);
  assert.equal(result.isMint, true);
  return result;
}

function inventory(data, resolved = mintResolution(account(mintBase())), overrides = {}) {
  return normalizeSolanaToken2022MintExtensionInventory({
    account: account(data),
    mint: resolved,
    ...overrides,
  });
}

test("pins enum names, numeric order, and exact Mint/Account context partition for IDs 1-28", () => {
  assert.deepEqual(MAPPING.map(([id]) => id), Array.from({ length: 28 }, (_, index) => index + 1));
  assert.deepEqual(MAPPING.map(([id, extensionName, context]) => [
    id,
    getToken2022ExtensionDefinition(id)?.extensionName,
    getToken2022ExtensionDefinition(id)?.context,
  ]), MAPPING);
  assert.deepEqual(MINT_IDS, MAPPING.filter(([, , context]) => context === "mint").map(([id]) => id));
  assert.deepEqual(ACCOUNT_IDS, MAPPING.filter(([, , context]) => context === "account").map(([id]) => id));
});

test("shared low-level parsers enforce the pinned context partition for every ID 1-28", () => {
  for (const [id, , context] of MAPPING) {
    const mintData = token2022Mint([{ id, payloadLength: 0 }]);
    if (context === "mint") {
      assert.deepEqual(parseToken2022MintExtensionEntries(mintData), [{ extensionTypeId: id, payloadLength: 0 }]);
      assert.deepEqual(parseToken2022MintExtensionTypes(mintData), [id]);
    } else {
      assert.equal(parseToken2022MintExtensionEntries(mintData), null);
    }

    const accountData = Buffer.alloc(170);
    accountData[165] = 2;
    accountData.writeUInt16LE(id, 166);
    accountData.writeUInt16LE(0, 168);
    if (context === "account") assert.deepEqual(parseToken2022TokenAccountExtensionTypes(accountData), [id]);
    else assert.equal(parseToken2022TokenAccountExtensionTypes(accountData), null);
  }
});

test("classic SPL mint is explicitly not applicable", () => {
  const raw = account(mintBase(), SPL_PROGRAM_ID);
  const result = normalizeSolanaToken2022MintExtensionInventory({ account: raw, mint: mintResolution(raw) });
  assert.deepEqual(result, {
    schemaVersion: "solana-token-2022-mint-extension-inventory-v1",
    chain: "solana",
    mintAddress: MINT_ADDRESS,
    tokenProgram: "spl-token",
    status: "not_applicable",
  });
});

test("an 82-byte Token-2022 mint produces available empty inventory", () => {
  const raw = account(mintBase());
  const result = normalizeSolanaToken2022MintExtensionInventory({ account: raw, mint: mintResolution(raw) });
  assert.equal(result.status, "available");
  assert.deepEqual(result.extensions, []);
});

test("extended Token-2022 mint exposes pinned names and TLV payload lengths only", () => {
  const raw = account(token2022Mint([{ id: 3, payloadLength: 1 }]));
  const result = normalizeSolanaToken2022MintExtensionInventory({ account: raw, mint: mintResolution(raw) });
  assert.deepEqual(result, {
    schemaVersion: "solana-token-2022-mint-extension-inventory-v1",
    chain: "solana",
    mintAddress: MINT_ADDRESS,
    tokenProgram: "token-2022",
    status: "available",
    extensions: [{ extensionTypeId: 3, extensionName: "MintCloseAuthority", payloadLength: 1 }],
  });
});

test("multiple TLV extensions are sorted by ID regardless of byte order", () => {
  const raw = account(token2022Mint([
    { id: 24, payloadLength: 2 },
    { id: 3, payloadLength: 1 },
    { id: 1, payloadLength: 0 },
  ]));
  const result = normalizeSolanaToken2022MintExtensionInventory({ account: raw, mint: mintResolution(raw) });
  assert.deepEqual(result.extensions.map((entry) => entry.extensionTypeId), [1, 3, 24]);
  assert.deepEqual(result.extensions.map((entry) => entry.extensionName), [
    "TransferFeeConfig", "MintCloseAuthority", "ConfidentialMintBurn",
  ]);
  assert.deepEqual(result.extensions.map((entry) => entry.payloadLength), [0, 1, 2]);
});

test("duplicate mint extension IDs make the inventory malformed without deduplication", () => {
  const raw = account(token2022Mint([{ id: 3, payloadLength: 0 }, { id: 3, payloadLength: 0 }]));
  const result = normalizeSolanaToken2022MintExtensionInventory({ account: raw, mint: mintResolution(raw) });
  assert.deepEqual(result, {
    schemaVersion: "solana-token-2022-mint-extension-inventory-v1",
    chain: "solana",
    mintAddress: MINT_ADDRESS,
    tokenProgram: "token-2022",
    status: "malformed",
    reason: "duplicate_extension_type",
  });
});

test("unknown and account-only mint IDs cannot become successful inventory", () => {
  const validResolution = mintResolution(account(mintBase()));
  for (const data of [token2022Mint([{ id: 65500, payloadLength: 0 }]), token2022Mint([{ id: 2, payloadLength: 0 }])]) {
    assert.throws(() => inventory(data, validResolution), /do not match the resolved mint evidence/);
  }
});

test("malformed layouts and special 355-byte data cannot produce inventory", () => {
  const validResolution = mintResolution(account(mintBase()));
  const truncatedHeader = Buffer.alloc(168);
  mintBase().copy(truncatedHeader);
  truncatedHeader[165] = 1;
  truncatedHeader.writeUInt16LE(3, 166);

  const overlongPayload = Buffer.alloc(170);
  mintBase().copy(overlongPayload);
  overlongPayload[165] = 1;
  overlongPayload.writeUInt16LE(3, 166);
  overlongPayload.writeUInt16LE(4, 168);

  const missingDiscriminator = Buffer.alloc(165);
  mintBase().copy(missingDiscriminator);

  const cases = [
    truncatedHeader,
    overlongPayload,
    token2022Mint([], { nonzeroPadding: true }),
    token2022Mint([], { discriminator: 2 }),
    missingDiscriminator,
    token2022Mint([], { totalLength: 355 }),
  ];
  for (const data of cases) {
    assert.throws(() => inventory(data, validResolution), /do not match the resolved mint evidence/);
  }
});

test("zero terminator and final one-byte reallocation tail preserve parser behavior", () => {
  const withTerminator = token2022Mint([{ id: 3, payloadLength: 1 }], { totalLength: 174, terminator: true });
  withTerminator[173] = 0xaa; // allocated byte after the zero-type terminator
  const terminated = inventory(withTerminator);
  assert.equal(terminated.status, "available");
  assert.deepEqual(terminated.extensions.map((entry) => entry.extensionTypeId), [3]);

  const withTail = token2022Mint([{ id: 3, payloadLength: 0 }], { totalLength: 171 });
  withTail[170] = 0xff;
  assert.equal(inventory(withTail).status, "available");
});

test("identity and token-program contradictions are rejected", () => {
  const raw = account(mintBase());
  const resolved = mintResolution(raw);
  assert.throws(() => normalizeSolanaToken2022MintExtensionInventory({
    account: { ...raw, requestedAddress: "11111111111111111111111111111111" }, mint: resolved,
  }), /identity does not match/);
  assert.throws(() => normalizeSolanaToken2022MintExtensionInventory({
    account: { ...raw, owner: SPL_PROGRAM_ID }, mint: resolved,
  }), /owner does not match/);
  assert.throws(() => normalizeSolanaToken2022MintExtensionInventory({
    account: raw,
    mint: { ...resolved, tokenProgram: "spl-token" },
  }), /owner does not match/);
});

test("inventory construction does not mutate its account input or call a provider", () => {
  const raw = account(token2022Mint([{ id: 3, payloadLength: 2 }]));
  const before = { ...raw };
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => { fetchCalls += 1; throw new Error("unexpected provider call"); };
  try {
    const result = normalizeSolanaToken2022MintExtensionInventory({ account: raw, mint: mintResolution(raw) });
    assert.equal(result.status, "available");
  } finally {
    global.fetch = originalFetch;
  }
  assert.deepEqual(raw, before);
  assert.equal(fetchCalls, 0);
});
