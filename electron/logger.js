const path = require('path');
const electronLog = require('electron-log');
const fs = require('fs');

// 初始化日志系统
function initLogger(appDataPath) {
    // 配置日志文件路径
    const logDir = path.join(appDataPath, 'logs');
    // 检查目录是否存在，如果不存在则创建
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    electronLog.transports.file.resolvePathFn = () => path.join(logDir, 'app.log');
    
    // 配置日志格式
    electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
    
    // 配置日志文件大小限制 (1MB)
    electronLog.transports.file.maxSize = 1024 * 1024;
    
    // 配置日志级别
    electronLog.transports.file.level = 'info';
    electronLog.transports.console.level = 'info';
    
    // 将原生console重定向到electron-log
    console.log = electronLog.info.bind(electronLog);
    console.error = electronLog.error.bind(electronLog);
    console.warn = electronLog.warn.bind(electronLog);
    console.info = electronLog.info.bind(electronLog);
    
    // 捕获未处理的异常和承诺拒绝
    process.on('uncaughtException', (err) => {
        electronLog.error('Uncaught Exception:', err);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        electronLog.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
    
    electronLog.info('日志系统已初始化，日志文件路径:', electronLog.transports.file.getFile().path);
    return electronLog.transports.file.getFile().path;
}

// 注册 IPC handler，允许渲染进程发送日志到主进程
function registerLoggerHandlers() {
    const { ipcMain } = require('electron');
    
    // 处理来自渲染进程的日志
    ipcMain.handle('log-error', (event, message, error) => {
        const errorMessage = error 
            ? `${message}: ${error.message || error}${error.stack ? '\n' + error.stack : ''}`
            : message;
        electronLog.error('[渲染进程]', errorMessage);
    });
    
    ipcMain.handle('log-warn', (event, message) => {
        electronLog.warn('[渲染进程]', message);
    });
    
    ipcMain.handle('log-info', (event, message) => {
        electronLog.info('[渲染进程]', message);
    });
}

module.exports = {
    initLogger,
    registerLoggerHandlers,
    // 导出日志对象，方便在其他地方直接使用
    log: electronLog
};