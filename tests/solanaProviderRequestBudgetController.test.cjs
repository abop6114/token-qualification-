const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const {
  createSolanaProviderRequestBudgetController,
} = require("../dist/application/solanaProviderRequestBudgetController.js");
const {
  SolanaProviderRequestBudgetError,
} = require("../dist/types/solanaProviderRequestBudget.js");

function makeController(capacity = 4, initiallyEnabled = true) {
  return createSolanaProviderRequestBudgetController({ capacity, initiallyEnabled });
}

function rejection(reason) {
  return (error) => {
    assert.ok(error instanceof SolanaProviderRequestBudgetError);
    assert.equal(error.reason, reason);
    return true;
  };
}

function assertLedger(controller) {
  const status = controller.getStatus();
  assert.ok(status.available >= 0);
  assert.ok(status.reservedUnused >= 0);
  assert.ok(status.consumed >= 0);
  assert.ok(Number.isSafeInteger(status.available + status.reservedUnused + status.consumed));
  assert.equal(status.available + status.reservedUnused + status.consumed, status.capacity);
}

test("requires positive safe-integer capacity and an explicit boolean enabled state", () => {
  for (const input of [undefined, null, {}, [], { capacity: 1 }, { initiallyEnabled: true }]) {
    assert.throws(() => createSolanaProviderRequestBudgetController(input), TypeError);
  }
  for (const capacity of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSolanaProviderRequestBudgetController({ capacity, initiallyEnabled: true }), TypeError);
  }
  for (const initiallyEnabled of [undefined, null, 0, 1, "true"]) {
    assert.throws(() => createSolanaProviderRequestBudgetController({ capacity: 1, initiallyEnabled }), TypeError);
  }
  assert.doesNotThrow(() => makeController(Number.MAX_SAFE_INTEGER, false));
});

test("reservation validates positive safe integers and fails atomically for disabled or insufficient capacity", () => {
  const controller = makeController(3);
  for (const units of [undefined, null, 0, -1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => controller.reserve(units), TypeError);
  }
  assert.throws(() => controller.reserve(4), rejection("insufficient_allowance"));
  assert.deepEqual(controller.getStatus(), {
    enabled: true, capacity: 3, available: 3, reservedUnused: 0, consumed: 0,
  });
  controller.setEnabled(false);
  assert.throws(() => controller.reserve(1), rejection("controller_disabled"));
  assert.equal(controller.getStatus().available, 3);
  assertLedger(controller);
});

test("an initially disabled controller blocks admission until explicitly re-enabled", () => {
  const controller = makeController(2, false);
  assert.deepEqual(controller.getStatus(), {
    enabled: false, capacity: 2, available: 2, reservedUnused: 0, consumed: 0,
  });
  assert.throws(() => controller.reserve(1), rejection("controller_disabled"));
  controller.setEnabled(true);
  const lease = controller.reserve(2);
  assert.equal(controller.getStatus().available, 0);
  lease.settle();
  assert.equal(controller.getStatus().available, 2);
  assertLedger(controller);
});

test("reserve, consume, and settlement preserve the accounting invariant", () => {
  const controller = makeController(5);
  const lease = controller.reserve(3);
  assert.deepEqual(controller.getStatus(), {
    enabled: true, capacity: 5, available: 2, reservedUnused: 3, consumed: 0,
  });
  lease.consume();
  assert.deepEqual(controller.getStatus(), {
    enabled: true, capacity: 5, available: 2, reservedUnused: 2, consumed: 1,
  });
  assert.deepEqual(lease.getStatus(), { allowance: 3, reservedUnused: 2, consumed: 1, settled: false });
  lease.settle();
  assert.deepEqual(controller.getStatus(), {
    enabled: true, capacity: 5, available: 4, reservedUnused: 0, consumed: 1,
  });
  assert.deepEqual(lease.getStatus(), { allowance: 3, reservedUnused: 0, consumed: 1, settled: true });
  assertLedger(controller);
});

test("settlement is idempotent and never refunds consumed units", () => {
  const controller = makeController(2);
  const lease = controller.reserve(2);
  lease.consume();
  lease.settle();
  const afterFirstSettle = controller.getStatus();
  lease.settle();
  assert.deepEqual(controller.getStatus(), afterFirstSettle);
  assert.equal(controller.getStatus().consumed, 1);
  assert.equal(controller.getStatus().available, 1);
  assertLedger(controller);
});

test("overconsumption and consumption after settlement fail closed without mutation", () => {
  const controller = makeController(2);
  const lease = controller.reserve(1);
  lease.consume();
  const exhaustedBefore = controller.getStatus();
  assert.throws(() => lease.consume(), rejection("lease_exhausted"));
  assert.deepEqual(controller.getStatus(), exhaustedBefore);
  lease.settle();
  const settledBefore = controller.getStatus();
  assert.throws(() => lease.consume(), rejection("lease_settled"));
  assert.deepEqual(controller.getStatus(), settledBefore);
  assertLedger(controller);
});

test("settling before dispatch returns the full allowance and prevents later consumption", () => {
  const controller = makeController(3);
  const lease = controller.reserve(2);
  lease.settle();
  assert.deepEqual(controller.getStatus(), {
    enabled: true, capacity: 3, available: 3, reservedUnused: 0, consumed: 0,
  });
  assert.throws(() => lease.consume(), rejection("lease_settled"));
  assertLedger(controller);
});

test("disabling blocks new reservations but existing leases remain usable", () => {
  const controller = makeController(3);
  const lease = controller.reserve(2);
  controller.setEnabled(false);
  assert.throws(() => controller.reserve(1), rejection("controller_disabled"));
  lease.consume();
  lease.settle();
  assert.deepEqual(controller.getStatus(), {
    enabled: false, capacity: 3, available: 2, reservedUnused: 0, consumed: 1,
  });
  controller.setEnabled(true);
  assert.equal(controller.reserve(2).getStatus().reservedUnused, 2);
  assertLedger(controller);
});

test("leases and controller instances are isolated", () => {
  const first = makeController(3);
  const second = makeController(3);
  const firstLease = first.reserve(2);
  const secondLease = first.reserve(1);
  const otherControllerLease = second.reserve(3);
  firstLease.consume();
  firstLease.settle();
  assert.deepEqual(first.getStatus(), {
    enabled: true, capacity: 3, available: 1, reservedUnused: 1, consumed: 1,
  });
  assert.equal(secondLease.getStatus().reservedUnused, 1);
  assert.deepEqual(second.getStatus(), {
    enabled: true, capacity: 3, available: 0, reservedUnused: 3, consumed: 0,
  });
  secondLease.settle();
  otherControllerLease.settle();
  assertLedger(first);
  assertLedger(second);
});

test("reservations are atomic for synchronous callers competing for the final unit", () => {
  const controller = makeController(1);
  const results = [1, 2].map(() => {
    try { return { status: "reserved", lease: controller.reserve(1) }; }
    catch (error) { return { status: "rejected", error }; }
  });
  assert.deepEqual(results.map((result) => result.status), ["reserved", "rejected"]);
  assert.equal(results[1].error.reason, "insufficient_allowance");
  results[0].lease.consume();
  results[0].lease.settle();
  assert.deepEqual(controller.getStatus(), {
    enabled: true, capacity: 1, available: 0, reservedUnused: 0, consumed: 1,
  });
  assertLedger(controller);
});

test("snapshots are immutable and refreshed rather than exposing mutable accounting", () => {
  const controller = makeController(2);
  const initial = controller.getStatus();
  assert.equal(Object.isFrozen(initial), true);
  const lease = controller.reserve(1);
  const reserved = lease.getStatus();
  assert.equal(Object.isFrozen(reserved), true);
  assert.notEqual(initial, controller.getStatus());
  assert.equal(initial.available, 2);
  assert.equal(reserved.reservedUnused, 1);
  assert.equal(Reflect.set(initial, "available", 99), false);
  assert.equal(Reflect.set(reserved, "consumed", 99), false);
  assert.equal(controller.getStatus().available, 1);
  assert.equal(lease.getStatus().consumed, 0);
});

test("maximum safe-integer capacity remains exact through reservation and consumption", () => {
  const controller = makeController(Number.MAX_SAFE_INTEGER);
  const lease = controller.reserve(Number.MAX_SAFE_INTEGER);
  lease.consume();
  assert.deepEqual(controller.getStatus(), {
    enabled: true, capacity: Number.MAX_SAFE_INTEGER, available: 0,
    reservedUnused: Number.MAX_SAFE_INTEGER - 1, consumed: 1,
  });
  assertLedger(controller);
  lease.settle();
  assert.equal(controller.getStatus().consumed, 1);
  assert.equal(controller.getStatus().available, Number.MAX_SAFE_INTEGER - 1);
  assertLedger(controller);
});

test("the primitive has no dispatch path, cancellation logic, timers, or evidence integration", () => {
  const source = readFileSync("src/application/solanaProviderRequestBudgetController.ts", "utf8");
  assert.doesNotMatch(source, /providers\/|\bfetch\s*\(|https?:\/\/|setTimeout|Promise\.race|retry|SolanaTokenEvidencePresentation|qualification|scoring/i);
});
