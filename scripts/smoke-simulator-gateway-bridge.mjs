import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import {
  cp,
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
const simulatorRoot = path.resolve(repositoryRoot, '..', 'aily-simulator');
const packagedRuntimeRoot = path.join(
  simulatorRoot,
  '.runtime',
  'distribution',
  'aily-simulator-runtime-win32-x64',
);
const runtimeRoot = process.env.AILY_SIMULATOR_RUNTIME_BUNDLE
  || (
    existsSync(path.join(
      packagedRuntimeRoot,
      'aily-simulator-runtime.json',
    ))
      ? packagedRuntimeRoot
      : simulatorRoot
  );
const fixture = path.join(
  simulatorRoot,
  '.build',
  'fixtures',
  'esp32s3-uart',
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'aily-blockly-simulator-bridge-'),
);
const projectRoot = path.join(temporaryRoot, 'project');
const buildRoot = path.join(projectRoot, '.build');
const userData = path.join(temporaryRoot, 'user-data');

process.env.AILY_SIMULATOR_ROOT = runtimeRoot;
const gatewayBridge = require('../electron/simulator-gateway.js');

try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'simulator-bridge-smoke' }),
  );
  await cp(fixture, buildRoot, { recursive: true });

  const bootstrap = await gatewayBridge.start({
    app: {
      isPackaged: false,
      getPath(name) {
        assert.equal(name, 'userData');
        return userData;
      },
    },
    projectPath: projectRoot,
    rendererOrigin: 'http://localhost:4200',
  });
  assert.match(bootstrap.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(bootstrap.accessToken.length, 64);
  assert.equal(bootstrap.artifactDirectory, '.');
  console.log('bridge smoke: gateway ready');

  const headers = {
    Authorization: `Bearer ${bootstrap.accessToken}`,
    'Content-Type': 'application/json',
  };
  const health = await fetch(`${bootstrap.baseUrl}/v1/health`, { headers });
  assert.equal(health.status, 200);
  console.log('bridge smoke: health ready');

  const compiledResponse = await fetch(
    `${bootstrap.baseUrl}/v1/scenes/compile`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        artifact: bootstrap.artifact,
        sceneId: 'electron-bridge-smoke',
        connectionGraph: xiaoBoardOnlyGraph(),
      }),
    },
  );
  assert.equal(compiledResponse.status, 200);
  const compiled = await compiledResponse.json();
  assert.equal(compiled.report.supported, true);
  console.log('bridge smoke: scene compiled');

  const createdResponse = await fetch(`${bootstrap.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId: 'electron-bridge-smoke',
      artifactDirectory: '.',
      artifact: bootstrap.artifact,
      manifest: compiled.manifest,
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.runtime.debugAvailable, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(created.runtime, 'gdbEndpoint'),
    false,
  );
  console.log('bridge smoke: session created');

  const eventsAbort = new AbortController();
  const events = collectEventsUntilReady(
    bootstrap.baseUrl,
    bootstrap.accessToken,
    eventsAbort.signal,
  );
  const started = await fetch(
    `${bootstrap.baseUrl}/v1/sessions/electron-bridge-smoke/start`,
    { method: 'POST', headers, body: '{}' },
  );
  assert.equal(started.status, 200);
  console.log('bridge smoke: session started');
  const received = await events;
  assert.equal(received.some((event) => event.type === 'session.state'), true);
  const uart = received
    .filter((event) => event.type === 'uart.data')
    .map((event) => Buffer.from(
      event.payload.dataBase64,
      'base64',
    ).toString('utf8'))
    .join('');
  assert.match(uart, /AILY_SIM_FIXTURE:ESP32S3_UART:READY/);

  const attached = await postJson(
    `${bootstrap.baseUrl}/v1/sessions/electron-bridge-smoke/debug/connect`,
    headers,
    {},
  );
  assert.equal(attached.state, 'stopped');
  const breakpoint = await postJson(
    `${bootstrap.baseUrl}/v1/sessions/electron-bridge-smoke/debug/breakpoints`,
    headers,
    {
      location: { kind: 'function', functionName: 'loop' },
    },
  );
  assert.equal(breakpoint.breakpoints[0].verified, true);
  await postJson(
    `${bootstrap.baseUrl}/v1/sessions/electron-bridge-smoke/debug/continue`,
    headers,
    {},
  );
  const debugStopped = await waitForDebugStop(
    bootstrap.baseUrl,
    headers,
    20_000,
  );
  assert.match(debugStopped.frame.functionName, /loop/);
  await postJson(
    `${bootstrap.baseUrl}/v1/sessions/electron-bridge-smoke/debug/disconnect`,
    headers,
    {},
  );

  await fetch(
    `${bootstrap.baseUrl}/v1/sessions/electron-bridge-smoke/stop`,
    { method: 'POST', headers, body: '{}' },
  );
  await fetch(
    `${bootstrap.baseUrl}/v1/sessions/electron-bridge-smoke`,
    { method: 'DELETE', headers },
  );

  console.log(JSON.stringify({
    status: 'passed',
    bridgeState: gatewayBridge.status().state,
    runtimeSource: bootstrap.runtimeSource,
    runtimePackId: bootstrap.runtimePackId ?? null,
    runtimeMode: bootstrap.runtimeMode ?? null,
    debugFrame: debugStopped.frame,
    rawGdbEndpointExposed: false,
    eventTypes: [...new Set(received.map((event) => event.type))].sort(),
  }, null, 2));
} finally {
  await gatewayBridge.stop().catch(() => undefined);
  delete process.env.AILY_SIMULATOR_ROOT;
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    200,
    result?.error?.message || `Unexpected HTTP ${response.status}`,
  );
  return result;
}

async function waitForDebugStop(baseUrl, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/v1/sessions/electron-bridge-smoke/debug`,
      { headers },
    );
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    if (
      snapshot.state === 'stopped'
      && snapshot.reason === 'breakpoint-hit'
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for Electron bridge GDB breakpoint.');
}

function xiaoBoardOnlyGraph() {
  return {
    version: '1.0',
    componentConfigs: {
      xiao_esp32s3: {
        id: 'component_1771340537742',
        name: 'XIAO ESP32S3',
        board: '@aily-project/board-xiao_esp32s3',
      },
    },
    components: [
      {
        refId: 'xiao_esp32s3',
        componentId: 'component_1771340537742',
        componentName: 'XIAO ESP32S3',
        configFile: 'xiao_esp32s3_config.json',
      },
    ],
    connections: [],
  };
}

async function collectEventsUntilReady(baseUrl, token, signal) {
  const response = await fetch(
    `${baseUrl}/v1/sessions/electron-bridge-smoke/events?after=0`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
  );
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true })
        .replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) events.push(JSON.parse(data));
        const uart = events
          .filter((event) => event.type === 'uart.data')
          .map((event) => Buffer.from(
            event.payload.dataBase64,
            'base64',
          ).toString('utf8'))
          .join('');
        if (uart.includes('AILY_SIM_FIXTURE:ESP32S3_UART:READY')) {
          return events;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    throw new Error('Timed out waiting for Gateway UART events.');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
