import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createBoardPhaseGates, readBoardSessionStartup } from "./r2-board-session-startup.mjs";

const project = path.resolve("owned-board-project");
const commands = [
  { id: "create", type: "session.create", cwd: project, at: 10 },
  { id: "subscribe", type: "session.subscribe", sessionId: "original", at: 12 },
];
const responses = [
  { id: "create", ok: true, sessionId: "original", cwd: project, at: 11 },
  { id: "subscribe", ok: true, subscribed: true, sessionId: "original", at: 13 },
];
function fixture(overrides = {}) {
  const reads = [];
  return {
    reads,
    input: {
      commands,
      responses,
      project,
      now: () => 14,
      readRegistry: async () => { reads.push(14); return { sessions: [{ sessionId: "original", cwd: project }] }; },
      ...overrides,
    },
  };
}

test("fresh Board session reads only after the real create and subscribe ACKs", async () => {
  const f = fixture();
  for (const partial of [[], responses.slice(0, 1)]) {
    assert.equal(await readBoardSessionStartup({ ...f.input, responses: partial }), undefined);
    assert.deepEqual(f.reads, []);
  }
  const result = await readBoardSessionStartup(f.input);
  assert.equal(result.ready.sessionId, "original");
  assert.equal(result.readStartedAt, 14);
  assert.ok(result.readStartedAt >= result.ready.subscriptionResponse.at);
  assert.deepEqual(f.reads, [14]);
});

test("failed, foreign or out-of-order Board startup ACKs cause zero registry reads", async () => {
  for (const bad of [
    [{ ...responses[0], ok: false, errorCode: "CREATE_FAILED" }, responses[1]],
    [responses[0], { ...responses[1], ok: false, errorCode: "SUBSCRIBE_FAILED" }],
    [{ ...responses[0], cwd: path.resolve("foreign") }, responses[1]],
    [responses[0], { ...responses[1], sessionId: "foreign" }],
    [{ ...responses[0], at: 13 }, responses[1]],
    [responses[0], { ...responses[1], at: 11 }],
    [responses[0], { ...responses[1], at: undefined }],
  ]) {
    const f = fixture({ responses: bad });
    await assert.rejects(readBoardSessionStartup(f.input));
    assert.deepEqual(f.reads, []);
  }
  const pending = fixture({ responses: [responses[0], { ...responses[1], id: "unrelated" }] });
  assert.equal(await readBoardSessionStartup(pending.input), undefined);
  assert.deepEqual(pending.reads, []);
});

test("existing automatic openSubscribe ACK remains valid without issuing a session command", async () => {
  const f = fixture({
    commands: [{ id: "open", type: "session.openSubscribe", cwd: project, sessionId: "original", at: 10 }],
    responses: [{ id: "open", ok: true, subscribed: true, sessionId: "original", cwd: project, at: 11 }],
  });
  assert.equal((await readBoardSessionStartup(f.input)).ready.sessionId, "original");
  assert.deepEqual(f.reads, [14]);
});

test("Board driver source uses passive startup before its first registry read", async () => {
  const source = await fs.readFile(new URL("../r2-board-publication-cold.acceptance.mjs", import.meta.url), "utf8");
  const observe = source.slice(source.indexOf("const observe = async () =>"), source.indexOf("const settle = async"));
  assert.ok(observe.indexOf("readBoardSessionStartup({") < observe.indexOf('loaded.e2e("session.list")'));
  assert.match(observe, /if \(!startup\) return;/);
  assert.match(observe, /sessionId = startup\.ready\.sessionId;/);
  assert.doesNotMatch(observe, /sessionId \?\?= sessions/);
  assert.match(source, /\["session\.open", "session\.openSubscribe", "session\.create", "session\.subscribe", "prompt"\]/);
  assert.match(source, /const deadline = Date\.now\(\) \+ 150000;/);
  const provider = source.slice(source.indexOf("nextTool: async"), source.indexOf("router = await createLocalChatApiRouter"));
  assert.doesNotMatch(provider, /await observe\(|loaded\.e2e\(/);
  assert.match(provider, /await phaseGates\.waitAfterResult\(\{ turn, step, previousResult \}\)/);
  assert.match(observe, /phaseGates\.releaseResult\(message\.toolCallId\)/);
});

test("Board provider waits once for each externally verified exact result, with no observation callback", async () => {
  const gates = createBoardPhaseGates(), order = [];
  await gates.waitAfterResult({ turn: 0, step: 0 });
  const wait = gates.waitAfterResult({ turn: 0, step: 2, previousResult: { tool_call_id: "export-g0" } })
    .then(() => order.push("next"));
  await Promise.resolve();
  assert.deepEqual(order, []);
  gates.releaseResult("export-g0");
  await wait;
  assert.deepEqual(order, ["next"]);
  assert.throws(() => gates.releaseResult("export-g0"));
  await assert.rejects(gates.waitAfterResult({ turn: 0, step: 2, previousResult: { toolCallId: "export-g0" } }));
  await assert.rejects(gates.waitAfterResult({ turn: 0, step: 4, previousResult: { toolCallId: "foreign" } }));
  assert.throws(() => gates.releaseResult("foreign"));
});

test("cold Board provider cannot continue before the externally observed second real user turn", async () => {
  const gates = createBoardPhaseGates();
  let advanced = false;
  const wait = gates.waitAfterResult({ turn: 1, step: 0 }).then(() => { advanced = true; });
  await Promise.resolve();
  assert.equal(advanced, false);
  assert.throws(() => gates.releaseColdUserTurn(1));
  assert.equal(advanced, false);
  gates.releaseColdUserTurn(2);
  await wait;
  assert.equal(advanced, true);
  assert.throws(() => gates.releaseColdUserTurn(2));
});

test("failed external verification can cancel a held Board provider without releasing a tool", async () => {
  const gates = createBoardPhaseGates(), error = new Error("Actual external assertion failed");
  const wait = gates.waitAfterResult({ turn: 0, step: 5, previousResult: { toolCallId: "uncertain-original-board" } });
  gates.cancel(error);
  gates.cancel(error);
  await assert.rejects(wait, (value) => value === error);
  assert.ok(gates.snapshot().phases.every((value) => !value.released));
  assert.throws(() => gates.releaseResult("uncertain-original-board"));
});
