const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const {
  createSolanaTokenEvidenceAdmissionController,
  SolanaTokenEvidenceAdmissionControllerRejectionError,
} = require("../dist/application/solanaTokenEvidenceAdmissionController.js");
const {
  executeSolanaTokenEvidencePublicRequest,
  SolanaTokenEvidenceAdmissionError,
} = require("../dist/application/solanaTokenEvidencePublicExecution.js");
const { SolanaExecutionCancelledError } = require("../dist/types/solanaTrustedExecutionContext.js");
const { createSolanaProviderRequestBudgetController } = require("../dist/application/solanaProviderRequestBudgetController.js");

const ADDRESS = "11111111111111111111111111111111";
const REQUEST = { chain: "solana", assetAddress: ADDRESS, historicalTransactions: { status: "not_requested" } };

function makeController(maxConcurrentExecutions = 1, initiallyEnabled = true) {
  return createSolanaTokenEvidenceAdmissionController({ maxConcurrentExecutions, initiallyEnabled });
}

function capacityError(reason) {
  return (error) => {
    assert.ok(error instanceof SolanaTokenEvidenceAdmissionControllerRejectionError);
    assert.ok(error instanceof SolanaTokenEvidenceAdmissionError);
    assert.equal(error.category, "admission_rejected");
    assert.equal(error.reason, reason);
    assert.equal(error.message.includes("capacity"), false);
    assert.equal(JSON.stringify(error).includes(ADDRESS), false);
    return true;
  };
}

test("requires an explicit positive safe-integer limit and explicit boolean initial state", () => {
  for (const invalid of [undefined, null, {}, [], { maxConcurrentExecutions: 1 }, { initiallyEnabled: true }]) {
    assert.throws(() => createSolanaTokenEvidenceAdmissionController(invalid), TypeError);
  }
  for (const limit of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSolanaTokenEvidenceAdmissionController({ maxConcurrentExecutions: limit, initiallyEnabled: true }), TypeError);
  }
  for (const initiallyEnabled of [undefined, null, 0, 1, "true"]) {
    assert.throws(() => createSolanaTokenEvidenceAdmissionController({ maxConcurrentExecutions: 1, initiallyEnabled }), TypeError);
  }
  assert.doesNotThrow(() => makeController(1, true));
  assert.doesNotThrow(() => makeController(Number.MAX_SAFE_INTEGER, false));
});

test("reserves synchronously below capacity and rejects immediately at capacity", async () => {
  const controller = makeController(2);
  const firstPromise = controller.acquire(REQUEST);
  assert.deepEqual(controller.getStatus(), {
    enabled: true, activePermitCount: 1, maxConcurrentExecutions: 2, remainingCapacity: 1,
  });
  const secondPromise = controller.acquire(REQUEST);
  assert.equal(controller.getStatus().activePermitCount, 2);
  await assert.rejects(controller.acquire(REQUEST), capacityError("capacity_exhausted"));
  assert.equal(controller.getStatus().activePermitCount, 2);
  const first = await firstPromise;
  const second = await secondPromise;
  first.release();
  second.release();
  assert.equal(controller.getStatus().activePermitCount, 0);
});

test("release restores one slot and repeated release is a safe no-op", async () => {
  const controller = makeController(1);
  const permit = await controller.acquire(REQUEST);
  permit.release();
  assert.equal(controller.getStatus().remainingCapacity, 1);
  permit.release();
  assert.deepEqual(controller.getStatus(), {
    enabled: true, activePermitCount: 0, maxConcurrentExecutions: 1, remainingCapacity: 1,
  });
});

test("concurrent callers competing for the final slot yield exactly one permit", async () => {
  const controller = makeController(1);
  const outcomes = await Promise.allSettled([controller.acquire(REQUEST), controller.acquire(REQUEST)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "rejected"]);
  assert.equal(outcomes[1].reason.reason, "capacity_exhausted");
  assert.equal(controller.getStatus().activePermitCount, 1);
  outcomes[0].value.release();
  assert.equal(controller.getStatus().activePermitCount, 0);
});

test("pre-aborted trusted context rejects without reserving capacity", async () => {
  const controller = makeController(1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(controller.acquire(REQUEST, { signal: abort.signal }), SolanaExecutionCancelledError);
  assert.equal(controller.getStatus().activePermitCount, 0);
});

test("disabled controller rejects new admission and can be re-enabled", async () => {
  const controller = makeController(1, false);
  await assert.rejects(controller.acquire(REQUEST), capacityError("admission_disabled"));
  assert.equal(controller.getStatus().activePermitCount, 0);
  controller.setEnabled(true);
  const permit = await controller.acquire(REQUEST);
  assert.equal(controller.getStatus().activePermitCount, 1);
  permit.release();
});

test("disabling while active does not revoke permits and release still restores capacity", async () => {
  const controller = makeController(1);
  const permit = await controller.acquire(REQUEST);
  controller.setEnabled(false);
  await assert.rejects(controller.acquire(REQUEST), capacityError("admission_disabled"));
  assert.deepEqual(controller.getStatus(), {
    enabled: false, activePermitCount: 1, maxConcurrentExecutions: 1, remainingCapacity: 0,
  });
  permit.release();
  assert.deepEqual(controller.getStatus(), {
    enabled: false, activePermitCount: 0, maxConcurrentExecutions: 1, remainingCapacity: 1,
  });
});

test("operator state rejects non-booleans and status is a fresh immutable snapshot", async () => {
  const controller = makeController(2);
  for (const value of [undefined, null, 0, 1, "false"]) {
    assert.throws(() => controller.setEnabled(value), TypeError);
  }
  const before = controller.getStatus();
  assert.equal(Object.isFrozen(before), true);
  const permit = await controller.acquire(REQUEST);
  const after = controller.getStatus();
  assert.notEqual(before, after);
  assert.equal(before.activePermitCount, 0);
  assert.equal(after.activePermitCount, 1);
  assert.equal(after.remainingCapacity, 1);
  assert.equal(Object.keys(after).includes("assetAddress"), false);
  permit.release();
});

test("controller instances maintain independent capacity state", async () => {
  const first = makeController(1);
  const second = makeController(1);
  const held = await first.acquire(REQUEST);
  const other = await second.acquire(REQUEST);
  assert.equal(first.getStatus().activePermitCount, 1);
  assert.equal(second.getStatus().activePermitCount, 1);
  held.release();
  assert.equal(first.getStatus().activePermitCount, 0);
  assert.equal(second.getStatus().activePermitCount, 1);
  other.release();
});

test("cancellation immediately after permit reservation is released by the public execution wrapper", async () => {
  const controller = makeController(1);
  const abort = new AbortController();
  let presentations = 0;
  let budgetReservations = 0;
  const policy = {
    acquire(request, context) {
      const grant = controller.acquire(request, context);
      abort.abort();
      return grant;
    },
  };
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(REQUEST, {
    admissionPolicy: policy,
    providerRequestBudgetController: { reserve() { budgetReservations += 1; throw new Error("must not reserve"); } },
    executePresentation: async () => { presentations += 1; return {}; },
  }, { signal: abort.signal }), SolanaExecutionCancelledError);
  assert.equal(presentations, 0);
  assert.equal(budgetReservations, 0);
  assert.equal(controller.getStatus().activePermitCount, 0);
});

test("public execution releases capacity after success, execution failure, and cancellation", async () => {
  const controller = makeController(1);
  const result = { presentation: "unchanged" };
  const success = await executeSolanaTokenEvidencePublicRequest(REQUEST, {
    admissionPolicy: controller,
    providerRequestBudgetController: createSolanaProviderRequestBudgetController({ capacity: 100, initiallyEnabled: true }),
    executePresentation: async () => result,
  });
  assert.equal(success, result);
  assert.equal(controller.getStatus().activePermitCount, 0);

  const failure = new Error("execution failed");
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(REQUEST, {
    admissionPolicy: controller,
    providerRequestBudgetController: createSolanaProviderRequestBudgetController({ capacity: 100, initiallyEnabled: true }),
    executePresentation: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(controller.getStatus().activePermitCount, 0);

  const abort = new AbortController();
  await assert.rejects(executeSolanaTokenEvidencePublicRequest(REQUEST, {
    admissionPolicy: controller,
    providerRequestBudgetController: createSolanaProviderRequestBudgetController({ capacity: 100, initiallyEnabled: true }),
    executePresentation: async () => { throw new SolanaExecutionCancelledError(); },
  }, { signal: abort.signal }), SolanaExecutionCancelledError);
  assert.equal(controller.getStatus().activePermitCount, 0);
});

test("controller admission has no provider dependency or fetch path", () => {
  const source = readFileSync("src/application/solanaTokenEvidenceAdmissionController.ts", "utf8");
  assert.doesNotMatch(source, /providers\/|\bfetch\s*\(|https?:\/\/|setTimeout|Promise\.race|retry/i);
});

test("controller integration leaves the evidence and presentation schemas untouched", () => {
  const source = readFileSync("src/application/solanaTokenEvidenceAdmissionController.ts", "utf8");
  assert.doesNotMatch(source, /SolanaTokenEvidencePresentationV1|schemaVersion|qualification|scoring|token.?risk/i);
});
