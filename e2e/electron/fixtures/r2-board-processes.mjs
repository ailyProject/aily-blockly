import assert from "node:assert/strict";
import path from "node:path";
import {
  environmentCreationKey,
  selectEnvironmentProcessTree,
} from "./r2-environment-cleanup.mjs";

const same = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
export function boardMainIdentity(executor, executable) {
  assert.equal(
    executor.storagePid,
    executor.hostPid,
    "A storage process creation identity cannot identify a different Main",
  );
  return boardStorageIdentity(executor, executable);
}
export function boardStorageIdentity(executor, executable) {
  assert.ok(
    Number.isSafeInteger(executor.storagePid) && executor.storagePid > 0,
  );
  assert.match(executor.processIdentity, /^win32:\d+$/);
  const ticks = BigInt(executor.processIdentity.slice(6)) - 621355968000000000n;
  assert.ok(ticks > 0n);
  return {
    ProcessId: executor.storagePid,
    ExecutablePath: executable,
    CreationDate:
      new Date(Number(ticks / 10000n)).toISOString().slice(0, 19) +
      "." +
      String(ticks % 10000000n).padStart(7, "0") +
      "Z",
  };
}
export function boardOwnedProcessTree(all, expected) {
  return selectEnvironmentProcessTree(all, expected);
}
export function assertBoardResumeProcesses(
  all,
  {
    originalMain,
    originalStorage,
    installedRoot,
    nodeExecutables,
    collectorPids = [],
  },
) {
  assert.ok(
    !all.some((value) => value.ProcessId === originalMain.ProcessId),
    "The original Host PID must be absent; a reused PID is not proof of termination",
  );
  const originalAlive = all.some(
    (value) =>
      value.ProcessId === originalMain.ProcessId &&
      environmentCreationKey(value.CreationDate) ===
        environmentCreationKey(originalMain.CreationDate),
  );
  assert.equal(
    originalAlive,
    false,
    "The exact original Main must have exited before resume",
  );
  if (originalStorage)
    assert.ok(
      !all.some(
        (value) =>
          value.ProcessId === originalStorage.ProcessId &&
          environmentCreationKey(value.CreationDate) ===
            environmentCreationKey(originalStorage.CreationDate),
      ),
      "The exact original storage executor must have exited",
    );
  const runtime = path.join(installedRoot, "runtime").toLowerCase();
  const ownedNodes = all.filter((value) => {
    if (
      collectorPids.includes(value.ProcessId) ||
      String(value.Name).toLowerCase() !== "node.exe"
    )
      return false;
    if (nodeExecutables.some((file) => same(value.ExecutablePath, file)))
      return true;
    const args =
      String(value.CommandLine ?? "").match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return args.some((arg) => {
      const file = arg.replace(/^["']|["']$/g, "");
      if (!path.isAbsolute(file) || !/\.[mc]?js$/i.test(file)) return false;
      const relative = path.relative(runtime, file.toLowerCase());
      return (
        relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      );
    });
  });
  assert.deepEqual(
    ownedNodes,
    [],
    "The sealed Chat runtime must be fully stopped before resume",
  );
  return {
    originalMainExited: true,
    originalMain,
    originalStorage,
    originalStorageExited: !!originalStorage,
    ownedRuntimeNodes: [],
    collectorPids,
    foreignProcessesNotTerminated: true,
    processObservationOnly: true,
  };
}
