// Manage the standalone aily-linter installation and readiness lifecycle.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ipcMain } = require("electron");
const semver = require("semver");

const { isWin32 } = require("./platform");

const TOOL_KEY = "aily-linter";
const PACKAGE_NAME = "@aily-project/aily-linter";

let installPromise = null;
let mutationPromise = null;
let startupPromise = null;
let startupResult = null;
let prerequisiteBarrier = Promise.resolve();
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

function getAilyLinterCommandPath() {
  const prefix = getConfiguredPrefix();
  if (!prefix) {
    return "";
  }

  const candidates = isWin32
    ? [
      path.join(prefix, "aily-linter.cmd"),
      path.join(prefix, "aily-linter.exe"),
      path.join(prefix, "aily-linter"),
    ]
    : [path.join(prefix, "bin", "aily-linter")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function getAilyLinterEntryPath() {
  const prefix = getConfiguredPrefix();
  if (!prefix) {
    return "";
  }

  const packageParts = PACKAGE_NAME.split("/");
  const packagePaths = isWin32
    ? [path.join(prefix, "node_modules", ...packageParts)]
    : [
      path.join(prefix, "lib", "node_modules", ...packageParts),
      path.join(prefix, "node_modules", ...packageParts),
    ];

  for (const packagePath of packagePaths) {
    try {
      const packageJsonPath = path.join(packagePath, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const binPath = typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.[TOOL_KEY];
      const entryPath = binPath ? path.resolve(packagePath, binPath) : "";
      if (entryPath && fs.existsSync(entryPath)) {
        return entryPath;
      }
    } catch (_) {
      // Keep checking fallback package roots.
    }
  }

  return "";
}

function parseVersion(output) {
  const text = String(output || "").trim();
  if (!text) {
    return null;
  }

  const versionMatch = text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
  return versionMatch ? versionMatch[0] : text.split(/\r?\n/)[0].trim();
}

function probeAilyLinterCommand() {
  const commandPath = getAilyLinterCommandPath();
  const entryPath = getAilyLinterEntryPath();
  if (!commandPath) {
    return {
      ok: false,
      path: "",
      entryPath,
      version: null,
      installed: false,
      error: "aily-linter command was not found in the configured npm prefix",
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
      entryPath,
      version: null,
      installed: false,
      error: result.error?.message || output || `aily-linter --version exited with ${result.status}`,
    };
  }
  if (!entryPath) {
    return {
      ok: false,
      path: commandPath,
      entryPath: "",
      version: parseVersion(output),
      installed: false,
      error: `${PACKAGE_NAME} is installed but its CLI entry file is missing`,
    };
  }

  return {
    ok: true,
    path: commandPath,
    entryPath,
    version: parseVersion(output),
    installed: false,
    error: "",
  };
}

function applyCommandEnv() {
  const prefix = getConfiguredPrefix();
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
  sendNpmLog({ title: "Running command", detail: displayCommand, state: "doing" });

  return new Promise((resolve) => {
    const child = spawn(npmCommand, npmArgs, {
      env: getNpmEnv(),
      shell: isWin32,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

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
      sendNpmLog({
        title: "Command failed",
        detail: `${displayCommand}\n${error.message}`,
        state: "error",
      });
      finish({ code: -1, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, error: "" });
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
    throw new Error(`Unable to parse the latest ${PACKAGE_NAME} version`);
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
          path: "",
          version: null,
          installed: false,
          error: error || stderr || stdout || `npm install exited with ${code}`,
        };
      }

      applyCommandEnv();
      const commandState = probeAilyLinterCommand();
      return commandState.ok
        ? { ...commandState, installed: true }
        : {
          ...commandState,
          error: commandState.error || `${PACKAGE_NAME} installed but the aily-linter command is unavailable`,
        };
    })
    .finally(() => {
      installPromise = null;
    });

  return installPromise;
}

function rememberReadyResult(result) {
  startupResult = result;
  return result;
}

function setPrerequisite(prerequisitePromise) {
  if (!prerequisitePromise) {
    return;
  }

  prerequisiteBarrier = Promise.resolve(prerequisitePromise).catch(() => undefined);
}

function queueMutation(task) {
  const previousMutation = mutationPromise;
  const operation = (previousMutation
    ? previousMutation.catch(() => undefined)
    : prerequisiteBarrier)
    .then(task);
  const trackedOperation = operation.finally(() => {
    if (mutationPromise === trackedOperation) {
      mutationPromise = null;
    }
  });
  mutationPromise = trackedOperation;
  return trackedOperation;
}

function performInstallMutation(childPath, options = {}) {
  return queueMutation(async () => {
    let installResult;
    try {
      installResult = await installFromNpm(childPath, options);
    } catch (error) {
      installResult = {
        ok: false,
        path: "",
        version: null,
        installed: false,
        error: error?.message || String(error),
      };
    }

    const commandState = probeAilyLinterCommand();
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

function initialize(childPath, prerequisitePromise, options = {}) {
  if (startupPromise) {
    return startupPromise;
  }

  const installLatest = !!options.installLatest;
  setPrerequisite(prerequisitePromise);
  startupPromise = (async () => {
    applyCommandEnv();
    let commandState = probeAilyLinterCommand();
    if (!installLatest) {
      return rememberReadyResult(commandState);
    }

    // Wait for the builder startup/install mutation before touching the shared
    // global npm prefix. A failed prerequisite must not block linter startup.
    await prerequisiteBarrier;

    commandState = probeAilyLinterCommand();
    const { installResult, readyResult } = await performInstallMutation(childPath, {
      force: installLatest,
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

  const commandState = probeAilyLinterCommand();
  if (commandState.ok) {
    startupPromise = Promise.resolve(rememberReadyResult(commandState));
    return commandState;
  }

  const lastKnownResult = startupResult || initializedResult;
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
  const commandState = startupResult || {
    ok: false,
    path: getAilyLinterCommandPath(),
    entryPath: "",
    version: null,
    installed: false,
    error: "",
  };
  const commandStillExists = !commandState.ok || (
    !!commandState.path && fs.existsSync(commandState.path) &&
    !!commandState.entryPath && fs.existsSync(commandState.entryPath)
  );
  const effectiveState = commandStillExists
    ? commandState
    : {
      ...commandState,
      ok: false,
      version: null,
      error: "aily-linter command or entry file is missing",
    };
  return {
    key: TOOL_KEY,
    packageName: PACKAGE_NAME,
    installed: effectiveState.ok,
    installedVersion: effectiveState.version,
    path: effectiveState.path,
    entryPath: effectiveState.entryPath,
    installing: !!mutationPromise || (!!startupPromise && !startupResult),
    installingKey: installPromise ? TOOL_KEY : null,
    configLoaded: true,
    error: effectiveState.ok ? "" : effectiveState.error,
  };
}

async function checkForUpdate(childPath) {
  const currentState = probeAilyLinterCommand();
  const currentVersion = semver.clean(String(currentState.version || "").trim());
  const latestVersion = await getLatestVersion(childPath);

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

  const { installResult, readyResult } = await performInstallMutation(childPath, {
    reason: "check-update",
    targetVersion: latestVersion,
  });
  const result = installResult.ok ? readyResult : installResult;
  if (!result.ok) {
    throw new Error(result.error || `${PACKAGE_NAME} npm installation failed`);
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
    throw new Error("AILY_CHILD_PATH is not configured");
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

  ipcMain.handle("aily-linter-status", async () => getStatus());
  ipcMain.handle("aily-linter-check-update", async () => checkForUpdate(requireChildPath()));
  ipcMain.handle("aily-linter-wait-ready", async () => {
    const result = await waitForReady();
    if (!result.ok) {
      throw new Error(result.error || "aily-linter is not installed or failed to initialize");
    }
    return { version: result.version, path: result.path, entryPath: result.entryPath };
  });
  ipcMain.handle("aily-linter-update", async () => {
    const childPath = requireChildPath();
    const { installResult, readyResult } = await performInstallMutation(childPath, {
      force: true,
      reason: "manual",
    });
    const result = installResult.ok ? readyResult : installResult;
    if (!result.ok) {
      throw new Error(result.error || "aily-linter npm installation failed");
    }
    return { version: result.version, status: getStatus() };
  });
}

module.exports = {
  initialize,
  registerHandlers,
  waitForReady,
};
