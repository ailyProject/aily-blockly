const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_TAIL_BYTES = 32 * 1024;
const DEBUG_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const BLOCK_SOURCE_MAP_MAX_BYTES = 16 * 1024 * 1024;
const GATEWAY_SHUTDOWN_MESSAGE = Object.freeze({
  type: 'aily-simulator-gateway.shutdown',
  version: 1,
});

let handlersRegistered = false;
let gatewayProcess = null;
let gatewayDescriptor = null;
let gatewayStartPromise = null;
let gatewayStartProjectPath = null;
let gatewayStartOwnerId = null;
let gatewayStopPromise = null;
let lastGatewayFailure = null;
let getMainWindow = () => null;

function registerHandlers({ ipcMain, app, mainWindow }) {
  getMainWindow = mainWindow || getMainWindow;
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle('simulator-gateway-start', async (
    event,
    projectPath,
    ownerId,
  ) => {
    return start({
      app,
      projectPath,
      ownerId,
      rendererOrigin: originFromSenderUrl(event.senderFrame?.url),
    });
  });
  ipcMain.handle('simulator-gateway-status', async () => status());
  ipcMain.handle('simulator-gateway-stop', async (
    _event,
    expectedProjectPath,
    expectedOwnerId,
  ) => {
    await stop(expectedProjectPath, expectedOwnerId);
    return status();
  });
}

async function start({ app, projectPath, rendererOrigin, ownerId }) {
  const projectRoot = requireProjectRoot(projectPath);
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const buildPath = path.join(projectRoot, '.build');
  const artifactPath = path.join(
    buildPath,
    'aily-artifact-manifest.json',
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      '未找到 .build/aily-artifact-manifest.json，请先使用最新 aily-builder 编译项目。',
    );
  }
  const artifact = readJsonFile(artifactPath, '仿真固件描述');

  if (
    gatewayDescriptor
    && gatewayProcess
    && gatewayProcess.exitCode === null
    && gatewayDescriptor.projectPath === projectRoot
  ) {
    gatewayDescriptor.ownerId = normalizedOwnerId;
    return publicDescriptor(gatewayDescriptor, artifact);
  }
  if (gatewayStartPromise) {
    const pendingStart = gatewayStartPromise;
    if (gatewayStartProjectPath === projectRoot) {
      gatewayStartOwnerId = normalizedOwnerId;
      const result = await pendingStart;
      if (gatewayDescriptor?.projectPath === projectRoot) {
        gatewayDescriptor.ownerId = normalizedOwnerId;
      }
      return result;
    }
    await pendingStart.catch(() => undefined);
    return start({
      app,
      projectPath: projectRoot,
      rendererOrigin,
      ownerId: normalizedOwnerId,
    });
  }

  gatewayStartProjectPath = projectRoot;
  gatewayStartOwnerId = normalizedOwnerId;
  const startPromise = (async () => {
    await stop();
    lastGatewayFailure = null;
    sendStateChanged({ state: 'starting', projectPath: projectRoot });
    const runtime = resolveRuntimePaths({
      app,
      moduleDirectory: __dirname,
    });
    const accessToken = crypto.randomBytes(32).toString('hex');
    const workDirectory = path.join(
      app.getPath('userData'),
      'simulator',
      'sessions',
    );
    fs.mkdirSync(workDirectory, { recursive: true });

    const args = [
      runtime.gatewayEntry,
      '--qemu', runtime.qemuExecutable,
      '--artifact-root', buildPath,
      '--work-directory', workDirectory,
      '--origin', rendererOrigin,
      '--port', '0',
      '--token', accessToken,
    ];
    if (runtime.qemuDataDirectory) {
      args.push('--qemu-data', runtime.qemuDataDirectory);
    }
    if (runtime.gdbExecutable) {
      args.push('--gdb', runtime.gdbExecutable);
      if (runtime.freeRtosBridgePath) {
        args.push('--freertos-bridge', runtime.freeRtosBridgePath);
      }
    }
    const child = spawn(process.execPath, args, {
      cwd: runtime.simulatorRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      shell: false,
    });
    gatewayProcess = child;
    const processDiagnostics = captureProcessDiagnostics(child);

    try {
      const startup = await waitForGatewayStartup(child);
      if (gatewayProcess !== child) {
        throw new Error('本地 Simulator Gateway 启动已取消。');
      }
      gatewayDescriptor = {
        service: 'aily-simulator-gateway',
        baseUrl: startup.baseUrl,
        accessToken,
        artifactDirectory: '.',
        projectPath: projectRoot,
        ownerId: gatewayStartOwnerId,
        runtimeSource: runtime.source,
        runtimePackId: runtime.runtimePackId,
        runtimeMode: runtime.runtimeMode,
      };
      child.stdout?.resume();
      child.stderr?.on('data', (chunk) => {
        const message = chunk.toString('utf8').trim();
        if (message) console.warn('[SimulatorGateway]', message);
      });
      child.once('exit', (code, signal) => {
        if (gatewayProcess !== child) return;
        gatewayProcess = null;
        gatewayDescriptor = null;
        lastGatewayFailure = {
          phase: 'runtime',
          message: `本地仿真服务意外退出（code=${code}, signal=${signal}）。`,
          code,
          signal,
          stdoutTail: processDiagnostics.stdoutTail(),
          stderrTail: processDiagnostics.stderrTail(),
          occurredAt: new Date().toISOString(),
        };
        sendStateChanged({
          state: 'stopped',
          unexpected: true,
          code,
          signal,
          failure: lastGatewayFailure,
        });
      });
      sendStateChanged({
        state: 'ready',
        runtimeSource: runtime.source,
        runtimePackId: runtime.runtimePackId,
        runtimeMode: runtime.runtimeMode,
      });
      return publicDescriptor(gatewayDescriptor, artifact);
    } catch (error) {
      const ownsCurrentGateway = gatewayProcess === child;
      if (ownsCurrentGateway) {
        gatewayProcess = null;
        gatewayDescriptor = null;
      }
      await shutdownGatewayProcess(child, {
        gracefulTimeoutMs: 1_000,
      });
      if (!ownsCurrentGateway) throw error;
      lastGatewayFailure = {
        phase: 'startup',
        message: error instanceof Error ? error.message : String(error),
        code: child.exitCode,
        signal: child.signalCode,
        stdoutTail: processDiagnostics.stdoutTail(),
        stderrTail: processDiagnostics.stderrTail(),
        occurredAt: new Date().toISOString(),
      };
      sendStateChanged({
        state: 'failed',
        unexpected: true,
        failure: lastGatewayFailure,
      });
      throw error;
    }
  })();
  gatewayStartPromise = startPromise;

  try {
    return await startPromise;
  } finally {
    if (gatewayStartPromise === startPromise) {
      gatewayStartPromise = null;
      gatewayStartProjectPath = null;
      gatewayStartOwnerId = null;
    }
  }
}

function status() {
  if (!gatewayProcess || !gatewayDescriptor) {
    return {
      state: 'stopped',
      ...(lastGatewayFailure ? { lastFailure: lastGatewayFailure } : {}),
    };
  }
  return {
    state: 'ready',
    baseUrl: gatewayDescriptor.baseUrl,
    projectPath: gatewayDescriptor.projectPath,
    runtimeSource: gatewayDescriptor.runtimeSource,
    runtimePackId: gatewayDescriptor.runtimePackId,
    runtimeMode: gatewayDescriptor.runtimeMode,
  };
}

async function stop(expectedProjectPath, expectedOwnerId) {
  if (gatewayStopPromise) return gatewayStopPromise;
  const actualProjectPath =
    gatewayDescriptor?.projectPath ?? gatewayStartProjectPath;
  const actualOwnerId =
    gatewayDescriptor?.ownerId ?? gatewayStartOwnerId;
  const ownershipMatches = matchesGatewayOwnership({
    expectedProjectPath,
    expectedOwnerId,
    actualProjectPath,
    actualOwnerId,
  });
  if (gatewayProcess || expectedProjectPath || expectedOwnerId) {
    console.info('[SimulatorGateway][STOP_REQUEST]', {
      expectedProjectPath: expectedProjectPath ?? null,
      expectedOwnerId: expectedOwnerId ?? null,
      actualProjectPath: actualProjectPath ?? null,
      actualOwnerId: actualOwnerId ?? null,
      ownershipMatches,
      hasGatewayProcess: !!gatewayProcess,
      startPending: !!gatewayStartPromise,
    });
  }
  if (!ownershipMatches) return;
  const child = gatewayProcess;
  gatewayProcess = null;
  gatewayDescriptor = null;
  if (!child || hasChildExited(child)) return;

  const stopPromise = (async () => {
    await shutdownGatewayProcess(child);
    sendStateChanged({ state: 'stopped', unexpected: false });
  })();
  gatewayStopPromise = stopPromise;
  try {
    await stopPromise;
  } finally {
    if (gatewayStopPromise === stopPromise) gatewayStopPromise = null;
  }
}

function terminateChild(child) {
  try {
    child.kill('SIGTERM');
  } catch {
    // The process may already have exited.
  }
}

async function shutdownGatewayProcess(child, options = {}) {
  if (!child || hasChildExited(child)) return;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? STOP_TIMEOUT_MS;
  const forceTimeoutMs = options.forceTimeoutMs ?? FORCE_STOP_TIMEOUT_MS;
  const forceTerminate = options.forceTerminate ?? forceTerminateProcessTree;
  const gracefulRequested = requestGatewayShutdown(child);
  if (!gracefulRequested) terminateChild(child);
  if (await waitForChildExit(child, gracefulTimeoutMs)) return;

  await forceTerminate(child);
  await waitForChildExit(child, forceTimeoutMs);
}

function requestGatewayShutdown(child) {
  if (
    child.connected !== true
    || typeof child.send !== 'function'
  ) {
    return false;
  }
  try {
    child.send(GATEWAY_SHUTDOWN_MESSAGE, (error) => {
      if (error && !hasChildExited(child)) terminateChild(child);
    });
    return true;
  } catch {
    return false;
  }
}

function waitForChildExit(child, timeoutMs) {
  if (hasChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener?.('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(hasChildExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function forceTerminateProcessTree(child) {
  if (hasChildExited(child)) return;
  if (
    process.platform === 'win32'
    && Number.isSafeInteger(child.pid)
    && child.pid > 0
  ) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const killer = spawn(
        'taskkill.exe',
        ['/pid', String(child.pid), '/T', '/F'],
        {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        },
      );
      const timeout = setTimeout(finish, FORCE_STOP_TIMEOUT_MS);
      killer.once('error', finish);
      killer.once('exit', finish);
    });
  }
  if (hasChildExited(child)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // The process may have exited while the fallback was being requested.
  }
}

function isSameProjectPath(expectedProjectPath, actualProjectPath) {
  if (!actualProjectPath) return true;
  const expected = path.resolve(String(expectedProjectPath));
  const actual = path.resolve(String(actualProjectPath));
  return process.platform === 'win32'
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
}

function normalizeOwnerId(ownerId) {
  if (ownerId === undefined || ownerId === null || ownerId === '') {
    return null;
  }
  if (
    typeof ownerId !== 'string'
    || ownerId.length > 128
    || !/^[a-zA-Z0-9._:-]+$/.test(ownerId)
  ) {
    throw new Error('Simulator Gateway ownerId 无效。');
  }
  return ownerId;
}

function matchesGatewayOwnership({
  expectedProjectPath,
  expectedOwnerId,
  actualProjectPath,
  actualOwnerId,
}) {
  if (
    expectedOwnerId
    && actualOwnerId
    && normalizeOwnerId(expectedOwnerId) !== actualOwnerId
  ) {
    return false;
  }
  return !expectedProjectPath
    || isSameProjectPath(expectedProjectPath, actualProjectPath);
}

function publicDescriptor(descriptor, artifact) {
  return {
    baseUrl: descriptor.baseUrl,
    accessToken: descriptor.accessToken,
    artifactDirectory: descriptor.artifactDirectory,
    artifact,
    debugSource: readArtifactDebugSource(
      descriptor.projectPath,
      artifact,
    ),
    debugSourceMap: readArtifactBlockSourceMap(
      descriptor.projectPath,
      artifact,
    ),
    runtimeSource: descriptor.runtimeSource,
    runtimePackId: descriptor.runtimePackId,
    runtimeMode: descriptor.runtimeMode,
  };
}

function readArtifactDebugSource(projectRoot, artifact) {
  const sourceSnapshotPath = artifact?.debug?.sourceSnapshotPath;
  if (sourceSnapshotPath === undefined) return null;
  const buildSource = artifact?.build?.source;
  const files = artifact?.files;
  if (
    typeof sourceSnapshotPath !== 'string'
    || !Array.isArray(files)
    || !buildSource
    || typeof buildSource !== 'object'
  ) {
    throw new Error('Artifact 调试源码描述无效。');
  }
  const descriptor = files.find((file) => (
    file?.role === 'debug-source'
    && file.path === sourceSnapshotPath
  ));
  if (
    !descriptor
    || !Number.isSafeInteger(descriptor.sizeBytes)
    || descriptor.sizeBytes < 0
    || descriptor.sizeBytes > DEBUG_SOURCE_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')
    || buildSource.sizeBytes !== descriptor.sizeBytes
    || buildSource.sha256 !== descriptor.sha256
  ) {
    throw new Error('Artifact 调试源码必须与编译输入的大小和 SHA-256 一致。');
  }
  const buildRoot = fs.realpathSync(path.join(projectRoot, '.build'));
  const sourcePath = resolveArtifactPath(
    buildRoot,
    sourceSnapshotPath,
    'Artifact 调试源码',
  );
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size !== descriptor.sizeBytes) {
    throw new Error('Artifact 调试源码文件大小无效。');
  }
  const bytes = fs.readFileSync(sourcePath);
  const revision = crypto.createHash('sha256').update(bytes).digest('hex');
  if (revision !== descriptor.sha256) {
    throw new Error('Artifact 调试源码完整性校验失败。');
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Artifact 调试源码不是有效 UTF-8。');
  }
  const sourceFile = path.basename(String(buildSource.path || ''));
  if (
    !sourceFile
    || sourceFile.length > 512
    || /[\u0000-\u001f\u007f]/.test(sourceFile)
  ) {
    throw new Error('Artifact 编译源码文件名无效。');
  }
  return {
    file: sourceFile,
    revision,
    sizeBytes: bytes.length,
    content,
  };
}

function readArtifactBlockSourceMap(projectRoot, artifact) {
  const sourceMapPath = artifact?.debug?.sourceMapPath;
  if (sourceMapPath === undefined) return null;
  const buildSource = artifact?.build?.source;
  const files = artifact?.files;
  if (
    typeof sourceMapPath !== 'string'
    || !Array.isArray(files)
    || !buildSource
    || typeof buildSource !== 'object'
  ) {
    throw new Error('Artifact Blockly source-map 描述无效。');
  }
  const descriptor = files.find((file) => (
    file?.role === 'source-map'
    && file.path === sourceMapPath
  ));
  if (
    !descriptor
    || !Number.isSafeInteger(descriptor.sizeBytes)
    || descriptor.sizeBytes <= 0
    || descriptor.sizeBytes > BLOCK_SOURCE_MAP_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')
  ) {
    throw new Error('Artifact Blockly source-map 文件描述无效。');
  }
  const buildRoot = fs.realpathSync(path.join(projectRoot, '.build'));
  const mapPath = resolveArtifactPath(
    buildRoot,
    sourceMapPath,
    'Artifact Blockly source-map',
  );
  const stat = fs.statSync(mapPath);
  if (!stat.isFile() || stat.size !== descriptor.sizeBytes) {
    throw new Error('Artifact Blockly source-map 文件大小无效。');
  }
  const bytes = fs.readFileSync(mapPath);
  const revision = crypto.createHash('sha256').update(bytes).digest('hex');
  if (revision !== descriptor.sha256) {
    throw new Error('Artifact Blockly source-map 完整性校验失败。');
  }
  let sourceMap;
  try {
    sourceMap = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error('Artifact Blockly source-map 不是有效 UTF-8 JSON。');
  }
  if (
    !sourceMap
    || typeof sourceMap !== 'object'
    || Array.isArray(sourceMap)
    || sourceMap.schemaVersion !== 1
    || sourceMap.kind !== 'aily-block-source-map'
    || !sourceMap.source
    || typeof sourceMap.source !== 'object'
    || Array.isArray(sourceMap.source)
    || !Array.isArray(sourceMap.mappings)
    || sourceMap.mappings.length > 100_000
  ) {
    throw new Error('Artifact Blockly source-map 协议无效。');
  }
  const sourceFile = String(sourceMap.source.path || '');
  if (
    !sourceFile
    || sourceFile.length > 512
    || path.isAbsolute(sourceFile)
    || /[\u0000-\u001f\u007f]/.test(sourceFile)
    || sourceMap.source.sizeBytes !== buildSource.sizeBytes
    || sourceMap.source.sha256 !== buildSource.sha256
  ) {
    throw new Error(
      'Artifact Blockly source-map 与本次编译输入不一致。',
    );
  }
  const blockIds = new Set();
  const mappings = sourceMap.mappings.map((rawMapping, index) => {
    if (
      !rawMapping
      || typeof rawMapping !== 'object'
      || Array.isArray(rawMapping)
      || typeof rawMapping.blockId !== 'string'
      || rawMapping.blockId.length === 0
      || rawMapping.blockId.length > 256
      || /[\u0000-\u001f\u007f]/.test(rawMapping.blockId)
      || blockIds.has(rawMapping.blockId)
      || (
        rawMapping.executionRole !== undefined
        && rawMapping.executionRole !== 'statement'
        && rawMapping.executionRole !== 'value'
      )
      || !Array.isArray(rawMapping.ranges)
      || rawMapping.ranges.length === 0
      || rawMapping.ranges.length > 1_024
    ) {
      throw new Error(
        `Artifact Blockly source-map 第 ${index + 1} 个块映射无效。`,
      );
    }
    blockIds.add(rawMapping.blockId);
    const ranges = normalizeArtifactBlockSourceRanges(
      rawMapping.ranges,
      rawMapping.blockId,
      'ranges',
      false,
    );
    const classifiedRanges = {};
    for (const field of ['executableRanges', 'supportRanges']) {
      if (rawMapping[field] === undefined) continue;
      const values = normalizeArtifactBlockSourceRanges(
        rawMapping[field],
        rawMapping.blockId,
        field,
        true,
      );
      if (values.some((range) => !ranges.some((owner) => (
        range.startLine >= owner.startLine
        && range.endLine <= owner.endLine
      )))) {
        throw new Error(
          `Artifact Blockly source-map ${rawMapping.blockId} 的 ${field} 超出 ranges。`,
        );
      }
      classifiedRanges[field] = values;
    }
    return {
      blockId: rawMapping.blockId,
      executionRole: rawMapping.executionRole || 'unknown',
      ranges,
      ...classifiedRanges,
    };
  });
  return {
    revision,
    source: {
      file: sourceFile.replace(/\\/g, '/'),
      sizeBytes: sourceMap.source.sizeBytes,
      sha256: sourceMap.source.sha256,
    },
    mappings,
  };
}

function normalizeArtifactBlockSourceRanges(
  value,
  blockId,
  field,
  allowEmpty,
) {
  if (
    !Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.length > 1_024
  ) {
    throw new Error(
      `Artifact Blockly source-map ${blockId} 的 ${field} 无效。`,
    );
  }
  return value.map((rawRange, rangeIndex) => {
    if (
      !rawRange
      || typeof rawRange !== 'object'
      || Array.isArray(rawRange)
      || !Number.isSafeInteger(rawRange.startLine)
      || !Number.isSafeInteger(rawRange.endLine)
      || rawRange.startLine < 1
      || rawRange.endLine < rawRange.startLine
    ) {
      throw new Error(
        'Artifact Blockly source-map '
        + `${blockId} 的 ${field} 第 ${rangeIndex + 1} 个区间无效。`,
      );
    }
    return {
      startLine: rawRange.startLine,
      endLine: rawRange.endLine,
    };
  }).sort((left, right) => (
    left.startLine - right.startLine
    || left.endLine - right.endLine
  ));
}

function resolveArtifactPath(buildRoot, relativePath, label) {
  if (
    !relativePath
    || relativePath.length > 512
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label}必须是 Artifact 内的相对路径。`);
  }
  const candidate = path.resolve(buildRoot, relativePath);
  const relative = path.relative(buildRoot, candidate);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label}逃逸了 Artifact 目录。`);
  }
  const resolved = fs.realpathSync(candidate);
  const realRelative = path.relative(buildRoot, resolved);
  if (
    !realRelative
    || realRelative.startsWith('..')
    || path.isAbsolute(realRelative)
  ) {
    throw new Error(`${label}真实路径逃逸了 Artifact 目录。`);
  }
  return resolved;
}

function waitForGatewayStartup(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(
        '本地 Simulator Gateway 启动超时。'
        + (stderr.trim() ? `\n${tailText(stderr, 4096)}` : ''),
      ));
    }, START_TIMEOUT_MS);

    const onStdout = (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024) {
        cleanup();
        reject(new Error('Simulator Gateway 返回了异常的启动输出。'));
        return;
      }
      const parsed = parseStartupJson(stdout);
      if (!parsed) return;
      if (
        parsed.service !== 'aily-simulator-gateway'
        || typeof parsed.baseUrl !== 'string'
      ) {
        cleanup();
        reject(new Error('Simulator Gateway 启动信息无效。'));
        return;
      }
      cleanup();
      resolve(parsed);
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(
        `Simulator Gateway 启动失败（code=${code}, signal=${signal}）`
        + (stderr.trim() ? `：${stderr.trim()}` : ''),
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function parseStartupJson(output) {
  const text = String(output || '').trim();
  if (!text.endsWith('}')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function originFromSenderUrl(senderUrl) {
  try {
    const url = new URL(senderUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.origin;
    }
  } catch {
    // Packaged renderers use an opaque file origin.
  }
  return 'null';
}

function requireProjectRoot(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new Error('请先打开一个 Blockly 项目。');
  }
  let projectRoot;
  try {
    projectRoot = fs.realpathSync(projectPath);
  } catch {
    throw new Error('当前项目目录不存在。');
  }
  const stat = fs.statSync(projectRoot);
  if (!stat.isDirectory()) throw new Error('当前项目路径不是目录。');
  const hasProjectFile = [
    'project.abi',
    'project.aci',
    'package.json',
  ].some((name) => fs.existsSync(path.join(projectRoot, name)));
  if (!hasProjectFile) {
    throw new Error('当前目录不是可识别的 Aily 项目。');
  }
  return projectRoot;
}

function resolveRuntimePaths({ app, moduleDirectory }) {
  const simulatorRoots = [
    process.env.AILY_SIMULATOR_ROOT,
    app?.isPackaged
      ? path.join(process.resourcesPath, 'simulator')
      : null,
    path.resolve(moduleDirectory, '..', '..', 'aily-simulator'),
  ].filter(Boolean);
  const simulatorRoot = simulatorRoots.find(
    (candidate) => fs.existsSync(candidate),
  );
  if (!simulatorRoot) {
    throw new Error(
      '未找到 aily-simulator runtime。可通过 AILY_SIMULATOR_ROOT 指定。',
    );
  }

  const runtimeBundle = readRuntimeBundle(
    simulatorRoot,
    app?.isPackaged === true,
  );
  const gatewayEntry = process.env.AILY_SIMULATOR_GATEWAY_ENTRY
    || runtimeBundle?.gatewayEntry
    || path.join(
      simulatorRoot,
      'packages',
      'simulator-gateway',
      'dist',
      'cli.js',
    );
  if (!fs.existsSync(gatewayEntry)) {
    throw new Error(
      'Simulator Gateway 尚未构建，请先在 aily-simulator 执行 npm run gateway:build。',
    );
  }

  const qemuExecutable = process.env.AILY_PATCHED_QEMU
    || process.env.AILY_SIMULATOR_QEMU
    || runtimeBundle?.qemuExecutable
    || resolvePatchedQemuExecutable(simulatorRoot);
  if (!qemuExecutable || !fs.existsSync(qemuExecutable)) {
    throw new Error(
      '未找到带 Aily Engine Bridge 的 QEMU runtime。'
      + '可通过 AILY_PATCHED_QEMU 指定。',
    );
  }
  const gdbExecutable = process.env.AILY_SIMULATOR_GDB
    || runtimeBundle?.gdbExecutable
    || resolveWorkspaceGdbExecutable(simulatorRoot);
  const freeRtosBridgeCandidate = process.env.AILY_SIMULATOR_FREERTOS_BRIDGE
    || runtimeBundle?.freeRtosBridgePath
    || path.join(
      simulatorRoot,
      'packages',
      'simulator-host',
      'gdb',
      'aily_freertos_snapshot.gdb',
    );
  const freeRtosBridgePath = fs.existsSync(freeRtosBridgeCandidate)
    ? freeRtosBridgeCandidate
    : null;
  return {
    simulatorRoot,
    gatewayEntry,
    qemuExecutable,
    qemuDataDirectory: runtimeBundle?.qemuDataDirectory
      || resolveQemuDataDirectory(qemuExecutable),
    gdbExecutable,
    freeRtosBridgePath,
    runtimePackId: runtimeBundle?.manifest.id,
    runtimeMode: runtimeBundle?.manifest.mode,
    source: process.env.AILY_SIMULATOR_ROOT
      ? 'environment'
      : app?.isPackaged
      ? 'packaged'
      : 'workspace',
  };
}

function readRuntimeBundle(simulatorRoot, requireRelease) {
  const manifestPath = path.join(
    simulatorRoot,
    'aily-simulator-runtime.json',
  );
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = readJsonFile(manifestPath, 'Simulator Runtime Manifest');
  const platform = `${process.platform}-${process.arch}`;
  if (
    manifest?.schemaVersion !== 1
    || typeof manifest?.id !== 'string'
    || manifest?.platform !== platform
    || typeof manifest?.entrypoints !== 'object'
    || typeof manifest?.integrity?.requiredFileSha256 !== 'object'
  ) {
    throw new Error(
      `Simulator Runtime Manifest 无效或平台不匹配（需要 ${platform}）。`,
    );
  }
  if (requireRelease && manifest.redistributionReady !== true) {
    throw new Error(
      `安装包中的 Simulator Runtime ${manifest.id} `
      + '不是可分发 release bundle。',
    );
  }
  const gatewayEntry = resolveBundlePath(
    simulatorRoot,
    manifest.entrypoints.gateway,
    'Gateway entry',
  );
  const qemuExecutable = resolveBundlePath(
    simulatorRoot,
    manifest.entrypoints.qemu,
    'QEMU executable',
  );
  const qemuDataDirectory = resolveBundlePath(
    simulatorRoot,
    manifest.entrypoints.qemuData,
    'QEMU data directory',
  );
  const gdbExecutable = resolveBundlePath(
    simulatorRoot,
    manifest.entrypoints.gdb,
    'GDB executable',
  );
  const freeRtosBridgePath = manifest.entrypoints.freeRtosBridge
    ? resolveBundlePath(
        simulatorRoot,
        manifest.entrypoints.freeRtosBridge,
        'FreeRTOS GDB bridge',
      )
    : null;
  for (const filePath of [
    gatewayEntry,
    qemuExecutable,
    gdbExecutable,
    freeRtosBridgePath,
  ].filter(Boolean)) {
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Simulator Runtime 文件无效：${filePath}`);
    }
  }
  if (!fs.statSync(qemuDataDirectory).isDirectory()) {
    throw new Error(`Simulator Runtime QEMU data 目录无效：${qemuDataDirectory}`);
  }
  for (const relativePath of [
    manifest.entrypoints.gateway,
    manifest.entrypoints.qemu,
    manifest.entrypoints.gdb,
    ...(manifest.entrypoints.freeRtosBridge
      ? [manifest.entrypoints.freeRtosBridge]
      : []),
  ]) {
    const expected = manifest.integrity.requiredFileSha256[relativePath];
    if (typeof expected !== 'string') {
      throw new Error(`Simulator Runtime 缺少关键文件哈希：${relativePath}`);
    }
    const actual = sha256FileSync(resolveBundlePath(
      simulatorRoot,
      relativePath,
      'runtime integrity file',
    ));
    if (actual !== expected) {
      throw new Error(`Simulator Runtime 完整性校验失败：${relativePath}`);
    }
  }
  if (
    manifest.integrity.qemuExecutableSha256
    !== manifest.integrity.requiredFileSha256[manifest.entrypoints.qemu]
  ) {
    throw new Error('Simulator Runtime QEMU 哈希与发布描述不一致。');
  }
  if (
    manifest.integrity.gdbExecutableSha256
    !== manifest.integrity.requiredFileSha256[manifest.entrypoints.gdb]
  ) {
    throw new Error('Simulator Runtime GDB 哈希与发布描述不一致。');
  }
  return {
    manifest,
    gatewayEntry,
    qemuExecutable,
    qemuDataDirectory,
    gdbExecutable,
    freeRtosBridgePath,
  };
}

function resolvePatchedQemuExecutable(simulatorRoot) {
  const executable = process.platform === 'win32'
    ? 'qemu-system-xtensa.exe'
    : 'qemu-system-xtensa';
  const platformDirectory = process.platform === 'win32'
    ? `windows-${process.arch}`
    : `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(
      simulatorRoot,
      'runtime',
      'qemu',
      'bin',
      executable,
    ),
    path.join(
      simulatorRoot,
      '.runtime',
      'build',
      'aily-qemu',
      platformDirectory,
      'install',
      'qemu',
      'bin',
      executable,
    ),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function resolveQemuDataDirectory(executablePath) {
  if (!executablePath) return '';
  const candidate = path.resolve(
    path.dirname(executablePath),
    '..',
    'share',
    'qemu',
  );
  return fs.existsSync(candidate) ? candidate : '';
}

function resolveWorkspaceGdbExecutable(simulatorRoot) {
  const executable = process.platform === 'win32'
    ? 'xtensa-esp32s3-elf-gdb.exe'
    : 'xtensa-esp32s3-elf-gdb';
  const candidates = [
    path.join(
      simulatorRoot,
      'runtime',
      'gdb',
      'bin',
      executable,
    ),
    path.join(
      simulatorRoot,
      '.runtime',
      'qemu',
      'espressif-qemu-xtensa-9.2.2-20250817',
      `${process.platform}-${process.arch}`,
      'debugger',
      'xtensa-esp-elf-gdb',
      'bin',
      executable,
    ),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function resolveBundlePath(root, relativePath, label) {
  if (
    typeof relativePath !== 'string'
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} 必须是 bundle 内的相对路径。`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} 逃逸了 Simulator Runtime bundle。`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} 不存在：${resolved}`);
  }
  return resolved;
}

function sha256FileSync(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function captureProcessDiagnostics(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = tailText(stdout + chunk.toString('utf8'), DIAGNOSTIC_TAIL_BYTES);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = tailText(stderr + chunk.toString('utf8'), DIAGNOSTIC_TAIL_BYTES);
  });
  return {
    stdoutTail: () => stdout,
    stderrTail: () => stderr,
  };
}

function tailText(value, maximumLength) {
  return value.length <= maximumLength
    ? value
    : value.slice(value.length - maximumLength);
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label}无法读取：${error.message}`);
  }
}

function sendStateChanged(payload) {
  const window = getMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  window.webContents.send('simulator-gateway-state-changed', payload);
}

module.exports = {
  GATEWAY_SHUTDOWN_MESSAGE,
  hasChildExited,
  isSameProjectPath,
  matchesGatewayOwnership,
  normalizeOwnerId,
  originFromSenderUrl,
  parseStartupJson,
  readArtifactBlockSourceMap,
  readArtifactDebugSource,
  readRuntimeBundle,
  registerHandlers,
  resolveRuntimePaths,
  shutdownGatewayProcess,
  start,
  status,
  stop,
  waitForChildExit,
};
