const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const repo = path.resolve(__dirname, "../..");
const modulePromise = import(
  pathToFileURL(
    path.join(repo, "e2e/electron/fixtures/r2-environment-cleanup.mjs"),
  )
);
test("actual Nov5 Lenovo tree is excluded from a Nov8 parent with a reused PID", async () => {
  const { selectEnvironmentProcessTree } = await modulePromise;
  const actual = JSON.parse(
    await fs.readFile(
      path.join(
        repo,
        "tests/test-results/r2-board-process-birth-observed.json",
      ),
    ),
  );
  const foreign = actual.find(
    (p) => p.Name === "DesktopAssistant.exe" && p.ParentProcessId === 11236,
  );
  assert.ok(foreign);
  assert.match(foreign.CreationDate, /^2026-11-05/);
  const root = {
    ProcessId: 37680,
    ParentProcessId: 1,
    ExecutablePath: "D:/owned/aily blockly.exe",
    CreationDate: "2026-11-08T08:32:26.0309159Z",
  };
  const child = {
    ProcessId: 11236,
    ParentProcessId: 37680,
    ExecutablePath: "D:/owned/node.exe",
    CreationDate: "2026-11-08T08:32:27.0000000Z",
  };
  assert.deepEqual(
    selectEnvironmentProcessTree([root, child, ...actual], root).map(
      (x) => x.ProcessId,
    ),
    [37680, 11236],
  );
});
test("root PID reuse or changed exe rejects and root absence never guesses a new owner", async () => {
  const { selectEnvironmentProcessTree } = await modulePromise;
  const root = {
    ProcessId: 7,
    ExecutablePath: "D:/owned/host.exe",
    CreationDate: "2026-11-08T08:00:00.0000000Z",
  };
  assert.throws(() =>
    selectEnvironmentProcessTree(
      [{ ...root, CreationDate: "2026-11-08T09:00:00.0000000Z" }],
      root,
    ),
  );
  assert.throws(() =>
    selectEnvironmentProcessTree(
      [{ ...root, ExecutablePath: "D:/foreign.exe" }],
      root,
    ),
  );
  assert.deepEqual(
    selectEnvironmentProcessTree([{ ProcessId: 8, ParentProcessId: 7 }], root),
    [],
  );
});
test("runtime audit ignores collector and unrelated shells but rejects the exact sealed node or runtime script", async () => {
  const { assertBoardResumeProcesses } = await import(
    pathToFileURL(
      path.join(repo, "e2e/electron/fixtures/r2-board-processes.mjs"),
    )
  );
  const old = {
    ProcessId: 7,
    ExecutablePath: "D:/owned/host.exe",
    CreationDate: "2026-11-08T08:00:00.0000000Z",
  };
  const opts = {
    originalMain: old,
    installedRoot: "D:/sealed/chat",
    nodeExecutables: ["D:/sealed/node.exe"],
    collectorPids: [11],
  };
  const collector = {
    ProcessId: 11,
    Name: "node.exe",
    ExecutablePath: "D:/sealed/node.exe",
  };
  const shell = {
    ProcessId: 12,
    Name: "pwsh.exe",
    CommandLine: "search D:/sealed/chat/runtime/server.js",
  };
  assert.equal(
    assertBoardResumeProcesses([collector, shell], opts).originalMainExited,
    true,
  );
  assert.throws(() =>
    assertBoardResumeProcesses([{ ...collector, ProcessId: 13 }], opts),
  );
  assert.throws(() =>
    assertBoardResumeProcesses(
      [
        {
          ProcessId: 14,
          Name: "node.exe",
          CommandLine: 'node "D:/sealed/chat/runtime/server.js"',
        },
      ],
      opts,
    ),
  );
  assert.throws(() => assertBoardResumeProcesses([old], opts));
});
test("all maintained board/env collectors use the shared birth-ordered selector", async () => {
  for (const [file, pattern] of [
    [
      "r2-board-publication-cold.acceptance.mjs",
      /boardOwnedProcessTree\(await processes\(\), ownedMainIdentity\)/,
    ],
    [
      "r2-environment-installed.acceptance.mjs",
      /selectEnvironmentProcessTree\(await processes\(\), evidence.mainIdentity\)/,
    ],
    [
      "r2-environment-save-tail.acceptance.mjs",
      /selectEnvironmentProcessTree\(await processes\(\), identity\)/,
    ],
  ]) {
    const s = await fs.readFile(path.join(repo, "e2e/electron", file), "utf8");
    assert.match(s, pattern);
    assert.doesNotMatch(s, /ids\.has\([^)]*ParentProcessId/);
  }
});
test("actual Board05 storage identity never impersonates the distinct Main birth", {
  skip: !process.env.AILY_R2_BOARD05_RESULT,
}, async () => {
  const {
    boardMainIdentity,
    boardStorageIdentity,
    assertBoardResumeProcesses,
  } = await import(
    pathToFileURL(
      path.join(repo, "e2e/electron/fixtures/r2-board-processes.mjs"),
    )
  );
  const raw = JSON.parse(
    await fs.readFile(process.env.AILY_R2_BOARD05_RESULT),
  );
  const executor = raw.finalInitialFault.terminals.at(-1).originalExecutor;
  assert.notEqual(executor.hostPid, executor.storagePid);
  assert.throws(() => boardMainIdentity(executor, "D:/owned/host.exe"));
  const originalStorage = boardStorageIdentity(executor, "D:/owned/node.exe");
  assert.equal(originalStorage.ProcessId, 23548);
  assert.equal(originalStorage.CreationDate, "2026-11-08T08:32:28.7900655Z");
  const originalMain = {
    ProcessId: 37680,
    CreationDate: "2026-11-08T08:32:26.0309159Z",
    ExecutablePath: "D:/owned/host.exe",
  };
  const opts = {
    originalMain,
    originalStorage,
    installedRoot: "D:/sealed/chat",
    nodeExecutables: [],
  };
  assert.equal(
    assertBoardResumeProcesses([], opts).originalStorageExited,
    true,
  );
  assert.throws(() => assertBoardResumeProcesses([originalStorage], opts));
  assert.throws(() =>
    assertBoardResumeProcesses(
      [{ ...originalMain, CreationDate: "2026-11-08T09:00:00.0000000Z" }],
      opts,
    ),
  );
});
