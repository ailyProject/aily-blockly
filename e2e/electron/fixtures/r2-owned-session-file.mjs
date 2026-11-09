import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const same = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
const identity = (value) =>
  [value.dev, value.ino, value.birthtimeNs].map(String);

/** Read exactly one original session under this test's owned home. This never
 * opens a runtime session, selects history, repairs metadata or chooses latest. */
export async function readOwnedSessionFile({
  suite,
  home,
  project,
  sessionId,
}) {
  for (const value of [suite, home, project])
    assert.ok(typeof value === "string" && path.isAbsolute(value));
  assert.ok(
    inside(suite, home) && inside(suite, project),
    "Session paths must remain within the owned suite",
  );
  assert.match(sessionId, /^[a-zA-Z0-9-]{8,128}$/);
  const directories = new Map();
  const physicalDirectory = async (directory) => {
    const value = await fs.lstat(directory, { bigint: true });
    assert.ok(
      value.isDirectory() && !value.isSymbolicLink(),
      "Session ancestry must be physical",
    );
    assert.ok(
      same(await fs.realpath(directory), directory),
      "Session ancestry cannot be redirected",
    );
    directories.set(directory, identity(value));
  };
  for (const directory of [
    suite,
    home,
    project,
    path.join(home, ".aily-chat"),
    path.join(home, ".aily-chat/sessions"),
  ])
    await physicalDirectory(directory);
  const root = path.join(home, ".aily-chat/sessions"),
    candidates = [];
  for (const bucket of await fs.readdir(root, { withFileTypes: true })) {
    if (bucket.isSymbolicLink())
      throw Error("A session bucket cannot be a link");
    if (!bucket.isDirectory()) continue;
    const directory = path.join(root, bucket.name);
    await physicalDirectory(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith("_" + sessionId + ".jsonl")) continue;
      const sessionFile = path.join(directory, entry.name);
      assert.ok(inside(root, sessionFile));
      const before = await fs.lstat(sessionFile, { bigint: true });
      assert.ok(
        before.isFile() && !before.isSymbolicLink() && before.nlink === 1n,
        "Session must be one physical regular file",
      );
      const handle = await fs.open(
        sessionFile,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = await handle.stat({ bigint: true }),
          bytes = await handle.readFile();
        const after = await fs.lstat(sessionFile, { bigint: true }),
          final = await handle.stat({ bigint: true });
        for (const value of [opened, after, final]) {
          assert.ok(
            value.isFile() && !value.isSymbolicLink() && value.nlink === 1n,
          );
          assert.deepEqual(
            identity(value),
            identity(before),
            "Session identity changed during read",
          );
        }
        assert.equal(
          final.size,
          BigInt(bytes.length),
          "Read a complete current file, not a partial append",
        );
        const firstLine = bytes.toString("utf8").split(/\r?\n/, 1)[0],
          header = JSON.parse(firstLine);
        assert.equal(header.type, "session");
        assert.equal(header.id, sessionId);
        assert.ok(
          typeof header.cwd === "string" && same(header.cwd, project),
          "Session header must identify the original project",
        );
        candidates.push({ sessionFile, bytes });
      } finally {
        await handle.close();
      }
    }
  }
  assert.equal(
    candidates.length,
    1,
    "Require one exact owned session; never select latest or another session",
  );
  for (const [directory, original] of directories) {
    const value = await fs.lstat(directory, { bigint: true });
    assert.ok(
      value.isDirectory() &&
        !value.isSymbolicLink() &&
        same(await fs.realpath(directory), directory),
    );
    assert.deepEqual(
      identity(value),
      original,
      "Session ancestry changed during read",
    );
  }
  return candidates[0];
}
