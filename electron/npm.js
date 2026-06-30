// 这个文件用于和npm交互，获取仓库信息
const { ipcMain } = require("electron");
const { spawn, exec } = require('child_process');

const activeNpmProcesses = new Map();

function killRegisteredProcessTree(pid, label) {
    if (!pid) {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        const startedAt = Date.now();
        if (process.platform === 'win32') {
            exec(`taskkill /PID ${pid} /T /F`, (error, stdout, stderr) => {
                const success = !error;
                console.info('[PROC_TRACE][PROCESS_TREE_KILL]', {
                    label,
                    pid,
                    method: 'taskkill',
                    success,
                    durationMs: Date.now() - startedAt,
                    error: error?.message || '',
                    stderr: stderr?.trim?.() || ''
                });
                resolve(success);
            });
            return;
        }

        try {
            process.kill(pid, 'SIGTERM');
            console.info('[PROC_TRACE][PROCESS_TREE_KILL]', {
                label,
                pid,
                method: 'SIGTERM',
                success: true,
                durationMs: Date.now() - startedAt
            });
            resolve(true);
        } catch (error) {
            console.warn('[PROC_TRACE][PROCESS_TREE_KILL]', {
                label,
                pid,
                method: 'SIGTERM',
                success: false,
                durationMs: Date.now() - startedAt,
                error: error?.message || String(error)
            });
            resolve(false);
        }
    });
}

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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

function runNpmCommand(cmd, option, mainWindow) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(cmd, {
            shell: true,
            windowsHide: true,
            env: process.env,
        });
        const shouldLogOutput = shouldLogStreamingOutput(cmd);
        const sourceId = `npm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        activeNpmProcesses.set(sourceId, { process: child, cmd, startedAt });
        console.info('[PROC_TRACE][NPM_SPAWN]', { sourceId, pid: child.pid, cmd: cmd.slice(0, 1000) });
        let stdout = '';
        let stderr = '';

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
            activeNpmProcesses.delete(sourceId);
            console.error('[PROC_TRACE][NPM_ERROR]', {
                sourceId,
                pid: child.pid,
                error: error.message,
                durationMs: Date.now() - startedAt
            });
            if (option?.ignoreErr) {
                return resolve(false);
            }
            console.error(`执行命令出错: ${error}`);
            reject(error);
        });

        child.on('close', (code) => {
            activeNpmProcesses.delete(sourceId);
            const busyRename = isBusyRenameError(stderr);
            console.info('[PROC_TRACE][NPM_CLOSE]', {
                sourceId,
                pid: child.pid,
                code,
                durationMs: Date.now() - startedAt,
                busyRename,
                ...extractBusyRenameDetails(stderr)
            });
            if (code !== 0) {
                if (option?.ignoreErr) {
                    return resolve(false);
                }
                return reject(createNpmError(stderr, code));
            }
            if (stderr && !stdout) {
                return reject(createNpmError(stderr, code));
            }
            try {
                resolve(stdout);
            } catch (e) {
                reject(new Error(e.message));
            }
        });
    });
}

function registerNpmHandlers(mainWindow) {
    ipcMain.handle('npm-run', async (event, { cmd, option = {} }) => {
        cmd = ensureForegroundScripts(cmd);
        console.log('npm run cmd: ', cmd);
        const maxBusyRetries = shouldLogStreamingOutput(cmd) ? 2 : 0;

        for (let attempt = 1; attempt <= maxBusyRetries + 1; attempt++) {
            try {
                return await runNpmCommand(cmd, option, mainWindow);
            } catch (error) {
                if (attempt <= maxBusyRetries && error?.isBusyRename) {
                    const message = `npm 安装目录被占用，等待后重试 (${attempt}/${maxBusyRetries})...`;
                    console.warn(message);
                    console.warn('[PROC_TRACE][NPM_BUSY_RETRY]', {
                        attempt,
                        maxBusyRetries,
                        cmd: cmd.slice(0, 1000),
                        ...(error.busyRenameDetails || {})
                    });
                    sendRendererLog(mainWindow, message, 'warn', `${cmd}:busy-retry`);
                    await sleep(2000 * attempt);
                    continue;
                }

                console.error(`执行命令出错: ${error.message || error}`);
                throw error;
            }
        }
    });
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
    await Promise.all(entries.map(async ([sourceId, entry]) => {
        await killRegisteredProcessTree(entry.process?.pid, `npm:${sourceId}`);
        activeNpmProcesses.delete(sourceId);
    }));
}

module.exports = {
    registerNpmHandlers,
    killAllNpmProcesses,
    getActiveNpmProcesses,
};