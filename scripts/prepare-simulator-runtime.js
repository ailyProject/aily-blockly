const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(
  workspaceRoot,
  'build',
  'simulator-runtime',
);
const platform = `${process.platform}-${process.arch}`;

// Simulator runtime is no longer vendored from a sibling aily-simulator
// checkout. It will ship/install via the subapp package channel
// (@aily-project/aily-simulator), same as other child apps.
// Keep a staged marker so electron-builder extraResources still has a
// stable source directory.
replaceOutput((stagingRoot) => {
  fs.writeFileSync(
    path.join(stagingRoot, 'runtime-unavailable.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      platform,
      reason:
        'Simulator runtime is provided by the aily-simulator subapp package, '
        + 'not packaged from an external repository checkout.',
    }, null, 2)}\n`,
    'utf8',
  );
});

console.log(JSON.stringify({
  status: 'marker',
  platform,
  outputRoot,
  reason: 'subapp-package',
}, null, 2));

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
