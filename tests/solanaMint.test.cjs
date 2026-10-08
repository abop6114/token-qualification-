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
const BASE_AUTHORITIES_UNSET = {
  mintAuthority: { status: "unset", address: null },
  freezeAuthority: { status: "unset", address: null },
};

function createMintBase({
  initialized = true,
  supply = 123456789n,
  decimals = 6,
  mintAuthorityTag = 0,
  mintAuthorityBytes = Buffer.alloc(32),
  freezeAuthorityTag = 0,
  freezeAuthorityBytes = Buffer.alloc(32),
} = {}) {
  const data = Buffer.alloc(MINT_BASE_SIZE);
  data.writeUInt32LE(mintAuthorityTag, 0);
  mintAuthorityBytes.copy(data, 4);
  data.writeBigUInt64LE(supply, 36);
  data[44] = decimals;
  data[45] = initialized ? 1 : 0;
  data.writeUInt32LE(freezeAuthorityTag, 46);
  freezeAuthorityBytes.copy(data, 50);
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
  mintBaseOptions = {},
} = {}) {
  const data = Buffer.alloc(totalLength);
  createMintBase(mintBaseOptions).copy(data, 0);
  data[TYPE_OFFSET] = 1;
  data.writeUInt16LE(extensionType, TLV_OFFSET);
  data.writeUInt16LE(declaredLength, TLV_OFFSET + 2);
  return data;
}

function normalize(owner, data) {
  return normalizeSolanaMintAccount({
    requestedAddress: "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP",
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
    mintAddress: "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP",
    tokenProgram: "spl-token",
    decimals: 6,
    rawSupply: "123456789",
    baseAuthorities: BASE_AUTHORITIES_UNSET,
  });
});

test("validates the requested mint address and preserves nonexistent-account output", () => {
  assert.throws(() => normalizeSolanaMintAccount({
    requestedAddress: "not-a-public-key",
    owner: SPL_TOKEN_PROGRAM_ID,
    dataBase64: createMintBase().toString("base64"),
  }), /Requested Solana account address is malformed/);
  assert.deepEqual(normalizeSolanaMintAccount(null), { exists: false, isMint: false });
});

test("normalizes classic SPL mint authority states from base COption tags", () => {
  const knownAuthority = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  const bothUnset = normalize(SPL_TOKEN_PROGRAM_ID, createMintBase());
  assert.deepEqual(bothUnset.baseAuthorities, BASE_AUTHORITIES_UNSET);

  const mintSet = normalize(SPL_TOKEN_PROGRAM_ID, createMintBase({
    mintAuthorityTag: 1,
    mintAuthorityBytes: knownAuthority,
  }));
  assert.deepEqual(mintSet.baseAuthorities, {
    mintAuthority: { status: "set", address: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw" },
    freezeAuthority: { status: "unset", address: null },
  });

  const freezeSet = normalize(SPL_TOKEN_PROGRAM_ID, createMintBase({
    freezeAuthorityTag: 1,
    freezeAuthorityBytes: knownAuthority,
  }));
  assert.deepEqual(freezeSet.baseAuthorities, {
    mintAuthority: { status: "unset", address: null },
    freezeAuthority: { status: "set", address: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw" },
  });

  const bothSet = normalize(SPL_TOKEN_PROGRAM_ID, createMintBase({
    mintAuthorityTag: 1,
    mintAuthorityBytes: knownAuthority,
    freezeAuthorityTag: 1,
    freezeAuthorityBytes: Buffer.alloc(32, 1),
  }));
  assert.deepEqual(bothSet.baseAuthorities, {
    mintAuthority: { status: "set", address: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw" },
    freezeAuthority: { status: "set", address: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" },
  });
});

test("ignores nonzero authority payload bytes when a classic COption tag is unset", () => {
  const result = normalize(SPL_TOKEN_PROGRAM_ID, createMintBase({
    mintAuthorityBytes: Buffer.alloc(32, 0xa5),
    freezeAuthorityBytes: Buffer.alloc(32, 0x5a),
  }));
  assert.deepEqual(result.baseAuthorities, BASE_AUTHORITIES_UNSET);
});

test("invalid classic mint authority COption tags retain not-a-mint behavior", () => {
  expectNotMint(normalize(SPL_TOKEN_PROGRAM_ID, createMintBase({ mintAuthorityTag: 2 })));
});

test("invalid classic freeze authority COption tags retain not-a-mint behavior", () => {
  expectNotMint(normalize(SPL_TOKEN_PROGRAM_ID, createMintBase({ freezeAuthorityTag: 2 })));
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
    mintAddress: "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP",
    tokenProgram: "token-2022",
    decimals: 6,
    rawSupply: "123456789",
    baseAuthorities: BASE_AUTHORITIES_UNSET,
  });
});

test("decodes Token-2022 base mint authorities without interpreting extensions", () => {
  const knownAuthority = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  const data = createExtendedMint({
    mintBaseOptions: {
      mintAuthorityTag: 1,
      mintAuthorityBytes: knownAuthority,
      freezeAuthorityTag: 1,
      freezeAuthorityBytes: Buffer.alloc(32, 1),
    },
  });
  const result = normalize(TOKEN_2022_PROGRAM_ID, data);
  assert.deepEqual(result.baseAuthorities, {
    mintAuthority: { status: "set", address: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw" },
    freezeAuthority: { status: "set", address: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" },
  });
  assert.equal(result.tokenProgram, "token-2022");
  assert.equal(result.rawSupply, "123456789");
  assert.equal(result.decimals, 6);
});

test("recognizes an extended Token-2022 mint with common-base padding and TLV data", () => {
  const data = createExtendedMint();
  const result = normalize(TOKEN_2022_PROGRAM_ID, data);
  assert.deepEqual(result, {
    exists: true,
    isMint: true,
    mintAddress: "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP",
    tokenProgram: "token-2022",
    decimals: 6,
    rawSupply: "123456789",
    baseAuthorities: BASE_AUTHORITIES_UNSET,
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

