// 窗口控制
const { ipcMain, BrowserWindow, app } = require("electron");
const { exec, execSync } = require('child_process');
const path = require('path');

function terminateAilyProcess() {
    const platform = process.platform;
    let checkCommand;
    let killCommand;
    const processName = platform === 'win32' ? 'aily blockly.exe' : 'aily blockly';

    if (platform === 'win32') {
        checkCommand = `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV`;
        killCommand = `taskkill /F /IM "${processName}"`;
    } else {
        checkCommand = `pgrep -f "${processName}"`;
        killCommand = `pkill -f "${processName}"`;
    }

    try {
        let count = 0;
        try {
            const stdout = execSync(checkCommand, { encoding: 'utf8' });
            if (platform === 'win32') {
                const matches = stdout.match(new RegExp(processName.replace('.', '\\.'), 'gi'));
                count = matches ? matches.length : 0;
            } else {
                count = stdout.trim().split('\n').length;
            }
        } catch (e) {
            if (platform !== 'win32' && e.status === 1) {
                count = 0;
            } else {
                console.warn('Error checking process count:', e.message);
            }
        }

        console.log(`Current aily-blockly process count: ${count}`);

        if (count > 1) {
            console.log('Multiple instances detected. Skipping forced termination.');
            return;
        }

        exec(killCommand, (error, stdout, stderr) => {
            if (error) {
                const notFound =
                    (platform === 'win32' && stderr && stderr.includes('not found')) ||
                    (platform !== 'win32' && error.code === 1);
                if (notFound) {
                    console.log('No aily-blockly process found to terminate.');
                    return;
                }
                console.error(`Error killing aily-blockly process: ${error.message}`);
                return;
            }
            if (stdout) {
                console.log(`aily-blockly process terminated: ${stdout}`);
            }
        });
    } catch (commandError) {
        console.warn('Error attempting to kill aily-blockly process:', commandError.message);
    }
}

function registerWindowHandlers(mainWindow) {
    // 添加一个映射来存储已打开的窗口
    const openWindows = new Map();

    mainWindow.on('focus', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-focus');
            }

        } catch (error) {
            console.error('Error sending window-focus:', error.message);
        }
    });

    mainWindow.on('blur', () => {
        // 检查窗口是否已销毁以及 webContents 是否有效
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-blur');
            }

        } catch (error) {
            console.error('Error sending window-blur:', error.message);
        }
    });

    mainWindow.on('enter-full-screen', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-full-screen-changed', true);
            }
        } catch (error) {
            console.error('Error sending window-full-screen-changed:', error.message);
        }
    });

    mainWindow.on('leave-full-screen', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-full-screen-changed', false);
            }
        } catch (error) {
            console.error('Error sending window-full-screen-changed:', error.message);
        }
    });

    // 为主窗口注册最大化/还原状态监听
    mainWindow.on('maximize', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-maximize-changed', true);
            }
        } catch (error) {
            console.error('Error sending window-maximize-changed:', error.message);
        }
    });

    mainWindow.on('unmaximize', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-maximize-changed', false);
            }
        } catch (error) {
            console.error('Error sending window-maximize-changed:', error.message);
        }
    });


    ipcMain.on("window-open", (event, data) => {
        const windowUrl = data.path;

        // 检查是否已存在该URL的窗口
        if (openWindows.has(windowUrl)) {
            const existingWindow = openWindows.get(windowUrl);
            // 确保窗口仍然有效
            if (existingWindow && !existingWindow.isDestroyed()) {
                // 激活已存在的窗口
                existingWindow.focus();
                return;
            } else {
                // 如果窗口已被销毁，从映射中移除
                openWindows.delete(windowUrl);
            }
        }

        // 创建新窗口
        const subWindow = new BrowserWindow({
            frame: false,
            autoHideMenuBar: true,
            transparent: true,
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
            alwaysOnTop: data.alwaysOnTop ? data.alwaysOnTop : false,
            width: data.width ? data.width : 800,
            height: data.height ? data.height : 600,
            webPreferences: {
                nodeIntegration: true,
                webSecurity: false,
                preload: path.join(__dirname, "preload.js"),
            },
        });

        // 将新窗口添加到映射
        openWindows.set(windowUrl, subWindow);

        // 为子窗口注册全屏状态监听
        subWindow.on('enter-full-screen', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-full-screen-changed', true);
                }
            } catch (error) {
                console.error('Error sending sub-window-full-screen-changed:', error.message);
            }
        });

        subWindow.on('leave-full-screen', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-full-screen-changed', false);
                }
            } catch (error) {
                console.error('Error sending sub-window-full-screen-changed:', error.message);
            }
        });

        // 为子窗口注册最大化/还原状态监听
        subWindow.on('maximize', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-maximize-changed', true);
                }
            } catch (error) {
                console.error('Error sending window-maximize-changed:', error.message);
            }
        });

        subWindow.on('unmaximize', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-maximize-changed', false);
                }
            } catch (error) {
                console.error('Error sending window-maximize-changed:', error.message);
            }
        });

        // 当窗口关闭时，从映射中移除
        subWindow.on('closed', () => {
            openWindows.delete(windowUrl);
        });

        // 页面加载完成后，将 data/url/title 发送给子窗口
        if (data.data || data.url || data.title) {
            subWindow.webContents.on('did-finish-load', () => {
                subWindow.webContents.send('window-init-data', {
                    url: data.url,
                    title: data.title,
                    data: data.data,
                });
            });
        }

        if (process.env.DEV === 'true' || process.env.DEV === true) {
            subWindow.loadURL(`http://localhost:4200/#/${data.path}`);
            // subWindow.webContents.openDevTools();
        } else {
            subWindow.loadFile(`renderer/index.html`, { hash: `#/${data.path}` });
            // subWindow.webContents.openDevTools();
        }
    });

    ipcMain.on("window-minimize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow) {
            senderWindow.minimize();
        }
    });

    ipcMain.on("window-maximize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow && !senderWindow.isMaximized()) {
            senderWindow.maximize();
        }
    });

    ipcMain.on("window-close", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        // 检查是否是主窗口，如果是主窗口，关闭整个应用程序
        if (senderWindow === mainWindow) {
            app.quit();
            // Attempt to terminate any residual helper processes on exit.
            terminateAilyProcess();
        } else {
            senderWindow.close();
        }
    });

    // Mac 平台下处理系统关闭按钮的关闭检查
    if (process.platform === 'darwin') {
        mainWindow.on('close', (event) => {
            event.preventDefault();
            mainWindow.webContents.send('window-close-request');
        });

        // 监听渲染进程返回的关闭确认结果
        ipcMain.on('window-close-confirmed', (event) => {
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            if (senderWindow === mainWindow) {
                mainWindow.removeAllListeners('close');
                mainWindow.close();
                app.quit();
                terminateAilyProcess();
            }
        });
    }

    // 修改为同步处理程序
    ipcMain.on("window-is-maximized", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isMaximized = senderWindow ? senderWindow.isMaximized() : false;
        event.returnValue = isMaximized;
    });

    // 添加 unmaximize 处理程序
    ipcMain.on("window-unmaximize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow && senderWindow.isMaximized()) {
            senderWindow.unmaximize();
        }
    });

    // 监听获取全屏状态的请求
    ipcMain.handle('window-is-full-screen', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        return senderWindow.isFullScreen();
    });

    // 检查窗口是否获得焦点（同步）
    ipcMain.on("window-is-focused", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isFocused = senderWindow ? senderWindow.isFocused() : false;
        event.returnValue = isFocused;
    });

    ipcMain.on("window-go-main", (event, data) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        mainWindow.webContents.send("window-go-main", data.replace('/', ''));
        senderWindow.close();
    });

    ipcMain.on("window-alwaysOnTop", (event, alwaysOnTop) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        senderWindow.setAlwaysOnTop(alwaysOnTop);
    });

    ipcMain.handle("window-send", (event, data) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (data.to == 'main') {
            // 创建唯一消息ID
            const messageId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
            // 创建Promise等待响应
            return new Promise((resolve) => {
                // 设置一次性监听器接收响应
                const responseListener = (event, response) => {
                    if (response.messageId === messageId) {
                        // 收到对应ID的响应，移除监听器并返回结果
                        ipcMain.removeListener('main-window-response', responseListener);
                        // console.log('window-send response', response);
                        resolve(response.data || "success");
                    }
                };
                // 注册监听器
                ipcMain.on('main-window-response', responseListener);
                // 发送消息到main窗口，带上messageId
                mainWindow.webContents.send("window-receive", {
                    form: senderWindow.id,
                    data: data.data,
                    messageId: messageId
                });
                // 自定义超时或默认9秒超时
                setTimeout(() => {
                    ipcMain.removeListener('main-window-response', responseListener);
                    resolve("timeout");
                }, data?.timeout || 9000);
            });
        }
        return true;
    });

    // 用于sub窗口改变main窗口状态显示
    ipcMain.on('state-update', (event, data) => {
        console.log('state-update: ', data);
        mainWindow.webContents.send('state-update', data);
    });
}


module.exports = {
    registerWindowHandlers,
};
