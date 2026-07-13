// 初始化应用日志系统，并接收渲染进程上报的日志。
const path = require('path');
const electronLog = require('electron-log');
const fs = require('fs');
const { BrowserWindow } = require('electron');

const projectPathByWebContentsId = new Map();

function initLogger(appDataPath) {
    const logDir = path.join(appDataPath, 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    electronLog.transports.file.resolvePathFn = () => path.join(logDir, 'app.log');
    electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
    electronLog.transports.file.maxSize = 1024 * 1024;
    electronLog.transports.file.level = 'info';
    electronLog.transports.console.level = 'info';

    console.log = (...args) => writeAppConsoleLog('INFO', args);
    console.info = (...args) => writeAppConsoleLog('INFO', args);
    console.warn = (...args) => writeAppConsoleLog('DEBUG', args);
    console.error = (...args) => writeAppConsoleLog('ERROR', args);

    process.on('uncaughtException', (err) => {
        writeStructuredProjectLog('app', 'ERROR', formatArgs(['Uncaught Exception:', err]));
        electronLog.error('Uncaught Exception:', err);
    });

    process.on('unhandledRejection', (reason, promise) => {
        writeStructuredProjectLog('app', 'ERROR', formatArgs(['Unhandled Rejection at:', promise, 'reason:', reason]));
        electronLog.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    writeAppConsoleLog('INFO', ['日志系统已初始化，日志文件路径:', electronLog.transports.file.getFile().path]);
    return electronLog.transports.file.getFile().path;
}

function registerLoggerHandlers() {
    const { ipcMain } = require('electron');

    ipcMain.handle('logger-set-project-path', (event, projectPath) => {
        setProjectPathForSender(event, projectPath);
        return { success: true };
    });

    ipcMain.handle('log-error', (event, message, error) => {
        const errorMessage = error
            ? `${message}: ${error.message || error}${error.stack ? '\n' + error.stack : ''}`
            : message;
        writeStructuredProjectLog('app', 'ERROR', `[renderer] ${errorMessage}`, resolveProjectPathForEvent(event));
        electronLog.error('[渲染进程]', errorMessage);
    });

    ipcMain.handle('log-warn', (event, message) => {
        writeStructuredProjectLog('app', 'DEBUG', `[renderer] ${message}`, resolveProjectPathForEvent(event));
        electronLog.warn('[渲染进程]', message);
    });

    ipcMain.handle('log-info', (event, message) => {
        writeStructuredProjectLog('app', 'INFO', `[renderer] ${message}`, resolveProjectPathForEvent(event));
        electronLog.info('[渲染进程]', message);
    });
}

function setProjectPathForSender(event, projectPath) {
    const senderId = event?.sender?.id;
    if (!Number.isInteger(senderId)) {
        return;
    }

    const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (normalizedProjectPath) {
        projectPathByWebContentsId.set(senderId, normalizedProjectPath);
        event.sender.once('destroyed', () => {
            projectPathByWebContentsId.delete(senderId);
        });
        return;
    }

    projectPathByWebContentsId.delete(senderId);
}

function writeAppConsoleLog(level, args) {
    const message = formatArgs(args);
    if (level === 'ERROR') {
        electronLog.error(message);
    } else if (level === 'DEBUG') {
        electronLog.warn(message);
    } else {
        electronLog.info(message);
    }
    writeStructuredProjectLog('app', level, message, resolveProjectPathForMainProcess());
}

function writeStructuredProjectLog(source, level, message, projectPath) {
    const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    const normalizedMessage = normalizeLogMessage(message);
    if (!normalizedProjectPath || !normalizedMessage) {
        return;
    }

    const now = new Date();
    const sourceId = normalizeSourceId(source);
    const daySegment = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
    const minuteSegment = `${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
    const dirPath = path.join(normalizedProjectPath, '.log', sourceId, daySegment);
    const filePath = path.join(dirPath, `${minuteSegment}.log`);

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    const timestamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${pad3(now.getMilliseconds())}`;
    const lines = normalizedMessage
        .split(/\r?\n/)
        .map((line) => normalizeLogLine(line, level))
        .filter(Boolean)
        .map((line) => `[${timestamp}] [${line.level}] [${sourceId}] ${line.message}`);
    if (lines.length > 0) {
        fs.appendFileSync(filePath, `${lines.join('\n')}\n`);
    }
}

function resolveProjectPathForEvent(event) {
    const senderId = event?.sender?.id;
    if (!Number.isInteger(senderId)) {
        return '';
    }
    return projectPathByWebContentsId.get(senderId) || '';
}

function resolveProjectPathForMainProcess() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const focusedId = focusedWindow?.webContents?.id;
    if (Number.isInteger(focusedId) && projectPathByWebContentsId.has(focusedId)) {
        return projectPathByWebContentsId.get(focusedId) || '';
    }
    return '';
}

function normalizeSourceId(source) {
    const trimmed = typeof source === 'string' ? source.trim() : '';
    return trimmed.replace(/[^a-zA-Z0-9._-]/g, '-') || 'app';
}

function normalizeLogMessage(message) {
    return typeof message === 'string' ? stripAnsi(message).trim() : '';
}

function normalizeLogLine(line, fallbackLevel) {
    const sanitized = stripAnsi(String(line || '')).trim();
    if (!sanitized) {
        return null;
    }

    const nestedPrefix = sanitized.match(/^\[(INFO|DEBUG|ERROR)\]\s*/i);
    if (!nestedPrefix) {
        return {
            level: fallbackLevel,
            message: sanitized,
        };
    }

    const nestedLevel = nestedPrefix[1].toUpperCase();
    const normalizedMessage = sanitized.slice(nestedPrefix[0].length).trim();
    return {
        level: nestedLevel,
        message: normalizedMessage || sanitized,
    };
}

function formatArgs(args) {
    return args.map((value) => {
        if (value instanceof Error) {
            return value.stack || value.message;
        }
        if (typeof value === 'string') {
            return value;
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }).join(' ');
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function pad3(value) {
    return String(value).padStart(3, '0');
}

function stripAnsi(value) {
    return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

module.exports = {
    initLogger,
    registerLoggerHandlers,
    log: electronLog,
};
