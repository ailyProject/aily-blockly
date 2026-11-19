import assert from "node:assert/strict";
import { environmentSessionStartup } from "./r2-environment-session.mjs";

/** Only passive UI create/subscribe ACKs authorize the first registry read.
 * This has no wait/retry budget and never creates or selects a session. */
export async function readBoardSessionStartup({
  commands,
  responses,
  project,
  readRegistry,
  now = Date.now,
}) {
  const ready = environmentSessionStartup(commands, responses, project);
  if (!ready) return undefined;
  const times =
    ready.opened.id === ready.subscribed.id
      ? [ready.opened.at, ready.openResponse.at]
      : [
          ready.opened.at,
          ready.openResponse.at,
          ready.subscribed.at,
          ready.subscriptionResponse.at,
        ];
  assert.ok(
    times.every(Number.isFinite),
    "Actual session ACK timestamps are required",
  );
  assert.ok(
    times.every((at, index) => !index || at >= times[index - 1]),
    "Actual UI create/subscribe ACKs must precede registry observation in order",
  );
  const readStartedAt = now();
  assert.ok(Number.isFinite(readStartedAt) && readStartedAt >= times.at(-1));
  const registry = await readRegistry();
  return { ready, registry, readStartedAt, readCompletedAt: now() };
}

// Provider-side ordering is memory-only. Actual assertions and reads remain in
// the independent observer; waiting here must never reenter the session worker.
export function createBoardPhaseGates({ coldUserTurn = 2 } = {}) {
  assert.ok(coldUserTurn === 2 || coldUserTurn === 3);
  const coldUserGate = "cold-user-" + coldUserTurn;
  const plans = [
    { turn: 0, step: 1, id: "load-board-tools" },
    { turn: 0, step: 2, id: "export-g0" },
    { turn: 0, step: 3, id: "read-before-A" },
    { turn: 0, step: 4, id: "edit-A" },
    { turn: 0, step: 5, id: "uncertain-original-board" },
    { turn: 1, step: 0, id: coldUserGate },
    { turn: 1, step: 1, id: "read-A-after-cold" },
    { turn: 1, step: 2, id: "edit-B-after-cold" },
    { turn: 1, step: 3, id: "apply-A-B-C-after-cold" },
  ];
  const gates = new Map(
    plans.map((plan) => {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.catch(() => {});
      return [
        plan.id,
        { ...plan, promise, resolve, reject, waiting: false, released: false },
      ];
    }),
  );
  let cancelled;
  const release = (id) => {
    const gate = gates.get(id);
    assert.ok(
      gate,
      "Only an externally verified Board phase can release a gate",
    );
    assert.equal(cancelled, undefined);
    assert.equal(
      gate.released,
      false,
      "Each external Board phase is verified once",
    );
    gate.released = true;
    gate.resolve();
  };
  return {
    async waitAfterResult({ turn, step, previousResult }) {
      const plan = plans.find(
        (value) => value.turn === turn && value.step === step,
      );
      if (!plan) return;
      if (plan.id !== coldUserGate)
        assert.equal(
          previousResult?.toolCallId ?? previousResult?.tool_call_id,
          plan.id,
          "The provider must present the exact preceding Board tool result",
        );
      if (cancelled) throw cancelled;
      const gate = gates.get(plan.id);
      assert.equal(gate.waiting, false, "A provider phase cannot wait twice");
      gate.waiting = true;
      await gate.promise;
    },
    expectsResult: (id) => id !== coldUserGate && gates.has(id),
    releaseResult: release,
    releaseColdUserTurn(users) {
      assert.equal(users, coldUserTurn);
      release(coldUserGate);
    },
    cancel(reason) {
      if (cancelled || [...gates.values()].every((gate) => gate.released))
        return;
      cancelled = reason;
      for (const gate of gates.values())
        if (!gate.released) gate.reject(reason);
    },
    snapshot: () => ({
      cancelled: !!cancelled,
      phases: [...gates.values()].map(
        ({ turn, step, id, waiting, released }) => ({
          turn,
          step,
          id,
          waiting,
          released,
        }),
      ),
    }),
  };
}
