const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_DIRECTORY_CONCURRENCY = 8;
const DEFAULT_FILE_CONCURRENCY = 32;

async function runWithConcurrency(items, concurrency, callback) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await callback(item);
    }
  });
  await Promise.all(workers);
}

async function calculateDirectoryStats(rootPath, options = {}) {
  const directoryConcurrency = options.directoryConcurrency || DEFAULT_DIRECTORY_CONCURRENCY;
  const fileConcurrency = options.fileConcurrency || DEFAULT_FILE_CONCURRENCY;
  const skipRootFiles = !!options.skipRootFiles;
  const pendingDirectories = [{ path: rootPath, root: true }];
  let size = 0;
  let count = 0;

  while (pendingDirectories.length > 0) {
    const directories = pendingDirectories.splice(0, directoryConcurrency);
    const batches = await Promise.all(directories.map(async (directory) => {
      try {
        const entries = await fs.readdir(directory.path, { withFileTypes: true });
        return { directory, entries };
      } catch (_) {
        return { directory, entries: [] };
      }
    }));
    const files = [];

    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        const entryPath = path.join(directory.path, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push({ path: entryPath, root: false });
        } else if (!directory.root || !skipRootFiles) {
          files.push(entryPath);
        }
      }
    }

    await runWithConcurrency(files, fileConcurrency, async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        size += stat.size;
        count++;
      } catch (_) {
        // Files can disappear while caches are being updated; skip them.
      }
    });
  }

  return { size, count };
}

module.exports = {
  calculateDirectoryStats,
};
