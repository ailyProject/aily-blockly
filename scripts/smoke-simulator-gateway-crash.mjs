import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const runtimeRoot = process.env.AILY_SIMULATOR_RUNTIME_BUNDLE
  || path.resolve(
    repositoryRoot,
    '..',
    'aily-simulator',
    '.runtime',
    'distribution',
    'aily-simulator-runtime-win32-x64',
  );
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'aily-simulator-crash-'),
);
const projectRoot = path.join(temporaryRoot, 'project');
const buildRoot = path.join(projectRoot, '.build');
const fakeGateway = path.join(temporaryRoot, 'fake-gateway.mjs');
const gatewayBridge = require('../electron/simulator-gateway.js');

process.env.AILY_SIMULATOR_ROOT = runtimeRoot;
process.env.AILY_SIMULATOR_GATEWAY_ENTRY = fakeGateway;

try {
  await mkdir(buildRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'gateway-crash-smoke' }),
  );
  await writeFile(
    path.join(buildRoot, 'aily-artifact-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'aily-build-artifact',
      artifactId: 'crash-smoke',
    }),
  );
  await writeFile(
    fakeGateway,
    `console.log(JSON.stringify({
  service: 'aily-simulator-gateway',
  baseUrl: 'http://127.0.0.1:43210'
}));
setTimeout(() => {
  console.error('intentional gateway crash marker');
  process.exit(23);
}, 100);
`,
    'utf8',
  );

  const bootstrap = await gatewayBridge.start({
    app: {
      isPackaged: false,
      getPath(name) {
        assert.equal(name, 'userData');
        return path.join(temporaryRoot, 'user-data');
      },
    },
    projectPath: projectRoot,
    rendererOrigin: 'http://localhost:4200',
  });
  assert.equal(bootstrap.runtimeMode, 'release');
  await waitFor(
    () => gatewayBridge.status().lastFailure?.code === 23,
    5_000,
  );

  const state = gatewayBridge.status();
  assert.equal(state.state, 'stopped');
  assert.equal(state.lastFailure.phase, 'runtime');
  assert.equal(state.lastFailure.code, 23);
  assert.match(
    state.lastFailure.stderrTail,
    /intentional gateway crash marker/,
  );
  console.log(JSON.stringify({
    status: 'passed',
    state: state.state,
    failure: {
      phase: state.lastFailure.phase,
      code: state.lastFailure.code,
      capturedStderr: true,
    },
  }, null, 2));
} finally {
  await gatewayBridge.stop().catch(() => undefined);
  delete process.env.AILY_SIMULATOR_ROOT;
  delete process.env.AILY_SIMULATOR_GATEWAY_ENTRY;
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for Gateway crash diagnostics.');
}
