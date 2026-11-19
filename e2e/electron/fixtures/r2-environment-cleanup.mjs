import assert from "node:assert/strict";
import path from "node:path";

export function environmentCreationKey(value) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z$/.exec(
    value ?? "",
  );
  assert.ok(
    match,
    "Captured process creation must be an explicit UTC ISO value",
  );
  return match[1] + "." + (match[2] ?? "").padEnd(7, "0") + "Z";
}
export function assertCapturedEnvironmentProcess(current, expected) {
  assert.ok(current && expected);
  assert.ok(Number.isSafeInteger(expected.ProcessId) && expected.ProcessId > 0);
  assert.equal(current.ProcessId, expected.ProcessId);
  assert.equal(
    environmentCreationKey(current.CreationDate),
    environmentCreationKey(expected.CreationDate),
  );
  assert.ok(path.isAbsolute(expected.ExecutablePath ?? ""));
  assert.ok(path.isAbsolute(current.ExecutablePath ?? ""));
  assert.equal(
    path.resolve(current.ExecutablePath).toLowerCase(),
    path.resolve(expected.ExecutablePath).toLowerCase(),
  );
}
export function remainingEnvironmentProcesses(captured, current) {
  return captured.filter((old) =>
    current.some(
      (value) =>
        value.ProcessId === old.ProcessId &&
        environmentCreationKey(value.CreationDate) ===
          environmentCreationKey(old.CreationDate),
    ),
  );
}
export function selectEnvironmentProcessTree(all, expected) {
  const root = all.find((value) => value.ProcessId === expected.ProcessId);
  if (!root) return [];
  assertCapturedEnvironmentProcess(root, expected);
  const owned = new Map([[root.ProcessId, root]]);
  let added;
  do {
    added = false;
    for (const value of all) {
      const parent = owned.get(value.ParentProcessId);
      if (!parent || owned.has(value.ProcessId)) continue;
      // PPID can survive PID reuse. An older child cannot belong to this actor.
      if (
        environmentCreationKey(value.CreationDate) <
        environmentCreationKey(parent.CreationDate)
      )
        continue;
      owned.set(value.ProcessId, value);
      added = true;
    }
  } while (added);
  return [...owned.values()];
}
export function environmentProcessStopScript(expected) {
  assert.ok(expected && Number.isSafeInteger(expected.ProcessId) && expected.ProcessId > 0);
  const creation = environmentCreationKey(expected.CreationDate);
  const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  if (expected.ExecutablePath == null || expected.ExecutablePath === "") {
    return (
      `$owned = Get-CimInstance Win32_Process -Filter 'ProcessId = ${expected.ProcessId}' -ErrorAction Stop; ` +
      `if (!$owned -or $owned.CreationDate.ToUniversalTime().ToString('o') -cne ${literal(creation)}) { exit 0 }; ` +
      `throw 'Original captured process is still live without a captured executable identity; termination refused'`
    );
  }
  assertCapturedEnvironmentProcess(expected, expected);
  return (
    `$owned = Get-CimInstance Win32_Process -Filter 'ProcessId = ${expected.ProcessId}' -ErrorAction Stop; ` +
    `if (!$owned) { exit 0 }; if ($owned.CreationDate.ToUniversalTime().ToString('o') -cne ${literal(environmentCreationKey(expected.CreationDate))} ` +
    `-or [IO.Path]::GetFullPath([string]$owned.ExecutablePath) -ine [IO.Path]::GetFullPath(${literal(expected.ExecutablePath)})) { throw 'Captured process identity changed' }; ` +
    `Stop-Process -Id ${expected.ProcessId} -Force -ErrorAction Stop`
  );
}
