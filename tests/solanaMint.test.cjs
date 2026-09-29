const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeSolanaMintAccount } = require("../dist/normalization/solanaMint.js");

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT_BASE_SIZE = 82;
const ACCOUNT_BASE_SIZE = 165;
const TYPE_OFFSET = 165;
const TLV_OFFSET = 166;
const MAX_U64 = 18446744073709551615n;

function createMintBase({ initialized = true, supply = 123456789n, decimals = 6 } = {}) {
  const data = Buffer.alloc(MINT_BASE_SIZE);
  data.writeBigUInt64LE(supply, 36);
  data[44] = decimals;
  data[45] = initialized ? 1 : 0;
  return data;
}

function createTokenAccount({ state = 1 } = {}) {
  const data = Buffer.alloc(ACCOUNT_BASE_SIZE);
  data[108] = state;
  return data;
}

function createExtendedMint({
  extensionType = 3,
  extensionLength = 32,
  declaredLength = extensionLength,
  totalLength = TLV_OFFSET + 4 + extensionLength,
} = {}) {
  const data = Buffer.alloc(totalLength);
  createMintBase().copy(data, 0);
  data[TYPE_OFFSET] = 1;
  data.writeUInt16LE(extensionType, TLV_OFFSET);
  data.writeUInt16LE(declaredLength, TLV_OFFSET + 2);
  return data;
}

function normalize(owner, data) {
  return normalizeSolanaMintAccount({
    owner,
    dataBase64: data.toString("base64"),
  });
}

function expectNotMint(result) {
  assert.deepEqual(result, { exists: true, isMint: false });
}

test("recognizes a classic initialized 82-byte SPL Token mint", () => {
  const result = normalize(SPL_TOKEN_PROGRAM_ID, createMintBase());
  assert.deepEqual(result, {
    exists: true,
    isMint: true,
    tokenProgram: "spl-token",
    decimals: 6,
    rawSupply: "123456789",
  });
});

test("rejects a classic uninitialized mint", () => {
  expectNotMint(normalize(SPL_TOKEN_PROGRAM_ID, createMintBase({ initialized: false })));
});

test("does not classify a classic SPL token account as a mint", () => {
  expectNotMint(normalize(SPL_TOKEN_PROGRAM_ID, createTokenAccount()));
});

test("recognizes a Token-2022 82-byte mint without extensions", () => {
  const result = normalize(TOKEN_2022_PROGRAM_ID, createMintBase());
  assert.deepEqual(result, {
    exists: true,
    isMint: true,
    tokenProgram: "token-2022",
    decimals: 6,
    rawSupply: "123456789",
  });
});

test("recognizes an extended Token-2022 mint with common-base padding and TLV data", () => {
  const data = createExtendedMint();
  const result = normalize(TOKEN_2022_PROGRAM_ID, data);
  assert.deepEqual(result, {
    exists: true,
    isMint: true,
    tokenProgram: "token-2022",
    decimals: 6,
    rawSupply: "123456789",
  });
});

test("does not classify a Token-2022 token account as a mint", () => {
  const result = normalize(TOKEN_2022_PROGRAM_ID, createTokenAccount());
  expectNotMint(result);
});

test("a Token-2022 token account with byte 82 equal to 1 is not a false mint", () => {
  const data = createTokenAccount();
  data[82] = 1;
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("rejects nonzero padding in an extended Token-2022 mint", () => {
  const data = createExtendedMint();
  data[100] = 1;
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("rejects the wrong Token-2022 mint discriminator", () => {
  const data = createExtendedMint();
  data[TYPE_OFFSET] = 2;
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("rejects a truncated TLV header", () => {
  const data = Buffer.alloc(TLV_OFFSET + 2);
  createMintBase().copy(data, 0);
  data[TYPE_OFFSET] = 1;
  data.writeUInt16LE(3, TLV_OFFSET);
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("rejects a truncated TLV value", () => {
  const data = createExtendedMint({ extensionLength: 31, declaredLength: 32 });
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("rejects an unknown SPL extension type", () => {
  const data = createExtendedMint({ extensionType: 65500, extensionLength: 0 });
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("rejects an account-only extension type in a Token-2022 mint", () => {
  const data = createExtendedMint({ extensionType: 2, extensionLength: 8 });
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("accepts SPL TLV uninitialized termination with trailing allocated bytes", () => {
  const data = createExtendedMint({ totalLength: TLV_OFFSET + 4 + 32 + 3 });
  data.writeUInt16LE(0, TLV_OFFSET + 4 + 32);
  data[TLV_OFFSET + 4 + 32 + 2] = 0xaa;
  assert.equal(normalize(TOKEN_2022_PROGRAM_ID, data).isMint, true);
});

test("accepts the single trailing reallocation byte permitted by SPL TLV iteration", () => {
  const data = createExtendedMint({ totalLength: TLV_OFFSET + 4 + 32 + 1 });
  data[data.length - 1] = 0xff;
  assert.equal(normalize(TOKEN_2022_PROGRAM_ID, data).isMint, true);
});

test("rejects the 355-byte special multisig-sized layout", () => {
  const data = createExtendedMint({ totalLength: 355 });
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

test("preserves the maximum u64 raw supply exactly as a decimal string", () => {
  const result = normalize(TOKEN_2022_PROGRAM_ID, createMintBase({ supply: MAX_U64 }));
  assert.equal(result.isMint, true);
  if (!result.isMint) {
    assert.fail("Expected a Token-2022 mint.");
  }
  assert.equal(result.rawSupply, "18446744073709551615");
});

test("rejects a Token-2022 uninitialized mint base", () => {
  const data = createExtendedMint();
  data[45] = 0;
  expectNotMint(normalize(TOKEN_2022_PROGRAM_ID, data));
});

