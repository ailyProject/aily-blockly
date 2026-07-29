const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  GATEWAY_SHUTDOWN_MESSAGE,
  isSameProjectPath,
  matchesGatewayOwnership,
  originFromSenderUrl,
  parseStartupJson,
  readArtifactBlockSourceMap,
  readArtifactDebugSource,
  readRuntimeBundle,
  shutdownGatewayProcess,
} = require('./simulator-gateway');

test('derives an exact HTTP origin and uses null for packaged files', () => {
  assert.equal(
    originFromSenderUrl('http://localhost:4200/main/blockly-editor'),
    'http://localhost:4200',
  );
  assert.equal(
    originFromSenderUrl('https://app.aily.pro/index.html'),
    'https://app.aily.pro',
  );
  assert.equal(originFromSenderUrl('file:///C:/app/index.html'), 'null');
});

test('parses only complete Gateway startup JSON', () => {
  assert.equal(parseStartupJson('{\n  "service": "aily'), null);
  assert.deepEqual(
    parseStartupJson(JSON.stringify({
      service: 'aily-simulator-gateway',
      baseUrl: 'http://127.0.0.1:43100',
    })),
    {
      service: 'aily-simulator-gateway',
      baseUrl: 'http://127.0.0.1:43100',
    },
  );
});

test('gracefully shuts down the owned Gateway over its private IPC channel', async () => {
  const child = new FakeChildProcess({ connected: true });
  const shutdown = shutdownGatewayProcess(child, {
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 20,
    forceTerminate: async () => {
      assert.fail('graceful Gateway shutdown must not use the force fallback');
    },
  });

  assert.deepEqual(child.messages, [GATEWAY_SHUTDOWN_MESSAGE]);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await shutdown;
  assert.deepEqual(child.killSignals, []);
});

test('does not mistake child.killed for process exit and forces the owned tree', async () => {
  const child = new FakeChildProcess({
    connected: false,
    killed: true,
  });
  let forceCalls = 0;
  await shutdownGatewayProcess(child, {
    gracefulTimeoutMs: 5,
    forceTimeoutMs: 20,
    forceTerminate: async (ownedChild) => {
      forceCalls += 1;
      assert.equal(ownedChild, child);
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
    },
  });

  assert.equal(forceCalls, 1);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('matches renderer cleanup only to the Gateway project it owns', () => {
  assert.equal(isSameProjectPath('C:\\work\\alpha', 'c:\\WORK\\alpha'), process.platform === 'win32');
  assert.equal(isSameProjectPath('/work/alpha', '/work/alpha'), true);
  assert.equal(isSameProjectPath('/work/alpha', '/work/beta'), false);
  assert.equal(isSameProjectPath('/work/alpha', null), true);
  assert.equal(matchesGatewayOwnership({
    expectedProjectPath: '/work/alpha',
    expectedOwnerId: 'editor-old',
    actualProjectPath: '/work/alpha',
    actualOwnerId: 'editor-new',
  }), false);
  assert.equal(matchesGatewayOwnership({
    expectedProjectPath: '/work/alpha',
    expectedOwnerId: 'editor-new',
    actualProjectPath: '/work/alpha',
    actualOwnerId: 'editor-new',
  }), true);
  assert.equal(matchesGatewayOwnership({
    actualProjectPath: '/work/alpha',
    actualOwnerId: 'editor-new',
  }), true);
});

test('accepts only an intact release runtime bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gateway = writeFixture(root, 'packages/gateway/cli.js', 'gateway');
  const qemu = writeFixture(
    root,
    'runtime/qemu/bin/qemu-system-xtensa.exe',
    'patched-qemu',
  );
  const gdb = writeFixture(
    root,
    'runtime/gdb/bin/xtensa-esp32s3-elf-gdb.exe',
    'espressif-gdb',
  );
  const freeRtosBridge = writeFixture(
    root,
    'packages/simulator-host/gdb/aily_freertos_snapshot.gdb',
    'print("fixture")',
  );
  fs.mkdirSync(path.join(root, 'runtime/qemu/share/qemu'), {
    recursive: true,
  });
  const requiredFileSha256 = {
    'packages/gateway/cli.js': sha256(gateway),
    'runtime/qemu/bin/qemu-system-xtensa.exe': sha256(qemu),
    'runtime/gdb/bin/xtensa-esp32s3-elf-gdb.exe': sha256(gdb),
    'packages/simulator-host/gdb/aily_freertos_snapshot.gdb':
      sha256(freeRtosBridge),
  };
  fs.writeFileSync(
    path.join(root, 'aily-simulator-runtime.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture-runtime',
      platform: `${process.platform}-${process.arch}`,
      mode: 'release',
      redistributionReady: true,
      entrypoints: {
        gateway: 'packages/gateway/cli.js',
        qemu: 'runtime/qemu/bin/qemu-system-xtensa.exe',
        qemuData: 'runtime/qemu/share/qemu',
        gdb: 'runtime/gdb/bin/xtensa-esp32s3-elf-gdb.exe',
        freeRtosBridge:
          'packages/simulator-host/gdb/aily_freertos_snapshot.gdb',
      },
      integrity: {
        qemuExecutableSha256:
          requiredFileSha256['runtime/qemu/bin/qemu-system-xtensa.exe'],
        gdbExecutableSha256:
          requiredFileSha256['runtime/gdb/bin/xtensa-esp32s3-elf-gdb.exe'],
        requiredFileSha256,
      },
    }),
  );

  const bundle = readRuntimeBundle(root, true);
  assert.equal(bundle.manifest.id, 'fixture-runtime');
  assert.equal(bundle.gatewayEntry, gateway);
  assert.equal(bundle.qemuExecutable, qemu);
  assert.equal(bundle.gdbExecutable, gdb);
  assert.equal(bundle.freeRtosBridgePath, freeRtosBridge);

  fs.appendFileSync(qemu, 'tampered');
  assert.throws(
    () => readRuntimeBundle(root, true),
    /完整性校验失败/,
  );
});

test('rejects a development runtime in a packaged application', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'aily-simulator-runtime.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'development-runtime',
      platform: `${process.platform}-${process.arch}`,
      mode: 'development',
      redistributionReady: false,
      entrypoints: {},
      integrity: { requiredFileSha256: {} },
    }),
  );
  assert.throws(
    () => readRuntimeBundle(root, true),
    /不是可分发 release bundle/,
  );
});

test('returns only an integrity-checked Artifact debug source snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-source-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildRoot = path.join(root, '.build');
  fs.mkdirSync(buildRoot);
  const contents = 'void setup() {}\\nvoid loop() { delay(100); }\\n';
  const sourcePath = path.join(buildRoot, 'aily-debug-source.txt');
  fs.writeFileSync(sourcePath, contents);
  const revision = sha256(sourcePath);
  const artifact = {
    build: {
      source: {
        path: 'sketch.ino',
        sizeBytes: Buffer.byteLength(contents),
        sha256: revision,
      },
    },
    files: [{
      role: 'debug-source',
      path: 'aily-debug-source.txt',
      sizeBytes: Buffer.byteLength(contents),
      sha256: revision,
    }],
    debug: {
      sourceSnapshotPath: 'aily-debug-source.txt',
    },
  };

  assert.deepEqual(readArtifactDebugSource(root, artifact), {
    file: 'sketch.ino',
    revision,
    sizeBytes: Buffer.byteLength(contents),
    content: contents,
  });

  fs.appendFileSync(sourcePath, 'tampered');
  assert.throws(
    () => readArtifactDebugSource(root, artifact),
    /大小无效|完整性校验失败/,
  );
});

test('returns only an integrity-checked multi-range Blockly source map', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-source-map-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildRoot = path.join(root, '.build');
  fs.mkdirSync(buildRoot);
  const sourceContents =
    'int helper = 0;\\nvoid setup() {}\\nvoid loop() { helper++; }\\n';
  const sourceSha256 = crypto
    .createHash('sha256')
    .update(sourceContents)
    .digest('hex');
  const sourceMap = JSON.stringify({
    schemaVersion: 1,
    kind: 'aily-block-source-map',
    source: {
      path: 'sketch.ino',
      sizeBytes: Buffer.byteLength(sourceContents),
      sha256: sourceSha256,
    },
    mappings: [{
      blockId: 'multi-range-block',
      executionRole: 'statement',
      ranges: [
        { startLine: 3, endLine: 3 },
        { startLine: 1, endLine: 1 },
      ],
      executableRanges: [{ startLine: 3, endLine: 3 }],
      supportRanges: [{ startLine: 1, endLine: 1 }],
    }],
  });
  const sourceMapPath = path.join(buildRoot, 'aily-block-source-map.json');
  fs.writeFileSync(sourceMapPath, sourceMap);
  const revision = sha256(sourceMapPath);
  const artifact = {
    build: {
      source: {
        path: 'sketch.ino',
        sizeBytes: Buffer.byteLength(sourceContents),
        sha256: sourceSha256,
      },
    },
    files: [{
      role: 'source-map',
      path: 'aily-block-source-map.json',
      sizeBytes: Buffer.byteLength(sourceMap),
      sha256: revision,
    }],
    debug: {
      sourceMapPath: 'aily-block-source-map.json',
    },
  };

  assert.deepEqual(readArtifactBlockSourceMap(root, artifact), {
    revision,
    source: {
      file: 'sketch.ino',
      sizeBytes: Buffer.byteLength(sourceContents),
      sha256: sourceSha256,
    },
    mappings: [{
      blockId: 'multi-range-block',
      executionRole: 'statement',
      ranges: [
        { startLine: 1, endLine: 1 },
        { startLine: 3, endLine: 3 },
      ],
      executableRanges: [{ startLine: 3, endLine: 3 }],
      supportRanges: [{ startLine: 1, endLine: 1 }],
    }],
  });

  fs.appendFileSync(sourceMapPath, 'tampered');
  assert.throws(
    () => readArtifactBlockSourceMap(root, artifact),
    /大小无效|完整性校验失败/,
  );
});

function writeFixture(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function sha256(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

class FakeChildProcess extends EventEmitter {
  constructor({ connected, killed = false }) {
    super();
    this.connected = connected;
    this.killed = killed;
    this.exitCode = null;
    this.signalCode = null;
    this.messages = [];
    this.killSignals = [];
  }

  send(message, callback) {
    this.messages.push(message);
    callback?.(null);
    return true;
  }

  kill(signal) {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }
}
