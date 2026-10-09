const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const MINT = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PRIVATE_CURSOR = "9ABcdefghijkLMNP";
const TEST_KEY = "cli-test-key-not-a-real-credential";

test("partial CLI output keeps aggregates but excludes owner rows, account rows, and cursors", () => {
  const script = `
    const mint = ${JSON.stringify(MINT)};
    const tokenProgram = ${JSON.stringify(TOKEN_PROGRAM)};
    const cursor = ${JSON.stringify(PRIVATE_CURSOR)};
    process.env.HELIUS_API_KEY = ${JSON.stringify(TEST_KEY)};
    process.argv = [process.execPath, "cli.js", mint];
    const mintData = Buffer.alloc(82);
    mintData.writeBigUInt64LE(1000n, 36);
    mintData[44] = 6;
    mintData[45] = 1;
    const tokenData = Buffer.alloc(165);
    tokenData.writeBigUInt64LE(25n, 64);
    tokenData[108] = 1;
    let pageCalls = 0;
    global.fetch = async (url, init) => {
      if (url.startsWith("https://api.dexscreener.com/")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      const request = JSON.parse(init.body);
      if (request.method === "getAccountInfo") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
          context: { slot: 1 }, value: { owner: tokenProgram, data: [mintData.toString("base64"), "base64"] },
        } }), { status: 200 });
      }
      if (request.method === "getProgramAccountsV2") {
        pageCalls += 1;
        if (pageCalls === 1) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: "token-accounts", result: {
            context: { slot: 2 }, value: { accounts: [{ pubkey: mint, account: {
              owner: tokenProgram, data: [tokenData.toString("base64"), "base64"], space: 165,
            } }], paginationKey: cursor },
          } }), { status: 200 });
        }
        return new Response("", { status: 503 });
      }
      throw new Error("unexpected mocked request");
    };
    require("./dist/cli.js");
  `;
  const child = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout.trim());
  assert.equal(output.holderAcquisition.status, "available");
  assert.equal(output.holderAcquisition.completeness, "partial");
  assert.equal(output.holderAcquisition.stopReason, "provider_error");
  assert.equal(output.holderStructure.enumeration.completeness, "partial");
  assert.equal(output.ownerAuthorityBalanceDistribution.observedOwnerAuthorityCount, 1);
  assert.equal(child.stdout.includes("rawOwnerAuthorities"), false);
  assert.equal(child.stdout.includes("ownerAddress"), false);
  assert.equal(child.stdout.includes("pubkey"), false);
  assert.equal(child.stdout.includes("paginationKey"), false);
  assert.equal(child.stdout.includes(PRIVATE_CURSOR), false);
  assert.equal(child.stdout.includes(TEST_KEY), false);
});
