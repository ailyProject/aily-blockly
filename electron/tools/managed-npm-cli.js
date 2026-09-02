'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const semver = require('semver');

const { isWin32 } = require('../platform');

// npm mutates shared files below a global prefix. Keep every managed tool using
// the same prefix on one queue, including mutations requested through separate
// IPC handlers after startup.
const prefixMutationTails = new Map();

function getManagedNpmPrefix() {
  return process.env.AILY_NPM_PREFIX
    || (process.env.AILY_APPDATA_PATH
      ? path.join(process.env.AILY_APPDATA_PATH, 'npm-global')
      : '');
}

function getManagedNpmEnv(prefix = getManagedNpmPrefix()) {
  return prefix
    ? { ...process.env, npm_config_prefix: prefix }
    : { ...process.env };
}

function applyManagedCommandEnv(prefix = getManagedNpmPrefix()) {
  if (!prefix) return;
  const binPath = isWin32 ? prefix : path.join(prefix, 'bin');
  const currentPath = process.env.PATH || '';
  const pathParts = currentPath.split(path.delimiter).filter(Boolean);
  const normalizedBinPath = isWin32 ? binPath.toLowerCase() : binPath;
  const alreadyPresent = pathParts.some((entry) => (
    (isWin32 ? entry.toLowerCase() : entry) === normalizedBinPath
  ));
  if (!alreadyPresent) {
    process.env.PATH = `${binPath}${path.delimiter}${currentPath}`;
  }
}

function getChildNodeExecutable(childPath) {
  const candidate = isWin32
    ? path.join(childPath || '', 'node', 'node.exe')
    : path.join(childPath || '', 'node', 'bin', 'node');
  return candidate && fs.existsSync(candidate) ? candidate : 'node';
}

function getChildNpmExecutable(childPath) {
  const candidate = isWin32
    ? path.join(childPath || '', 'node', 'npm.cmd')
    : path.join(childPath || '', 'node', 'bin', 'npm');
  return candidate && fs.existsSync(candidate) ? candidate : 'npm';
}

function managedBinCandidates(prefix, binKey) {
  if (!prefix || !binKey) return [];
  return isWin32
    ? [
      path.join(prefix, `${binKey}.cmd`),
      path.join(prefix, `${binKey}.exe`),
      path.join(prefix, binKey),
    ]
    : [path.join(prefix, 'bin', binKey)];
}

function resolveManagedBinPath({
  binKey,
  prefix = getManagedNpmPrefix(),
}) {
  return managedBinCandidates(prefix, binKey)
    .find(candidate => fs.existsSync(candidate)) || '';
}

function packageRootCandidates(prefix, packageName) {
  if (!prefix || typeof packageName !== 'string' || !packageName) return [];
  const packageParts = packageName.split('/');
  return isWin32
    ? [path.join(prefix, 'node_modules', ...packageParts)]
    : [
      path.join(prefix, 'lib', 'node_modules', ...packageParts),
      path.join(prefix, 'node_modules', ...packageParts),
    ];
}

function resolvePackageAtRoot(packageRoot, binKey, source = 'managed') {
  try {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const binEntry = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[binKey];
    const entry = binEntry || packageJson.main;
    if (!entry) return null;
    const entryPath = path.resolve(packageRoot, entry);
    if (!isPathInside(packageRoot, entryPath) || !fs.existsSync(entryPath)) return null;
    return {
      packageRoot,
      entryPath,
      version: typeof packageJson.version === 'string' ? packageJson.version : null,
      packageName: packageJson.name,
      source,
    };
  } catch {
    return null;
  }
}

function resolveManagedPackage({ packageName, binKey, prefix = getManagedNpmPrefix() }) {
  for (const packageRoot of packageRootCandidates(prefix, packageName)) {
    const resolved = resolvePackageAtRoot(packageRoot, binKey, 'managed');
    if (resolved?.packageName === packageName) return resolved;
  }
  return null;
}

function resolveLocalPackage({ packageName, binKey, projectPath }) {
  if (!projectPath) return null;
  const packageRoot = path.resolve(projectPath);
  const resolved = resolvePackageAtRoot(packageRoot, binKey, 'local');
  if (resolved?.packageName === packageName) return resolved;
  return null;
}

function parseManagedCliVersion(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  const versionMatch = text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
  return versionMatch ? versionMatch[0] : text.split(/\r?\n/)[0].trim();
}

function probeManagedCommand({
  packageName,
  binKey,
  prefix = getManagedNpmPrefix(),
  commandNotFoundError = `${binKey} command was not found in the configured npm prefix`,
  packageIncompleteError = `${packageName} is installed but its CLI entry file is missing`,
  timeoutMs = 5_000,
  parseVersion = parseManagedCliVersion,
}) {
  const commandPath = resolveManagedBinPath({ binKey, prefix });
  const resolved = resolveManagedPackage({ packageName, binKey, prefix });
  const baseState = {
    path: commandPath,
    entryPath: resolved?.entryPath || '',
    packageRoot: resolved?.packageRoot || '',
    version: resolved?.version || null,
    installed: false,
    error: '',
  };
  if (!commandPath) {
    return {
      ...baseState,
      ok: false,
      version: null,
      error: commandNotFoundError,
    };
  }

  const command = isWin32 ? quoteWindowsShellPath(commandPath) : commandPath;
  const result = spawnSync(command, ['--version'], {
    env: getManagedNpmEnv(prefix),
    shell: isWin32,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const version = parseVersion(output) || resolved?.version || null;
  if (result.error || result.status !== 0) {
    return {
      ...baseState,
      ok: false,
      version: null,
      error: result.error?.message || output || `${binKey} --version exited with ${result.status}`,
    };
  }
  if (!resolved) {
    return {
      ...baseState,
      ok: false,
      version,
      error: packageIncompleteError,
    };
  }
  return {
    ...baseState,
    ok: true,
    version,
  };
}

function probeManagedCli({
  resolved,
  childPath,
  prefix = getManagedNpmPrefix(),
  capabilityArgs = ['capabilities', '--json'],
  expectedProtocolVersion,
  timeoutMs = 8_000,
}) {
  if (!resolved?.entryPath) {
    return { ok: false, error: 'Managed CLI package entry was not found' };
  }
  const nodeExecutable = getChildNodeExecutable(childPath);
  const versionResult = spawnSync(nodeExecutable, [resolved.entryPath, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: getManagedNpmEnv(prefix),
  });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      ok: false,
      error: versionResult.error?.message
        || String(versionResult.stderr || versionResult.stdout || `CLI exited with ${versionResult.status}`).trim(),
    };
  }
  const capabilitiesResult = spawnSync(nodeExecutable, [resolved.entryPath, ...capabilityArgs], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: getManagedNpmEnv(prefix),
  });
  if (capabilitiesResult.error || capabilitiesResult.status !== 0) {
    return {
      ok: false,
      error: capabilitiesResult.error?.message
        || String(capabilitiesResult.stderr || capabilitiesResult.stdout || `capabilities exited with ${capabilitiesResult.status}`).trim(),
    };
  }
  try {
    const capabilities = JSON.parse(String(capabilitiesResult.stdout || '').trim());
    if (
      expectedProtocolVersion !== undefined
      && capabilities.protocolVersion !== expectedProtocolVersion
    ) {
      return {
        ok: false,
        error: `Managed CLI protocol ${String(capabilities.protocolVersion)} is incompatible with ${expectedProtocolVersion}`,
      };
    }
    return {
      ok: true,
      ...resolved,
      nodeExecutable,
      version: String(versionResult.stdout || '').trim() || resolved.version,
      capabilities,
    };
  } catch (error) {
    return { ok: false, error: `Managed CLI returned invalid capabilities JSON: ${error.message}` };
  }
}

function withConfiguredRegistry(args, registry = process.env.AILY_NPM_REGISTRY) {
  const result = [...args];
  if (registry) result.push('--registry', registry);
  return result;
}

function installManagedPackage({
  packageSpec,
  childPath,
  prefix = getManagedNpmPrefix(),
  force = false,
  onLog,
  logMessages,
}) {
  const args = [
    'install',
    '--global',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
  ];
  if (force) args.push('--force');
  args.push(packageSpec);
  return runManagedNpm({
    args: withConfiguredRegistry(args),
    childPath,
    prefix,
    onLog,
    logMessages,
  });
}

function runManagedNpm({
  args,
  childPath,
  prefix = getManagedNpmPrefix(),
  onLog,
  logMessages = {},
}) {
  if (!prefix) return Promise.reject(new Error('AILY_NPM_PREFIX is not configured'));
  const npmPath = getChildNpmExecutable(childPath);
  const npmCommand = isWin32 ? quoteWindowsShellPath(npmPath) : npmPath;
  const displayCommand = `npm ${args.join(' ')}`;
  emitNpmLog(onLog, {
    title: logMessages.runningCommand || 'Running command',
    detail: displayCommand,
    state: 'doing',
  });

  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, args, {
      env: getManagedNpmEnv(prefix),
      windowsHide: true,
      shell: isWin32,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.stdout?.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      stdout.push(buffer);
      emitNpmLog(onLog, {
        detail: buffer.toString('utf8').replace(/^[\r\n]+/, '').trimEnd(),
        state: 'doing',
      });
    });
    child.stderr?.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      stderr.push(buffer);
      emitNpmLog(onLog, {
        detail: buffer.toString('utf8').replace(/^[\r\n]+/, '').trimEnd(),
        state: 'doing',
      });
    });
    child.once('error', (error) => {
      emitNpmLog(onLog, {
        title: logMessages.commandFailed || 'Command failed',
        detail: `${displayCommand}\n${error.message}`,
        state: 'error',
      });
      finish(reject, decorateNpmError(error, {
        code: -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });
    child.once('close', (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) {
        finish(resolve, result);
        return;
      }
      finish(reject, decorateNpmError(new Error(
        result.stderr.trim()
        || result.stdout.trim()
        || `npm ${args[0] || 'command'} exited with ${code}`,
      ), result));
    });
  });
}

async function getLatestManagedPackageVersion({
  packageName,
  childPath,
  prefix = getManagedNpmPrefix(),
  onLog,
  logMessages,
}) {
  const { stdout } = await runManagedNpm({
    args: withConfiguredRegistry(['view', `${packageName}@latest`, 'version', '--json']),
    childPath,
    prefix,
    onLog,
    logMessages,
  });
  const text = String(stdout || '').trim();
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {
    // npm may return plain text when JSON output is unavailable.
  }
  if (Array.isArray(value)) value = value[value.length - 1];
  const version = semver.clean(String(value || '').trim());
  if (!version) throw new Error(`Unable to parse the latest ${packageName} version`);
  return version;
}

function createManagedToolLifecycle(config, hooks = {}) {
  if (!config?.toolKey || !config?.packageName || typeof config.probe !== 'function') {
    throw new TypeError('Managed tool lifecycle requires toolKey, packageName and probe');
  }

  const getPrefix = typeof config.getPrefix === 'function'
    ? config.getPrefix
    : getManagedNpmPrefix;
  let childPath = '';
  let startupPromise = null;
  let startupResult = null;
  let startupPending = false;
  let mutationTail = null;
  let pendingMutationCount = 0;
  let activeMutationCount = 0;
  let checkPromise = null;
  const mutationFlights = new Map();
  let prerequisiteBarrier = Promise.resolve();

  function getChildPath() {
    return childPath
      || config.getChildPath?.()
      || process.env.AILY_CHILD_PATH
      || '';
  }

  function getContext(options = {}) {
    return {
      childPath: getChildPath(),
      prefix: getPrefix(),
      toolKey: config.toolKey,
      packageName: config.packageName,
      options,
    };
  }

  function getEmptyState() {
    return {
      ok: false,
      path: '',
      entryPath: '',
      packageRoot: '',
      version: null,
      installed: false,
      error: '',
      ...(typeof config.emptyState === 'function' ? config.emptyState(getContext()) : {}),
    };
  }

  function normalizeState(state) {
    return { ...getEmptyState(), ...(state || {}) };
  }

  function failureState(error) {
    return normalizeState({
      ok: false,
      installed: false,
      error: error instanceof Error ? error.message : String(error || 'Managed tool operation failed'),
    });
  }

  function probe(context = getContext()) {
    try {
      return normalizeState(config.probe(context));
    } catch (error) {
      return failureState(error);
    }
  }

  function rememberReadyResult(result) {
    startupResult = normalizeState(result);
    hooks.onReadyState?.(startupResult, getContext());
    return startupResult;
  }

  function setPrerequisite(prerequisitePromise) {
    if (!prerequisitePromise) return;
    prerequisiteBarrier = Promise.resolve(prerequisitePromise).catch(() => undefined);
  }

  async function runInstallMutation(options, context) {
    if (typeof hooks.assertMutationAllowed === 'function') {
      try {
        await hooks.assertMutationAllowed(context);
      } catch (error) {
        throw markPreserveReadyState(error);
      }
    }

    if (options.onlyIfNewer === true) {
      const currentState = probe(context);
      const currentVersion = semver.clean(String(currentState.version || '').trim());
      const targetVersion = semver.clean(String(options.targetVersion || '').trim());
      if (
        currentState.ok
        && currentVersion
        && targetVersion
        && !semver.lt(currentVersion, targetVersion)
      ) {
        rememberReadyResult(currentState);
        return {
          installResult: { ...startupResult, installed: false, skipped: true },
          readyResult: startupResult,
          skipped: true,
        };
      }
    }

    await hooks.beforeMutation?.(context);
    let installResult;
    let readyResult;
    try {
      if (!context.childPath && config.requireChildPath !== false) {
        throw new Error(config.missingChildPathError || 'AILY_CHILD_PATH is not configured');
      }
      const installPackage = hooks.installPackage || installManagedPackage;
      await installPackage({
        packageSpec: typeof config.packageSpec === 'function'
          ? config.packageSpec(options)
          : `${config.packageName}@${options.targetVersion || 'latest'}`,
        childPath: context.childPath,
        prefix: context.prefix,
        force: options.force === true,
        onLog: hooks.onNpmLog,
        logMessages: config.npmLogMessages,
      }, context);
      await hooks.afterInstall?.(context);
      readyResult = probe(context);
      installResult = readyResult.ok
        ? { ...readyResult, installed: true, error: '' }
        : {
          ...readyResult,
          installed: false,
          error: readyResult.error || config.installIncompleteError
            || `${config.packageName} installation is incomplete`,
        };
    } catch (error) {
      installResult = failureState(error);
      readyResult = probe(context);
    }

    const effectiveReadyResult = readyResult.ok
      ? { ...readyResult, installed: !!installResult.installed }
      : {
        ...readyResult,
        installed: false,
        error: installResult.error || readyResult.error,
      };
    rememberReadyResult(effectiveReadyResult);
    const mutationResult = { installResult, readyResult: startupResult };
    await hooks.afterMutation?.(mutationResult, context);
    return mutationResult;
  }

  function performInstallMutation(options = {}) {
    const context = getContext(options);
    if (typeof hooks.preflightMutation === 'function') {
      try {
        hooks.preflightMutation(context);
      } catch (error) {
        throw markPreserveReadyState(error);
      }
    }
    const signature = mutationSignature(context);
    const existingMutation = mutationFlights.get(signature);
    if (existingMutation) return existingMutation;

    pendingMutationCount++;
    const operation = prerequisiteBarrier.then(() => (
      queueManagedNpmMutation(context.prefix, async () => {
        activeMutationCount++;
        try {
          return await runInstallMutation(options, context);
        } finally {
          activeMutationCount--;
        }
      })
    ));
    let trackedOperation;
    trackedOperation = operation.finally(() => {
      pendingMutationCount--;
      if (mutationFlights.get(signature) === trackedOperation) {
        mutationFlights.delete(signature);
      }
      if (mutationTail === trackedOperation) mutationTail = null;
    });
    mutationFlights.set(signature, trackedOperation);
    mutationTail = trackedOperation;
    return trackedOperation;
  }

  function initialize(nextChildPath, prerequisitePromise, options = {}) {
    if (startupPromise) return startupPromise;
    childPath = nextChildPath || childPath;
    setPrerequisite(prerequisitePromise);
    const installLatest = options.installLatest === true;
    let initialState = null;
    startupPending = true;
    const initialization = (async () => {
      await prerequisiteBarrier;
      await hooks.prepareEnvironment?.(getContext(options));
      initialState = probe();
      if (!installLatest) return rememberReadyResult(initialState);

      const { installResult, readyResult } = await performInstallMutation({
        force: true,
        reason: 'startup',
        targetVersion: 'latest',
      });
      return rememberReadyResult({
        ...readyResult,
        startupInstallAttempted: true,
        startupInstallSucceeded: !!installResult.ok && !!installResult.installed && !!readyResult.ok,
        startupInstallError: installResult.ok ? '' : (installResult.error || readyResult.error),
      });
    })().catch((error) => {
      const state = error?.managedToolPreserveReadyState && initialState?.ok
        ? initialState
        : failureState(error);
      return rememberReadyResult({
        ...state,
        startupInstallAttempted: installLatest,
        startupInstallSucceeded: false,
        startupInstallError: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      startupPending = false;
    });
    if (config.reinitializeAfterSettle === true) {
      let trackedInitialization;
      trackedInitialization = initialization.finally(() => {
        if (startupPromise === trackedInitialization) startupPromise = null;
      });
      startupPromise = trackedInitialization;
    } else {
      startupPromise = initialization;
    }
    return startupPromise;
  }

  function canReuseReadyState(state) {
    if (!state?.ok) return false;
    const validator = hooks.canReuseReadyState || hooks.isReadyStateCurrent;
    return typeof validator === 'function'
      ? validator(state, getContext())
      : true;
  }

  function isStatusStateValid(state) {
    if (!state?.ok) return true;
    const validator = hooks.isStatusStateValid || hooks.isReadyStateCurrent;
    return typeof validator === 'function'
      ? validator(state, getContext())
      : true;
  }

  async function waitForReady() {
    let initializedResult = startupResult;
    if (startupPromise) initializedResult = await startupPromise;
    while (mutationTail) {
      const pendingMutation = mutationTail;
      try {
        const result = await pendingMutation;
        initializedResult = result.readyResult;
      } catch (error) {
        if (!error?.managedToolPreserveReadyState) {
          initializedResult = rememberReadyResult(failureState(error));
        }
      }
      if (mutationTail === pendingMutation) break;
    }

    const lastKnownResult = startupResult || initializedResult;
    if (lastKnownResult && canReuseReadyState(lastKnownResult)) {
      return lastKnownResult;
    }
    await hooks.prepareEnvironment?.(getContext());
    const probedState = probe();
    if (probedState.ok) return rememberReadyResult(probedState);
    return rememberReadyResult({
      ...probedState,
      error: config.preservePreviousProbeError !== false
        && lastKnownResult && !lastKnownResult.ok && lastKnownResult.error
        ? lastKnownResult.error
        : probedState.error,
    });
  }

  function getEffectiveStatusState() {
    const state = startupResult || getEmptyState();
    if (!state.ok || isStatusStateValid(state)) return state;
    return normalizeState({
      ...state,
      ok: false,
      version: null,
      installed: false,
      error: config.missingReadyError || state.error || `${config.toolKey} is unavailable`,
    });
  }

  function getStatus() {
    const state = getEffectiveStatusState();
    return {
      key: config.toolKey,
      packageName: config.packageName,
      installed: !!state.ok,
      installedVersion: state.version,
      installing: pendingMutationCount > 0 || startupPending,
      installingKey: activeMutationCount > 0 ? config.toolKey : null,
      configLoaded: true,
      error: state.ok ? '' : state.error,
      ...(typeof config.statusFields === 'function' ? config.statusFields(state) : {}),
    };
  }

  async function runCheckForUpdate() {
    if (mutationTail) await mutationTail;
    const context = getContext({ reason: 'check-update' });
    if (!context.childPath && config.requireChildPath !== false) {
      throw new Error(config.missingChildPathError || 'AILY_CHILD_PATH is not configured');
    }
    const currentState = probe(context);
    const currentVersion = semver.clean(String(currentState.version || '').trim());
    const latestVersion = await (hooks.getLatestVersion || getLatestManagedPackageVersion)({
      packageName: config.packageName,
      childPath: context.childPath,
      prefix: context.prefix,
      onLog: hooks.onNpmLog,
      logMessages: config.npmLogMessages,
    }, context);

    if (currentState.ok && currentVersion && !semver.gt(latestVersion, currentVersion)) {
      rememberReadyResult(currentState);
      return {
        updated: false,
        previousVersion: currentVersion,
        version: currentVersion,
        latestVersion,
        status: getStatus(),
      };
    }

    const { installResult, readyResult } = await performInstallMutation({
      onlyIfNewer: true,
      reason: 'check-update',
      targetVersion: latestVersion,
    });
    if (!installResult.ok || !readyResult.ok) {
      throw new Error(installResult.error || readyResult.error
        || config.installError || `${config.packageName} npm installation failed`);
    }
    return {
      updated: !installResult.skipped,
      previousVersion: currentVersion,
      version: readyResult.version,
      latestVersion,
      status: getStatus(),
    };
  }

  function checkForUpdate() {
    if (checkPromise) return checkPromise;
    let trackedCheck;
    trackedCheck = runCheckForUpdate().finally(() => {
      if (checkPromise === trackedCheck) checkPromise = null;
    });
    checkPromise = trackedCheck;
    return trackedCheck;
  }

  return {
    checkForUpdate,
    getStatus,
    initialize,
    performInstallMutation,
    probe,
    setPrerequisite,
    waitForReady,
  };
}

function queueManagedNpmMutation(prefix, task) {
  const key = normalizePrefixKey(prefix);
  const previous = prefixMutationTails.get(key);
  const operation = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(task);
  let trackedOperation;
  trackedOperation = operation.finally(() => {
    if (prefixMutationTails.get(key) === trackedOperation) {
      prefixMutationTails.delete(key);
    }
  });
  prefixMutationTails.set(key, trackedOperation);
  return trackedOperation;
}

function mutationSignature(context) {
  return JSON.stringify([
    normalizePrefixKey(context.prefix),
    context.packageName,
    context.options.targetVersion || 'latest',
    context.options.force === true,
  ]);
}

function markPreserveReadyState(error) {
  const result = error instanceof Error
    ? error
    : new Error(String(error || 'Managed tool mutation was rejected'));
  result.managedToolPreserveReadyState = true;
  return result;
}

function normalizePrefixKey(prefix) {
  if (!prefix) return '<unconfigured-prefix>';
  const resolved = path.resolve(prefix);
  return isWin32 ? resolved.toLowerCase() : resolved;
}

function quoteWindowsShellPath(filePath) {
  return `"${String(filePath).replace(/"/g, '""')}"`;
}

function emitNpmLog(onLog, log) {
  if (typeof onLog === 'function' && (log.title || log.detail)) onLog(log);
}

function decorateNpmError(error, result) {
  error.code = result.code;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  return error;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = {
  applyManagedCommandEnv,
  createManagedToolLifecycle,
  getChildNodeExecutable,
  getChildNpmExecutable,
  getLatestManagedPackageVersion,
  getManagedNpmEnv,
  getManagedNpmPrefix,
  installManagedPackage,
  managedBinCandidates,
  packageRootCandidates,
  parseManagedCliVersion,
  probeManagedCli,
  probeManagedCommand,
  resolveLocalPackage,
  resolveManagedBinPath,
  resolveManagedPackage,
  runManagedNpm,
  withConfiguredRegistry,
};
