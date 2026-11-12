import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  assertCapturedEnvironmentProcess,
  environmentCreationKey,
  remainingEnvironmentProcesses,
  environmentProcessStopScript,
} from "./r2-environment-cleanup.mjs";

const main = {
  ProcessId: 1234,
  ParentProcessId: 20,
  ExecutablePath: path.resolve("owned-fixture", "aily blockly.exe"),
  CreationDate: "2026-11-08T07:13:42.05479Z",
};
test("UTC creation precision is normalized without losing the original process identity", () => {
  const current = { ...main, CreationDate: "2026-11-08T07:13:42.0547900Z" };
  assertCapturedEnvironmentProcess(current, main);
  assert.equal(
    environmentCreationKey(current.CreationDate),
    environmentCreationKey(main.CreationDate),
  );
  const script = environmentProcessStopScript(main);
  assert.match(script, /Stop-Process -Id 1234 -Force/);
  assert.ok(script.includes(".0547900Z"));
  assert.ok(!/taskkill|\/T\b|app\.close/.test(script));
});
for (const [name, changed] of [
  ["PID", { ProcessId: 5678 }],
  ["creation", { CreationDate: "2026-11-08T07:13:42.0547901Z" }],
  [
    "executable",
    { ExecutablePath: path.resolve("foreign", "aily blockly.exe") },
  ],
  ["non-ISO", { CreationDate: "/Date(1794122022054)/" }],
])
  test("cleanup refuses changed " + name, () =>
    assert.throws(() =>
      assertCapturedEnvironmentProcess({ ...main, ...changed }, main),
    ),
  );
test("only exact captured creation descendants count as remaining; a reused PID is foreign", () => {
  const child = {
    ...main,
    ProcessId: 1235,
    ParentProcessId: 1234,
    ExecutablePath: path.resolve("owned-fixture", "node.exe"),
  };
  assert.deepEqual(
    remainingEnvironmentProcesses(
      [main, child],
      [{ ...main, CreationDate: "2026-11-08T08:00:00.0000000Z" }, child],
    ),
    [child],
  );
  assert.deepEqual(remainingEnvironmentProcesses([main, child], []), []);
  assert.doesNotThrow(() => environmentProcessStopScript(child));
});
