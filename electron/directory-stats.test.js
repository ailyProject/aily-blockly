const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { calculateDirectoryStats } = require("./directory-stats");

test("directory stats scans nested files asynchronously and can ignore root files", async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "aily-directory-stats-"));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));

  fs.mkdirSync(path.join(rootPath, "cache", "nested"), { recursive: true });
  fs.mkdirSync(path.join(rootPath, "archive"), { recursive: true });
  fs.writeFileSync(path.join(rootPath, "root.txt"), "root");
  fs.writeFileSync(path.join(rootPath, "cache", "one.bin"), "1234");
  fs.writeFileSync(path.join(rootPath, "cache", "nested", "two.bin"), "123456");
  fs.writeFileSync(path.join(rootPath, "archive", "three.bin"), "12");

  const allFiles = await calculateDirectoryStats(rootPath, {
    directoryConcurrency: 1,
    fileConcurrency: 1,
  });
  assert.deepEqual(allFiles, { size: 16, count: 4 });

  const cacheFiles = await calculateDirectoryStats(rootPath, { skipRootFiles: true });
  assert.deepEqual(cacheFiles, { size: 12, count: 3 });
});

test("directory stats treats a missing directory as empty", async () => {
  const missingPath = path.join(
    os.tmpdir(),
    `aily-missing-directory-${process.pid}-${Date.now()}`,
  );
  const stats = await calculateDirectoryStats(missingPath);
  assert.deepEqual(stats, { size: 0, count: 0 });
});
