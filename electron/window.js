// 窗口控制
const { ipcMain, BrowserWindow } = require("electron");
const path = require('path');

function registerWindowHandlers(mainWindow) {
    // 添加一个映射来存储已打开的窗口
    const openWindows = new Map();

    // 注册窗口焦点事件监听
    const setupFocusListeners = (window) => {
        window.on('focus', () => {
            window.webContents.send('window-focus');
        });
        window.on('blur', () => {
            window.webContents.send('window-blur');
        });
    };

    // 为主窗口设置焦点监听
    setupFocusListeners(mainWindow);

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
            alwaysOnTop: data.alwaysOnTop ? data.alwaysOnTop : false,
            width: data.width ? data.width : 800,
            height: data.height ? data.height : 600,
            webPreferences: {
                nodeIntegration: true,
                webSecurity: false,
                preload: path.join(__dirname, "preload.js"),
            },
        });

        // 为子窗口设置焦点监听
        setupFocusListeners(subWindow);

        // 将新窗口添加到映射
        openWindows.set(windowUrl, subWindow);

        // 当窗口关闭时，从映射中移除
        subWindow.on('closed', () => {
            openWindows.delete(windowUrl);
        });

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
        senderWindow.close();
    });

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