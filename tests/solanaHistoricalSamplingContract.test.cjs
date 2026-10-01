const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require("typescript");
const { test } = require("node:test");

test("bounded Solana historical evidence states are type-safe and exclude cursor values", () => {
  const fixture = path.resolve("tests/solanaHistoricalSampling.typecheck.ts");
  const options = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    types: ["node"],
  };
  const program = ts.createProgram([fixture], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => "\n",
  });
  assert.equal(diagnostics.length, 0, formatted);
});
