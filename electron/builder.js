// 管理 aily-builder 工具链的安装、环境配置和构建任务调用。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ipcMain } = require("electron");
const semver = require("semver");

const { isWin32 } = require("./platform");

const AILY_BUILDER_KEY = "aily-builder";
const PACKAGE_NAME = "@aily-project/aily-builder";

let installPromise = null;
let mutationPromise = null;
let startupPromise = null;
let startupResult = null;
let getMainWindow = () => null;
let handlersRegistered = false;

function getConfiguredPrefix() {
  if (process.env.AILY_NPM_PREFIX) {
    return process.env.AILY_NPM_PREFIX;
  }
  return process.env.AILY_APPDATA_PATH
    ? path.join(process.env.AILY_APPDATA_PATH, "npm-global")
    : "";
}

function getNpmEnv() {
  const env = { ...process.env };
  const npmPrefix = getConfiguredPrefix();
  if (npmPrefix) {
    env.npm_config_prefix = npmPrefix;
  }
  return env;
}

function configureCacheEnvironment() {
  // Builder data/cache root; npm installation is managed separately by AILY_NPM_PREFIX.
  if (process.platform === "win32") {
    process.env.AILY_BUILDER_PATH = path.join(os.homedir(), "AppData", "Local", "aily-builder");
  } else if (process.platform === "darwin") {
    process.env.AILY_BUILDER_PATH = path.join(os.homedir(), "Library", "Caches", "aily-builder");
  } else {
    process.env.AILY_BUILDER_PATH = path.join(os.homedir(), ".cache", "aily-builder");
  }
}

function getNpmExecutable(childPath) {
  if (isWin32) {
    const npmCmdPath = path.join(childPath, "node", "npm.cmd");
    return fs.existsSync(npmCmdPath) ? npmCmdPath : "npm";
  }

  const npmPath = path.join(childPath, "node", "bin", "npm");
  return fs.existsSync(npmPath) ? npmPath : "npm";
}

function quoteWindowsShellPath(filePath) {
  return `"${String(filePath).replace(/"/g, '""')}"`;
}

function getAilyBuilderCommandPath() {
  const prefix = getConfiguredPrefix();
  if (!prefix) {
    return "";
  }

  const candidates = isWin32
    ? [
      path.join(prefix, "aily-builder.cmd"),
      path.join(prefix, "aily-builder.exe"),
      path.join(prefix, "aily-builder"),
    ]
    : [path.join(prefix, "bin", "aily-builder")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function parseBuilderVersion(output) {
  const text = String(output || "").trim();
  if (!text) {
    return null;
  }
  const versionMatch = text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
  return versionMatch ? versionMatch[0] : text.split(/\r?\n/)[0].trim();
}

function probeAilyBuilderCommand() {
  const commandPath = getAilyBuilderCommandPath();
  if (!commandPath) {
    return {
      ok: false,
      path: "",
      version: null,
      installed: false,
      error: "aily-builder 命令不存在",
    };
  }

  const command = isWin32 ? quoteWindowsShellPath(commandPath) : commandPath;
  const result = spawnSync(command, ["--version"], {
    env: getNpmEnv(),
    shell: isWin32,
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    return {
      ok: false,
      path: commandPath,
      version: null,
      installed: false,
      error: result.error?.message || output || `aily-builder --version exited with ${result.status}`,
    };
  }

  return {
    ok: true,
    path: commandPath,
    version: parseBuilderVersion(output),
    installed: false,
    error: "",
  };
}

function readNpmGlobalValue(childPath, args) {
  const npmPath = getNpmExecutable(childPath);
  const npmCommand = isWin32 ? quoteWindowsShellPath(npmPath) : npmPath;
  const result = spawnSync(npmCommand, args, {
    env: getNpmEnv(),
    shell: isWin32,
    windowsHide: true,
    encoding: "utf8",
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function getInstalledPackageState(childPath) {
  const npmRoot = readNpmGlobalValue(childPath, ["root", "-g"]);
  const packagePath = npmRoot
    ? path.join(npmRoot, ...PACKAGE_NAME.split("/"))
    : "";
  let version = null;
  let complete = false;

  try {
    const packageJsonPath = path.join(packagePath, "package.json");
    if (packagePath && fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      version = packageJson.version || null;
      const binEntry = typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.[AILY_BUILDER_KEY];
      const entryPath = binEntry || packageJson.main;
      complete = !!entryPath && fs.existsSync(path.join(packagePath, entryPath));
    }
  } catch (_) {
    version = null;
    complete = false;
  }

  return {
    packageName: PACKAGE_NAME,
    path: packagePath,
    version,
    complete,
  };
}

function getAilyBuilderReadyState(childPath) {
  const commandState = probeAilyBuilderCommand();
  const packageState = getInstalledPackageState(childPath);
  if (commandState.ok && packageState.complete) {
    return commandState;
  }

  return {
    ...commandState,
    ok: false,
    installed: false,
    error: commandState.ok
      ? `${PACKAGE_NAME} 未安装完整`
      : commandState.error,
  };
}

function applyCommandEnv(childPath) {
  const prefix = readNpmGlobalValue(childPath, ["prefix", "-g"]);
  if (!prefix) {
    return;
  }

  const binPath = isWin32 ? prefix : path.join(prefix, "bin");
  const currentPath = process.env.PATH || "";
  const pathParts = currentPath.split(path.delimiter).filter(Boolean);
  if (!pathParts.includes(binPath)) {
    process.env.PATH = `${binPath}${path.delimiter}${currentPath}`;
  }
}

function sendNpmLog(log) {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("window-receive", {
    data: {
      action: "log",
      log,
    },
  });
}

function runNpm(childPath, npmArgs) {
  const npmPath = getNpmExecutable(childPath);
  const npmCommand = isWin32 ? quoteWindowsShellPath(npmPath) : npmPath;
  const displayCommand = `npm ${npmArgs.join(" ")}`;
  sendNpmLog({ title: "执行命令", detail: displayCommand, state: "doing" });

  return new Promise((resolve) => {
    const child = spawn(npmCommand, npmArgs, {
      env: getNpmEnv(),
      shell: isWin32,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let spawnFailed = false;

    child.stdout?.on("data", (chunk) => {
      const output = chunk.toString();
      stdout += output;
      sendNpmLog({ detail: output.replace(/^[\r\n]+/, "").trimEnd(), state: "doing" });
    });
    child.stderr?.on("data", (chunk) => {
      const output = chunk.toString();
      stderr += output;
      sendNpmLog({ detail: output.replace(/^[\r\n]+/, "").trimEnd(), state: "doing" });
    });
    child.on("error", (error) => {
      spawnFailed = true;
      sendNpmLog({
        title: "命令执行失败",
        detail: `${displayCommand}\n${error.message}`,
        state: "error",
      });
      resolve({ code: -1, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      if (!spawnFailed) {
        resolve({ code, stdout, stderr, error: "" });
      }
    });
  });
}

function withConfiguredRegistry(npmArgs) {
  const args = [...npmArgs];
  if (process.env.AILY_NPM_REGISTRY) {
    args.push("--registry", process.env.AILY_NPM_REGISTRY);
  }
  return args;
}

function parseNpmViewVersion(output) {
  const text = String(output || "").trim();
  let value = text;
  try {
    value = JSON.parse(text);
  } catch (_) {
    // npm may return plain text when JSON output is unavailable.
  }
  if (Array.isArray(value)) {
    value = value[value.length - 1];
  }
  const version = semver.clean(String(value || "").trim());
  if (!version) {
    throw new Error(`无法解析 ${PACKAGE_NAME} 的最新版本`);
  }
  return version;
}

async function getLatestVersion(childPath) {
  const npmArgs = withConfiguredRegistry(["view", `${PACKAGE_NAME}@latest`, "version", "--json"]);
  const { code, stdout, stderr, error } = await runNpm(childPath, npmArgs);
  if (code !== 0) {
    throw new Error(error || stderr || stdout || `npm view exited with ${code}`);
  }
  return parseNpmViewVersion(stdout);
}

function installFromNpm(childPath, options = {}) {
  let packageState = getInstalledPackageState(childPath);
  if (!options.force && !options.targetVersion && packageState.version && packageState.complete) {
    return Promise.resolve({
      ok: true,
      path: packageState.path,
      version: packageState.version,
      installed: false,
    });
  }

  if (installPromise) {
    return installPromise;
  }

  const installTarget = `${PACKAGE_NAME}@${options.targetVersion || "latest"}`;
  const npmArgs = ["i", installTarget, "-g"];
  if (options.force) {
    npmArgs.push("--force");
  }

  installPromise = runNpm(childPath, withConfiguredRegistry(npmArgs))
    .then(({ code, stdout, stderr, error }) => {
      if (code !== 0) {
        return {
          ok: false,
          path: packageState.path,
          error: error || stderr || stdout || `npm install exited with ${code}`,
        };
      }

      packageState = getInstalledPackageState(childPath);
      return {
        ok: packageState.complete,
        path: packageState.path,
        version: packageState.version,
        installed: packageState.complete,
        error: packageState.complete ? "" : `${PACKAGE_NAME} 安装完成但缺少 CLI 入口`,
      };
    })
    .finally(() => {
      installPromise = null;
    });

  return installPromise;
}

async function installAilyBuilder(childPath, options = {}) {
  const packageState = getInstalledPackageState(childPath);
  const force = !!options.force;
  const result = packageState.complete && packageState.version && !force && !options.targetVersion
    ? {
      ok: true,
      path: packageState.path,
      version: packageState.version,
      installed: false,
    }
    : await installFromNpm(childPath, { ...options, force });

  if (result.ok) {
    applyCommandEnv(childPath);
  }
  return result;
}

function rememberReadyResult(result) {
  startupResult = result;
  return result;
}

function queueMutation(task) {
  const previousMutation = mutationPromise;
  const operation = (previousMutation
    ? previousMutation.catch(() => undefined)
    : Promise.resolve())
    .then(task);
  const trackedOperation = operation.finally(() => {
    if (mutationPromise === trackedOperation) {
      mutationPromise = null;
    }
  });
  mutationPromise = trackedOperation;
  return trackedOperation;
}

function performInstallMutation(childPath, options) {
  return queueMutation(async () => {
    let installResult;
    try {
      installResult = await installAilyBuilder(childPath, options);
    } catch (error) {
      installResult = {
        ok: false,
        path: "",
        version: null,
        installed: false,
        error: error?.message || String(error),
      };
    }

    const commandState = getAilyBuilderReadyState(childPath);
    const readyResult = commandState.ok
      ? { ...commandState, installed: !!installResult.installed }
      : {
        ...commandState,
        error: installResult.error || commandState.error,
      };
    rememberReadyResult(readyResult);
    return { installResult, readyResult };
  });
}

function initialize(childPath, options = {}) {
  if (startupPromise) {
    return startupPromise;
  }

  const installLatest = !!options.installLatest;
  startupPromise = (async () => {
    const commandState = getAilyBuilderReadyState(childPath);
    if (!installLatest) {
      return rememberReadyResult(commandState);
    }

    const { installResult, readyResult } = await performInstallMutation(childPath, {
      force: true,
      reason: "startup",
      targetVersion: "latest",
    });
    return rememberReadyResult({
      ...readyResult,
      startupInstallAttempted: true,
      startupInstallSucceeded: !!installResult.ok && !!installResult.installed && !!readyResult.ok,
      startupInstallError: installResult.ok ? "" : (installResult.error || readyResult.error),
    });
  })().catch((error) => rememberReadyResult({
    ok: false,
    path: "",
    version: null,
    installed: false,
    error: error?.message || String(error),
    startupInstallAttempted: installLatest,
    startupInstallSucceeded: false,
    startupInstallError: error?.message || String(error),
  }));

  return startupPromise;
}

async function waitForReady() {
  const childPath = requireChildPath();
  let initializedResult = startupResult;
  if (startupPromise) {
    try {
      initializedResult = await startupPromise;
    } catch (error) {
      initializedResult = rememberReadyResult({
        ok: false,
        path: "",
        version: null,
        installed: false,
        error: error?.message || String(error),
      });
    }
  }

  while (mutationPromise) {
    const pendingMutation = mutationPromise;
    try {
      const mutationResult = await pendingMutation;
      initializedResult = mutationResult.readyResult;
    } catch (error) {
      initializedResult = rememberReadyResult({
        ok: false,
        path: "",
        version: null,
        installed: false,
        error: error?.message || String(error),
      });
    }
    if (mutationPromise === pendingMutation) {
      break;
    }
  }

  // Initialization and every managed install/update already perform a full
  // readiness probe and store the result. The preprocess hot path calls this
  // method frequently, so avoid blocking Electron's main thread with another
  // `npm root -g` and `aily-builder --version` spawnSync pair. Keep a cheap
  // command-path check so an external add/remove still invalidates the cache.
  const lastKnownResult = startupResult || initializedResult;
  if (lastKnownResult && getAilyBuilderCommandPath() === lastKnownResult.path) {
    return lastKnownResult;
  }

  const commandState = getAilyBuilderReadyState(childPath);
  if (commandState.ok) {
    startupPromise = Promise.resolve(rememberReadyResult(commandState));
    return commandState;
  }

  const failureResult = rememberReadyResult({
    ...commandState,
    error: lastKnownResult && !lastKnownResult.ok && lastKnownResult.error
      ? lastKnownResult.error
      : commandState.error,
  });
  startupPromise = Promise.resolve(failureResult);
  return failureResult;
}

function getStatus() {
  const commandState = getAilyBuilderReadyState(requireChildPath());
  return {
    key: AILY_BUILDER_KEY,
    packageName: PACKAGE_NAME,
    installed: commandState.ok,
    installedVersion: commandState.version,
    installing: !!mutationPromise || (!!startupPromise && !startupResult),
    installingKey: installPromise ? AILY_BUILDER_KEY : null,
    configLoaded: true,
    error: commandState.ok ? "" : (startupResult?.error || commandState.error),
  };
}

async function checkForUpdate(childPath) {
  const currentState = getAilyBuilderReadyState(childPath);
  const currentVersion = semver.clean(String(currentState.version || "").trim());
  const latestVersion = await getLatestVersion(childPath);

  if (currentState.ok && currentVersion && !semver.gt(latestVersion, currentVersion)) {
    return {
      updated: false,
      previousVersion: currentVersion,
      version: currentVersion,
      latestVersion,
      status: getStatus(),
    };
  }

  const { installResult, readyResult } = await performInstallMutation(childPath, {
    reason: "check-update",
    targetVersion: latestVersion,
  });
  const result = installResult.ok ? readyResult : installResult;
  if (!result.ok) {
    throw new Error(result.error || `${PACKAGE_NAME} npm 安装失败`);
  }

  return {
    updated: true,
    previousVersion: currentVersion,
    version: result.version,
    latestVersion,
    status: getStatus(),
  };
}

function requireChildPath() {
  const childPath = process.env.AILY_CHILD_PATH;
  if (!childPath) {
    throw new Error("AILY_CHILD_PATH 未设置");
  }
  return childPath;
}

function registerHandlers(mainWindowProvider) {
  getMainWindow = typeof mainWindowProvider === "function"
    ? mainWindowProvider
    : () => mainWindowProvider;
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  ipcMain.handle("aily-builder-status", async () => getStatus());
  ipcMain.handle("aily-builder-check-update", async () => checkForUpdate(requireChildPath()));
  ipcMain.handle("aily-builder-wait-ready", async () => {
    const result = await waitForReady();
    if (!result.ok) {
      throw new Error(result.error || "aily-builder 未安装或启动初始化失败");
    }
    return { version: result.version };
  });
  ipcMain.handle("aily-builder-update", async () => {
    const childPath = requireChildPath();
    const { installResult, readyResult } = await performInstallMutation(childPath, {
      reason: "manual",
      force: true,
    });
    const result = installResult.ok ? readyResult : installResult;
    if (!result.ok) {
      throw new Error(result.error || "aily-builder npm 安装失败");
    }
    return { version: result.version, status: getStatus() };
  });
}

module.exports = {
  applyCommandEnv,
  configureCacheEnvironment,
  initialize,
  registerHandlers,
  waitForReady,
};
