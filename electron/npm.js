// 管理 npm 命令进程，并将执行状态和日志回传给渲染进程。
const { ipcMain } = require("electron");
const { spawn } = require('child_process');
const { killRegisteredProcessTree } = require('./process-tree');
const { assertProjectTaskActive, matchesProjectTask } = require('./project-task-scope');

const activeNpmProcesses = new Map();
let npmShutdown = false;

function ensureForegroundScripts(cmd) {
    if (!/^npm(\.cmd)?\s+(install|i)\b/i.test(cmd)) {
        return cmd;
    }

    if (/\s--foreground-scripts(=\S+)?\b/i.test(cmd)) {
        return cmd;
    }

    return `${cmd} --foreground-scripts`;
}

function shouldLogStreamingOutput(cmd) {
    return /^npm(\.cmd)?\s+(install|i)\b/i.test(cmd);
}

function sendRendererLog(mainWindow, detail, state = 'doing', mergeKey) {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return;
    }

    const log = {
        detail,
        state
    };

    if (mergeKey) {
        log.mergeKey = mergeKey;
    }

    mainWindow.webContents.send('window-receive', {
        data: {
            action: 'log',
            log
        }
    });
}

function isNoisyNpmLogLine(line) {
    return /^(npm http|npm verbose|npm info ok\b)/i.test(line)
        || /^>\s+@?[^\s@]+(?:\/[^\s@]+)?@[^\s]+\s+postinstall\b/i.test(line)
        || /^>\s+node\s+\.\/postinstall\.js\b/i.test(line)
        || /^(added|changed|removed|updated|audited)\s+\d+\s+packages?\s+in\s+/i.test(line)
        || /^up to date\s+in\s+/i.test(line);
}

function isNpmErrorMetadataLine(line) {
    return /^npm error\b/i.test(line);
}

function isBusyRenameError(text) {
    return /\bEBUSY\b/i.test(text) && /\brename\b/i.test(text);
}

function extractNpmErrorValue(text, key) {
    const match = text.match(new RegExp(`^npm error ${key}\\s+(.+)$`, 'im'));

    return match ? match[1].trim() : '';
}

function extractBusyRenameDetails(stderr) {
    return {
        path: extractNpmErrorValue(stderr, 'path'),
        dest: extractNpmErrorValue(stderr, 'dest')
    };
}

function formatNpmError(stderr, code) {
    if (isBusyRenameError(stderr)) {
        const targetPath = extractNpmErrorValue(stderr, 'path');
        const detail = targetPath ? `\n被占用目录: ${targetPath}` : '';

        return `npm 安装失败：目标目录正在被占用，无法替换安装包。请关闭正在使用该工具链的编译/烧录/终端任务，稍后重试。${detail}`;
    }

    return stderr || `命令退出码 ${code}`;
}

function createNpmError(stderr, code) {
    const error = new Error(formatNpmError(stderr, code));

    error.isBusyRename = isBusyRenameError(stderr);
    error.busyRenameDetails = extractBusyRenameDetails(stderr);

    return error;
}

function waitForRetry(ms, signal) {
    return new Promise(resolve => {
        if (signal.aborted) return resolve();
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal.addEventListener('abort', finish, { once: true });
    });
}

function getProgressMergeKey(sourceId, line) {
    if (/^下载进度[:：]/i.test(line) || /^下载完成[:：]/i.test(line)) {
        return `${sourceId}:download-progress`;
    }

    if (/^解压进度[:：]/i.test(line)) {
        return `${sourceId}:extract-progress`;
    }

    return undefined;
}

function logNpmOutput(type, output, mainWindow, sourceId) {
    const lines = output.split(/\r\n|\n|\r/g).map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (isNoisyNpmLogLine(line)) {
            continue;
        }

        if (isNpmErrorMetadataLine(line)) {
            continue;
        }

        const message = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
        const mergeKey = getProgressMergeKey(sourceId, message);

        if (type === 'stderr') {
            if (!mergeKey) {
                console.error(`[NPM] stderr: ${message}`);
            }

            sendRendererLog(mainWindow, message, 'error', mergeKey);
        } else {
            if (!mergeKey) {
                console.log(`[NPM] stdout: ${message}`);
            }

            sendRendererLog(mainWindow, message, 'doing', mergeKey);
        }
    }
}

function runNpmCommand(entry, option, mainWindow) {
    return new Promise((resolve, reject) => {
        const { cmd, sourceId } = entry;
        assertProjectTaskActive(entry.ownerWebContents, entry);
        const child = spawn(cmd, {
            shell: true,
            windowsHide: true,
            env: process.env,
        });

        const shouldLogOutput = shouldLogStreamingOutput(cmd);
        entry.process = child;
        entry.closed = false;
        let stdout = '';
        let stderr = '';
        let processError;

        child.stdout.on('data', (data) => {
            const output = data.toString();

            stdout += output;

            if (shouldLogOutput) {
                logNpmOutput('stdout', output, mainWindow, sourceId);
            }
        });

        child.stderr.on('data', (data) => {
            const output = data.toString();

            stderr += output;

            if (shouldLogOutput) {
                logNpmOutput('stderr', output, mainWindow, sourceId);
            }
        });

        child.on('error', (error) => {
            processError = error;
            console.error('[PROC_TRACE][NPM_ERROR]', {
                sourceId,
                pid: child.pid,
                error: error.message,
                durationMs: Date.now() - entry.startedAt
            });
            // Spawn errors also emit close. An error alone does not prove an
            // already started process (or its install scripts) has stopped.
        });

        child.once('close', (code, signal) => {
            entry.closed = true;
            entry.completedNormally = Number.isInteger(code) && !signal;
            if (!entry.completedNormally && child.pid && !processError) entry.terminationUnconfirmed = true;
            if (entry.cancelled) return reject(new Error('NPM_COMMAND_CANCELLED'));
            if (processError) return option?.ignoreErr ? resolve(false) : reject(processError);
            if (code !== 0) {
                if (option?.ignoreErr) {
                    return resolve(false);
                }

                return reject(createNpmError(stderr, code));
            }

            if (stderr && !stdout) {
                return reject(createNpmError(stderr, code));
            }
            resolve(stdout);
        });
    });
}

async function runNpmWithRetries(entry, option, mainWindow) {
    const { cmd } = entry;
    const maxBusyRetries = shouldLogStreamingOutput(cmd) ? 2 : 0;
    for (let attempt = 1; attempt <= maxBusyRetries + 1; attempt++) {
        if (entry.cancelled) throw new Error('NPM_COMMAND_CANCELLED');
        try {
            return await runNpmCommand(entry, option, mainWindow);
        } catch (error) {
            if (!entry.cancelled && entry.completedNormally && attempt <= maxBusyRetries && error?.isBusyRename) {
                const message = `npm 安装目录被占用，等待后重试 (${attempt}/${maxBusyRetries})...`;
                console.warn(message);
                console.warn('[PROC_TRACE][NPM_BUSY_RETRY]', {
                    attempt, maxBusyRetries, cmd: cmd.slice(0, 1000), ...(error.busyRenameDetails || {})
                });
                sendRendererLog(mainWindow, message, 'warn', `${cmd}:busy-retry`);
                await waitForRetry(2000 * attempt, entry.retryAbort.signal);
                continue;
            }
            console.error(`执行命令出错: ${error.message || error}`);
            throw error;
        }
    }
}

function registerNpmHandlers(mainWindow) {
    ipcMain.handle('npm-run', async (event, { cmd, option = {}, projectPath, projectSessionId }) => {
        if (npmShutdown) throw new Error('NPM_SHUTDOWN_IN_PROGRESS');
        if (event.sender.isDestroyed()) throw new Error('NPM_OWNER_DESTROYED');
        assertProjectTaskActive(event.sender, { projectPath, projectSessionId });
        cmd = ensureForegroundScripts(cmd);
        console.log('npm run cmd: ', cmd);
        const sourceId = `npm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const entry = { sourceId, cmd, startedAt: Date.now(), closed: true,
            ownerWebContents: event.sender, projectPath, projectSessionId,
            retryAbort: new AbortController(), cancelled: false, stopRequested: false };
        activeNpmProcesses.set(sourceId, entry);
        const owner = event.sender;
        const onDestroyed = () => { entry.cancelled = true; entry.retryAbort.abort(); };
        const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) onDestroyed();
        };
        owner.on('did-start-navigation', onNavigation);
        owner.on('render-process-gone', onDestroyed);
        owner.on('destroyed', onDestroyed);
        try {
            return await runNpmWithRetries(entry, option, mainWindow);
        } finally {
            owner.removeListener('did-start-navigation', onNavigation);
            owner.removeListener('render-process-gone', onDestroyed);
            owner.removeListener('destroyed', onDestroyed);
            // Keep in-flight cancellation registered until its tree result arrives.
            if (!entry.stopRequested && !entry.terminationUnconfirmed) releaseNpmEntry(entry);
        }
    });
}

function releaseNpmEntry(entry) {
    if (activeNpmProcesses.get(entry.sourceId) === entry) activeNpmProcesses.delete(entry.sourceId);
}

async function stopNpmEntry(entry) {
    if (entry.stopPromise) return entry.stopPromise;
    entry.cancelled = true;
    entry.retryAbort.abort();
    // A closed PID may have been reused. Do not target it during a retry wait.
    if (entry.closed) {
        if (entry.terminationUnconfirmed) return false;
        releaseNpmEntry(entry);
        return true;
    }
    entry.stopRequested = true;
    entry.stopPromise = (async () => {
        const stopped = await killRegisteredProcessTree(entry.process?.pid, `npm:${entry.sourceId}`).catch(() => false);
        entry.terminationUnconfirmed = !stopped;
        if (stopped) releaseNpmEntry(entry);
        entry.stopRequested = false;
        return stopped;
    })();
    try { return await entry.stopPromise; } finally { entry.stopPromise = undefined; }
}

function getActiveNpmProcesses() {
    return Array.from(activeNpmProcesses.entries()).map(([sourceId, entry]) => ({
        sourceId,
        pid: entry.process?.pid,
        cmd: entry.cmd,
        durationMs: Date.now() - entry.startedAt
    }));
}

async function killAllNpmProcesses() {
    const entries = Array.from(activeNpmProcesses.entries());

    console.info('[PROC_TRACE][NPM_KILL_ALL]', { count: entries.length, processes: getActiveNpmProcesses() });
    const results = await Promise.all(entries.map(([, entry]) => stopNpmEntry(entry)));
    return results.every(Boolean);
}

async function killOwnerProjectNpmProcesses(owner, projectPath, projectSessionId) {
    const entries = [...activeNpmProcesses.values()]
        .filter(entry => matchesProjectTask(entry, owner, projectPath, projectSessionId));
    const results = await Promise.all(entries.map(stopNpmEntry));
    return results.every(Boolean);
}

module.exports = {
    registerNpmHandlers,
    killAllNpmProcesses,
    killOwnerProjectNpmProcesses,
    getActiveNpmProcesses,
    beginNpmShutdown: () => { npmShutdown = true; },
};
