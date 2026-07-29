const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(
  workspaceRoot,
  'build',
  'simulator-runtime',
);
const requireRelease = process.argv.includes('--require-release');
const platform = `${process.platform}-${process.arch}`;

if (process.platform !== 'win32') {
  replaceOutput((stagingRoot) => {
    fs.writeFileSync(
      path.join(stagingRoot, 'runtime-unavailable.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        platform,
        reason: 'Aily patched QEMU is not packaged for this platform yet.',
      }, null, 2)}\n`,
      'utf8',
    );
  });
  console.log(`Simulator runtime is unavailable for ${platform}; staged marker only.`);
  process.exit(0);
}

const sourceRoot = path.resolve(
  process.env.AILY_SIMULATOR_RUNTIME_BUNDLE
    || path.join(
      workspaceRoot,
      '..',
      'aily-simulator',
      '.runtime',
      'distribution',
      'aily-simulator-runtime-win32-x64',
    ),
);
const manifest = readManifest(sourceRoot);
verifyManifest(sourceRoot, manifest, true);
if (requireRelease && manifest.redistributionReady !== true) {
  throw new Error(
    `Simulator runtime ${manifest.id} is a development bundle. `
    + 'Build the release bundle with '
    + '`npm run runtime:package:windows:release` in aily-simulator.',
  );
}

replaceOutput((stagingRoot) => {
  fs.cpSync(sourceRoot, stagingRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  verifyManifest(stagingRoot, readManifest(stagingRoot), true);
});

console.log(JSON.stringify({
  status: 'staged',
  id: manifest.id,
  mode: manifest.mode,
  redistributionReady: manifest.redistributionReady,
  sourceRoot,
  outputRoot,
}, null, 2));

function readManifest(root) {
  const manifestPath = path.join(root, 'aily-simulator-runtime.json');
  let value;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `无法读取 Simulator Runtime Manifest：${manifestPath}：${error.message}`,
    );
  }
  if (
    value?.schemaVersion !== 1
    || typeof value?.id !== 'string'
    || typeof value?.platform !== 'string'
    || typeof value?.files !== 'object'
    || typeof value?.integrity?.requiredFileSha256 !== 'object'
  ) {
    throw new Error(`Simulator Runtime Manifest 格式无效：${manifestPath}`);
  }
  return value;
}

function verifyManifest(root, manifest, full = false) {
  if (manifest.platform !== platform) {
    throw new Error(
      `Simulator runtime ${manifest.id} targets ${manifest.platform}, `
      + `but packaging host is ${platform}.`,
    );
  }
  const expectedFiles = full
    ? Object.entries(manifest.files).map(([relativePath, entry]) => [
      relativePath,
      entry.sha256,
    ])
    : Object.entries(manifest.integrity.requiredFileSha256);
  for (const [relativePath, expectedHash] of expectedFiles) {
    const filePath = resolveInside(root, relativePath);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Runtime required path is not a file: ${relativePath}`);
    }
    const catalogEntry = manifest.files[relativePath];
    if (
      !catalogEntry
      || catalogEntry.sha256 !== expectedHash
      || catalogEntry.size !== stat.size
    ) {
      throw new Error(`Runtime catalog mismatch: ${relativePath}`);
    }
    const actualHash = sha256File(filePath);
    if (actualHash !== expectedHash) {
      throw new Error(`Runtime file SHA-256 mismatch: ${relativePath}`);
    }
  }
}

function replaceOutput(populate) {
  const buildRoot = path.join(workspaceRoot, 'build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const stagingRoot = path.join(
    buildRoot,
    `.simulator-runtime-${process.pid}-${Date.now()}`,
  );
  if (path.dirname(outputRoot) !== buildRoot) {
    throw new Error(`Refusing to manage unexpected path: ${outputRoot}`);
  }
  fs.mkdirSync(stagingRoot, { recursive: true });
  try {
    populate(stagingRoot);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.renameSync(stagingRoot, outputRoot);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function resolveInside(root, relativePath) {
  if (
    typeof relativePath !== 'string'
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`Invalid runtime relative path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime path escapes bundle root: ${relativePath}`);
  }
  return resolved;
}

function sha256File(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}
