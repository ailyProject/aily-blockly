const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DEV_SERVER_HOST = 'localhost';
const DEV_SERVER_PORT = 4200;
const DEV_SERVER_START_TIMEOUT_MS = 120000;

function isPortOpen(port, host = DEV_SERVER_HOST, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForPort(port, host, timeoutMs, shouldAbort = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) {
      throw new Error('Angular development server exited before port 4200 became ready.');
    }
    if (await isPortOpen(port, host)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Angular development server on ${host}:${port}.`);
}

function spawnInherited(command, args, workspaceRoot) {
  return spawn(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    // Windows command scripts must be launched through cmd.exe.
    shell: process.platform === 'win32' && command === 'npm.cmd',
  });
}

function stopChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGINT');
  }
}

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const existingDevServer = await isPortOpen(DEV_SERVER_PORT);
  let angularChild = null;
  let electronChild = null;
  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(electronChild);
    stopChild(angularChild);
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));

  if (existingDevServer) {
    console.log(`[electron:coder] reusing Angular development server on port ${DEV_SERVER_PORT}`);
  } else {
    console.log(`[electron:coder] starting Angular development server on port ${DEV_SERVER_PORT}`);
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    angularChild = spawnInherited(npmCommand, ['start'], workspaceRoot);
  }

  try {
    await waitForPort(
      DEV_SERVER_PORT,
      DEV_SERVER_HOST,
      DEV_SERVER_START_TIMEOUT_MS,
      () => Boolean(angularChild && angularChild.exitCode !== null),
    );
  } catch (error) {
    shutdown(1);
    throw error;
  }

  electronChild = spawnInherited(process.execPath, [
    path.join(workspaceRoot, 'scripts', 'run-electron-dev.js'),
    '--serve',
    '--coder',
  ], workspaceRoot);

  electronChild.once('exit', (code, signal) => {
    if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
      console.error(`[electron:coder] Electron exited with signal ${signal}`);
    }
    shutdown(code || 0);
  });

  if (angularChild) {
    angularChild.once('exit', (code, signal) => {
      if (shuttingDown) return;
      console.error(
        `[electron:coder] Angular development server exited (${signal || code || 0})`,
      );
      shutdown(code || 1);
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[electron:coder] ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEV_SERVER_HOST,
  DEV_SERVER_PORT,
  isPortOpen,
  waitForPort,
};
