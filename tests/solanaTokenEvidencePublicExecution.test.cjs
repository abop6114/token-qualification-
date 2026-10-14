const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const {
  executeSolanaTokenEvidencePublicRequest,
  SolanaTokenEvidenceAdmissionError,
  SolanaTokenEvidencePublicExecutionError,
} = require("../dist/application/solanaTokenEvidencePublicExecution.js");
const {
  SolanaTokenEvidencePublicRequestError,
} = require("../dist/application/solanaTokenEvidencePublicRequest.js");
const { SolanaExecutionCancelledError } = require("../dist/types/solanaTrustedExecutionContext.js");

const ADDRESS = "11111111111111111111111111111111";

function dependencies({ acquire, executePresentation }) {
  return {
    admissionPolicy: { acquire },
    executePresentation,
  };
}

function permit(release = () => {}) {
  return { release };
}

function publicInput(extra = {}) {
  return { chain: "solana", assetAddress: ADDRESS, ...extra };
}

test("validates public input before admission and execution", async () => {
  let admissions = 0;
  let executions = 0;
  await assert.rejects(
    executeSolanaTokenEvidencePublicRequest({ chain: "solana", assetAddress: "invalid" }, dependencies({
      acquire: async () => { admissions += 1; return permit(); },
      executePresentation: async () => { executions += 1; return {}; },
    })),
    (error) => error instanceof SolanaTokenEvidencePublicRequestError && error.category === "invalid_asset_address",
  );
  assert.equal(admissions, 0);
  assert.equal(executions, 0);
});

test("passes only a copied validated request to admission and executes the original parsed request", async () => {
  const input = publicInput();
  const inputBefore = structuredClone(input);
  const observed = [];
  let admissionRequest;
  let executionRequest;
  const result = { report: { marker: "same result object" } };
  const response = await executeSolanaTokenEvidencePublicRequest(input, dependencies({
    acquire: async (request) => {
      observed.push("acquire");
      admissionRequest = request;
      request.assetAddress = "mutated by policy";
      request.historicalTransactions.status = "invalid";
      return permit(async () => { observed.push("release"); });
    },
    executePresentation: async (request) => {
      observed.push("execute");
      executionRequest = request;
      return result;
    },
  }));

  assert.deepEqual(observed, ["acquire", "execute", "release"]);
  assert.notEqual(admissionRequest, executionRequest);
  assert.deepEqual(admissionRequest, {
    chain: "solana", assetAddress: "mutated by policy", historicalTransactions: { status: "invalid" },
  });
  assert.deepEqual(executionRequest, {
    chain: "solana", assetAddress: ADDRESS, historicalTransactions: { status: "not_requested" },
  });
  assert.deepEqual(input, inputBefore);
  assert.equal(response, result);
});

test("maps requested public history bounds to the internal inclusive/exclusive window", async () => {
  let admitted;
  let executed;
  await executeSolanaTokenEvidencePublicRequest(publicInput({
    historicalTransactions: {
      status: "requested",
      startTimeUnixSeconds: 100,
      endTimeUnixSecondsExclusive: 200,
    },
  }), dependencies({
    acquire: async (request) => { admitted = request; return permit(); },
    executePresentation: async (request) => { executed = request; return {}; },
  }));
  const expected = {
    chain: "solana",
    assetAddress: ADDRESS,
    historicalTransactions: {
      status: "requested",
      requestedWindow: { fromUnixSecondsInclusive: 100, toUnixSecondsExclusive: 200 },
    },
  };
  assert.deepEqual(admitted, expected);
  assert.deepEqual(executed, expected);
});

test("fails closed when admission policy is missing and never executes", async (t) => {
  let executions = 0;
  for (const deps of [{}, null, { admissionPolicy: null }]) {
    await t.test(String(deps), async () => {
      await assert.rejects(
        executeSolanaTokenEvidencePublicRequest(publicInput(), deps),
        (error) => error instanceof SolanaTokenEvidenceAdmissionError && error.category === "admission_unavailable",
      );
      assert.equal(executions, 0);
    });
  }
});

test("preserves an explicit admission rejection without executing or releasing", async () => {
  let executions = 0;
  const rejection = new SolanaTokenEvidenceAdmissionError("admission_rejected");
  await assert.rejects(
    executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
      acquire: async () => { throw rejection; },
      executePresentation: async () => { executions += 1; return {}; },
    })),
    (error) => error === rejection,
  );
  assert.equal(executions, 0);
});

test("sanitizes unexpected admission failures", async () => {
  const sentinel = "private-admission-detail";
  let executions = 0;
  await assert.rejects(
    executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
      acquire: async () => { throw new Error(sentinel); },
      executePresentation: async () => { executions += 1; return {}; },
    })),
    (error) => {
      assert.ok(error instanceof SolanaTokenEvidencePublicExecutionError);
      assert.equal(error.category, "internal_operational_failure");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      return true;
    },
  );
  assert.equal(executions, 0);
});

test("rejects a malformed permit before execution", async () => {
  let executions = 0;
  await assert.rejects(
    executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
      acquire: async () => ({ release: "not callable" }),
      executePresentation: async () => { executions += 1; return {}; },
    })),
    (error) => error instanceof SolanaTokenEvidencePublicExecutionError && error.category === "internal_operational_failure",
  );
  assert.equal(executions, 0);
});

test("executes once after acquisition and releases the permit exactly once", async () => {
  const calls = [];
  const result = { presentation: "ready" };
  const actual = await executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => { calls.push("acquire"); return permit(() => { calls.push("release"); }); },
    executePresentation: async () => { calls.push("execute"); return result; },
  }));
  assert.deepEqual(calls, ["acquire", "execute", "release"]);
  assert.equal(actual, result);
});

test("awaits asynchronous permit release before returning", async () => {
  const calls = [];
  const actual = await executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => permit(async () => {
      await Promise.resolve();
      calls.push("released");
    }),
    executePresentation: async () => { calls.push("executed"); return "result"; },
  }));
  assert.deepEqual(calls, ["executed", "released"]);
  assert.equal(actual, "result");
});

test("propagates presentation failures unchanged and still releases exactly once", async () => {
  const calls = [];
  const failure = new Error("offline presentation failure");
  await assert.rejects(
    executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
      acquire: async () => permit(() => { calls.push("release"); }),
      executePresentation: async () => { calls.push("execute"); throw failure; },
    })),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["execute", "release"]);
});

test("presentation failure takes precedence over a simultaneous permit-release failure", async () => {
  const failure = new Error("presentation sentinel");
  await assert.rejects(
    executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
      acquire: async () => permit(() => { throw new Error("release sentinel"); }),
      executePresentation: async () => { throw failure; },
    })),
    (error) => error === failure,
  );
});

test("reports a sanitized release failure after successful presentation", async () => {
  const sentinel = "permit-release-secret";
  const result = { ok: true };
  await assert.rejects(
    executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
      acquire: async () => permit(() => { throw new Error(sentinel); }),
      executePresentation: async () => result,
    })),
    (error) => {
      assert.ok(error instanceof SolanaTokenEvidencePublicExecutionError);
      assert.equal(error.category, "permit_release_failed");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      return true;
    },
  );
});

test("uses the existing presentation composition service by default", () => {
  const source = readFileSync("src/application/solanaTokenEvidencePublicExecution.ts", "utf8");
  assert.match(source, /generateSolanaTokenEvidencePresentation/);
  assert.match(source, /from "\.\/solanaTokenEvidencePresentationService"/);
  assert.doesNotMatch(source, /generateSolanaTokenEvidenceReport\s*\(|presentSolanaTokenEvidenceReport\s*\(/);
});

test("does not introduce transport, provider, retry, cache, or telemetry execution", () => {
  const source = readFileSync("src/application/solanaTokenEvidencePublicExecution.ts", "utf8");
  assert.doesNotMatch(source, /providers\/|fetch\s*\(|https?:\/\/|AbortController|setTimeout|Promise\.race|\bretry\b|\bcache\b|OperationalTelemetry|\bscoring\b|\bAI\b/i);
});

test("admission receives a detached request rather than the original public object", async () => {
  const input = publicInput({
    historicalTransactions: {
      status: "requested", startTimeUnixSeconds: 5, endTimeUnixSecondsExclusive: 9,
    },
  });
  let admissionRequest;
  await executeSolanaTokenEvidencePublicRequest(input, dependencies({
    acquire: async (request) => { admissionRequest = request; return permit(); },
    executePresentation: async () => ({ ok: true }),
  }));
  assert.notEqual(admissionRequest, input);
  assert.notEqual(admissionRequest.historicalTransactions, input.historicalTransactions);
});

test("pre-cancelled trusted context prevents admission and execution", async () => {
  const controller = new AbortController();
  controller.abort();
  let admissions = 0;
  let executions = 0;
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => { admissions += 1; return permit(); },
    executePresentation: async () => { executions += 1; return {}; },
  }), { signal: controller.signal }), SolanaExecutionCancelledError);
  assert.equal(admissions, 0);
  assert.equal(executions, 0);
});

test("late admission permit is released once after cancellation and presentation is not started", async () => {
  const controller = new AbortController();
  let finishAcquire;
  const acquiring = new Promise((resolve) => { finishAcquire = resolve; });
  const calls = [];
  const operation = executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async (_request, context) => {
      assert.equal(context.signal, controller.signal);
      calls.push("acquire");
      await acquiring;
      return permit(() => { calls.push("release"); });
    },
    executePresentation: async () => { calls.push("execute"); return {}; },
  }), { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  finishAcquire();
  await assert.rejects(operation, SolanaExecutionCancelledError);
  assert.deepEqual(calls, ["acquire", "release"]);
});

test("admission cancellation rejection remains caller cancellation rather than an internal failure", async () => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let executions = 0;
  const operation = executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async (_request, context) => {
      assert.equal(context.signal, controller.signal);
      markStarted();
      await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      throw context.signal.reason;
    },
    executePresentation: async () => { executions += 1; return {}; },
  }), { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(operation, SolanaExecutionCancelledError);
  assert.equal(executions, 0);
});

test("a typed admission rejection remains authoritative when cancellation overlaps", async () => {
  const controller = new AbortController();
  const rejection = new SolanaTokenEvidenceAdmissionError("admission_rejected");
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => { controller.abort(); throw rejection; },
    executePresentation: async () => ({}),
  }), { signal: controller.signal }), (error) => error === rejection);
});

test("an unrelated admission failure is sanitized rather than inferred as cancellation from signal state", async () => {
  const controller = new AbortController();
  const sentinel = "unrelated-admission-failure";
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => { controller.abort(); throw new Error(sentinel); },
    executePresentation: async () => ({}),
  }), { signal: controller.signal }), (error) => {
    assert.ok(error instanceof SolanaTokenEvidencePublicExecutionError);
    assert.equal(error.category, "internal_operational_failure");
    assert.equal(error.message.includes(sentinel), false);
    return true;
  });
});

test("cancellation before successful execution finalization prevents normal success", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => permit(() => { calls.push("release"); }),
    executePresentation: async () => { controller.abort(); return { ok: true }; },
  }), { signal: controller.signal }), SolanaExecutionCancelledError);
  assert.deepEqual(calls, ["release"]);
});

test("cancellation during permit cleanup does not retroactively invalidate finalized success", async () => {
  const controller = new AbortController();
  const result = { ok: "finalized" };
  let releases = 0;
  const actual = await executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => permit(async () => { releases += 1; controller.abort(); await Promise.resolve(); }),
    executePresentation: async () => result,
  }), { signal: controller.signal });
  assert.equal(actual, result);
  assert.equal(releases, 1);
});

test("a primary cancellation remains visible when permit cleanup also fails", async () => {
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(publicInput(), dependencies({
    acquire: async () => permit(() => { throw new Error("release failed"); }),
    executePresentation: async () => { throw new SolanaExecutionCancelledError(); },
  })), SolanaExecutionCancelledError);
});

test("trusted cancellation context cannot be supplied as public JSON", async () => {
  let admissions = 0;
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(publicInput({ signal: "untrusted" }), dependencies({
    acquire: async () => { admissions += 1; return permit(); },
    executePresentation: async () => ({}),
  })), SolanaTokenEvidencePublicRequestError);
  assert.equal(admissions, 0);
});

