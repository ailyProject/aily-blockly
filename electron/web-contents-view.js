/**
 * WebContentsView 子应用管理模块
 * 使用 Electron 的 WebContentsView 将工具面板拆分成独立的子应用
 */
const { BrowserWindow, WebContentsView, ipcMain } = require("electron");
const path = require("path");

// 存储所有创建的 WebContentsView 实例
const viewInstances = new Map();

// 子应用配置
const subAppConfig = {
  'code-viewer': {
    name: '代码预览',
    route: '/tools/code-viewer',
    preload: true
  },
  'serial-monitor': {
    name: '串口监视器',
    route: '/tools/serial-monitor',
    preload: true
  },
  'aily-chat': {
    name: 'AI 助手',
    route: '/tools/aily-chat',
    preload: true
  },
  'simulator': {
    name: '模拟器',
    route: '/tools/simulator',
    preload: false
  },
  'app-store': {
    name: '应用商店',
    route: '/tools/app-store',
    preload: false
  },
  'cloud-space': {
    name: '云空间',
    route: '/tools/cloud-space',
    preload: false
  },
  'model-store': {
    name: '模型商店',
    route: '/tools/model-store',
    preload: false
  },
  'user-center': {
    name: '用户中心',
    route: '/tools/user-center',
    preload: false
  }
};

/**
 * 创建 WebContentsView 实例
 * @param {BrowserWindow} parentWindow - 父窗口
 * @param {string} appId - 子应用 ID
 * @param {object} options - 配置选项
 * @returns {WebContentsView} 创建的视图实例
 */
function createWebContentsView(parentWindow, appId, options = {}) {
  const config = subAppConfig[appId];
  if (!config) {
    console.error(`未知的子应用 ID: ${appId}`);
    return null;
  }

  // 检查是否已存在
  const existingView = viewInstances.get(appId);
  if (existingView) {
    console.log(`子应用 ${appId} 已存在，返回现有实例`);
    return existingView;
  }

  // 创建 WebContentsView
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
    }
  });

  // 获取开发/生产模式下的 URL
  const serve = process.argv.includes('--serve');
  let url;
  
  if (serve) {
    url = `http://localhost:4200/#${config.route}`;
  } else {
    // 生产环境，使用 file 协议
    url = `file://${path.join(__dirname, '../renderer/index.html')}#${config.route}`;
  }

  // 加载 URL
  view.webContents.loadURL(url);

  // 存储实例
  viewInstances.set(appId, {
    view,
    config,
    visible: false,
    bounds: { x: 0, y: 0, width: 400, height: 600 }
  });

  // 监听 WebContents 事件
  view.webContents.on('did-finish-load', () => {
    console.log(`子应用 ${appId} 加载完成`);
  });

  view.webContents.on('crashed', () => {
    console.error(`子应用 ${appId} 崩溃`);
    // 可以在这里实现自动重启逻辑
    viewInstances.delete(appId);
  });

  // 开发环境下打开开发者工具（可选）
  if (serve && options.devTools) {
    view.webContents.openDevTools({ mode: 'detach' });
  }

  console.log(`创建子应用: ${appId}, URL: ${url}`);
  return view;
}

/**
 * 将 WebContentsView 添加到窗口并设置位置
 * @param {BrowserWindow} parentWindow - 父窗口
 * @param {string} appId - 子应用 ID
 * @param {object} bounds - 位置和大小 {x, y, width, height}
 */
function showWebContentsView(parentWindow, appId, bounds) {
  const instance = viewInstances.get(appId);
  if (!instance) {
    console.error(`子应用 ${appId} 不存在`);
    return false;
  }

  try {
    // 如果还没有添加到窗口，添加它
    if (!instance.visible) {
      parentWindow.contentView.addChildView(instance.view);
    }

    // 设置边界
    instance.view.setBounds(bounds);
    instance.bounds = bounds;
    instance.visible = true;

    console.log(`显示子应用: ${appId}, bounds:`, bounds);
    return true;
  } catch (error) {
    console.error(`显示子应用 ${appId} 失败:`, error);
    return false;
  }
}

/**
 * 隐藏 WebContentsView（从窗口中移除）
 * @param {BrowserWindow} parentWindow - 父窗口
 * @param {string} appId - 子应用 ID
 */
function hideWebContentsView(parentWindow, appId) {
  const instance = viewInstances.get(appId);
  if (!instance) {
    return false;
  }

  try {
    if (instance.visible) {
      parentWindow.contentView.removeChildView(instance.view);
      instance.visible = false;
    }
    console.log(`隐藏子应用: ${appId}`);
    return true;
  } catch (error) {
    console.error(`隐藏子应用 ${appId} 失败:`, error);
    return false;
  }
}

/**
 * 更新 WebContentsView 的位置和大小
 * @param {string} appId - 子应用 ID
 * @param {object} bounds - 位置和大小 {x, y, width, height}
 */
function updateWebContentsViewBounds(appId, bounds) {
  const instance = viewInstances.get(appId);
  if (!instance || !instance.visible) {
    return false;
  }

  try {
    instance.view.setBounds(bounds);
    instance.bounds = bounds;
    return true;
  } catch (error) {
    console.error(`更新子应用 ${appId} 边界失败:`, error);
    return false;
  }
}

/**
 * 销毁 WebContentsView 实例
 * @param {BrowserWindow} parentWindow - 父窗口
 * @param {string} appId - 子应用 ID
 */
function destroyWebContentsView(parentWindow, appId) {
  const instance = viewInstances.get(appId);
  if (!instance) {
    return false;
  }

  try {
    // 先从窗口中移除
    if (instance.visible) {
      parentWindow.contentView.removeChildView(instance.view);
    }
    
    // 销毁 WebContents
    if (!instance.view.webContents.isDestroyed()) {
      instance.view.webContents.close();
    }

    viewInstances.delete(appId);
    console.log(`销毁子应用: ${appId}`);
    return true;
  } catch (error) {
    console.error(`销毁子应用 ${appId} 失败:`, error);
    return false;
  }
}

/**
 * 向子应用发送消息
 * @param {string} appId - 子应用 ID
 * @param {string} channel - IPC 通道名
 * @param {any} data - 数据
 */
function sendToSubApp(appId, channel, data) {
  const instance = viewInstances.get(appId);
  if (!instance || instance.view.webContents.isDestroyed()) {
    console.error(`无法向子应用 ${appId} 发送消息：实例不存在或已销毁`);
    return false;
  }

  try {
    instance.view.webContents.send(channel, data);
    return true;
  } catch (error) {
    console.error(`向子应用 ${appId} 发送消息失败:`, error);
    return false;
  }
}

/**
 * 获取所有子应用信息
 */
function getSubAppList() {
  return Object.entries(subAppConfig).map(([id, config]) => {
    const instance = viewInstances.get(id);
    return {
      id,
      ...config,
      loaded: !!instance,
      visible: instance?.visible || false
    };
  });
}

/**
 * 设置子应用的 z-index 顺序（通过调整添加顺序实现）
 * @param {BrowserWindow} parentWindow - 父窗口
 * @param {string} appId - 要置顶的子应用 ID
 */
function bringToFront(parentWindow, appId) {
  const instance = viewInstances.get(appId);
  if (!instance || !instance.visible) {
    return false;
  }

  try {
    // 先移除再添加，使其位于最上层
    parentWindow.contentView.removeChildView(instance.view);
    parentWindow.contentView.addChildView(instance.view);
    return true;
  } catch (error) {
    console.error(`置顶子应用 ${appId} 失败:`, error);
    return false;
  }
}

/**
 * 销毁所有子应用实例
 * @param {BrowserWindow} parentWindow - 父窗口
 */
function destroyAllViews(parentWindow) {
  for (const [appId, instance] of viewInstances) {
    try {
      if (instance.visible) {
        parentWindow.contentView.removeChildView(instance.view);
      }
      if (!instance.view.webContents.isDestroyed()) {
        instance.view.webContents.close();
      }
    } catch (error) {
      console.error(`销毁子应用 ${appId} 时出错:`, error);
    }
  }
  viewInstances.clear();
}

/**
 * 打开子应用的开发者工具
 * @param {string} appId - 子应用 ID
 * @param {object} options - DevTools 选项
 */
function openDevTools(appId, options = { mode: 'detach' }) {
  const instance = viewInstances.get(appId);
  if (!instance || instance.view.webContents.isDestroyed()) {
    console.error(`无法打开 DevTools：子应用 ${appId} 不存在或已销毁`);
    return false;
  }

  try {
    instance.view.webContents.openDevTools(options);
    console.log(`已打开子应用 ${appId} 的 DevTools`);
    return true;
  } catch (error) {
    console.error(`打开 DevTools 失败:`, error);
    return false;
  }
}

/**
 * 关闭子应用的开发者工具
 * @param {string} appId - 子应用 ID
 */
function closeDevTools(appId) {
  const instance = viewInstances.get(appId);
  if (!instance || instance.view.webContents.isDestroyed()) {
    return false;
  }

  try {
    instance.view.webContents.closeDevTools();
    return true;
  } catch (error) {
    console.error(`关闭 DevTools 失败:`, error);
    return false;
  }
}

/**
 * 切换子应用的开发者工具
 * @param {string} appId - 子应用 ID
 */
function toggleDevTools(appId) {
  const instance = viewInstances.get(appId);
  if (!instance || instance.view.webContents.isDestroyed()) {
    return false;
  }

  try {
    if (instance.view.webContents.isDevToolsOpened()) {
      instance.view.webContents.closeDevTools();
    } else {
      instance.view.webContents.openDevTools({ mode: 'detach' });
    }
    return true;
  } catch (error) {
    console.error(`切换 DevTools 失败:`, error);
    return false;
  }
}

/**
 * 检查子应用的开发者工具是否已打开
 * @param {string} appId - 子应用 ID
 */
function isDevToolsOpened(appId) {
  const instance = viewInstances.get(appId);
  if (!instance || instance.view.webContents.isDestroyed()) {
    return false;
  }
  return instance.view.webContents.isDevToolsOpened();
}

/**
 * 注册 IPC 处理函数
 * @param {BrowserWindow} mainWindow - 主窗口
 */
function registerWebContentsViewHandlers(mainWindow) {
  // 创建子应用
  ipcMain.handle('wcv-create', async (event, { appId, options }) => {
    const view = createWebContentsView(mainWindow, appId, options);
    return { success: !!view };
  });

  // 显示子应用
  ipcMain.handle('wcv-show', async (event, { appId, bounds }) => {
    const result = showWebContentsView(mainWindow, appId, bounds);
    return { success: result };
  });

  // 隐藏子应用
  ipcMain.handle('wcv-hide', async (event, { appId }) => {
    const result = hideWebContentsView(mainWindow, appId);
    return { success: result };
  });

  // 更新边界
  ipcMain.handle('wcv-update-bounds', async (event, { appId, bounds }) => {
    const result = updateWebContentsViewBounds(appId, bounds);
    return { success: result };
  });

  // 销毁子应用
  ipcMain.handle('wcv-destroy', async (event, { appId }) => {
    const result = destroyWebContentsView(mainWindow, appId);
    return { success: result };
  });

  // 发送消息到子应用
  ipcMain.handle('wcv-send', async (event, { appId, channel, data }) => {
    const result = sendToSubApp(appId, channel, data);
    return { success: result };
  });

  // 获取子应用列表
  ipcMain.handle('wcv-list', async () => {
    return getSubAppList();
  });

  // 置顶子应用
  ipcMain.handle('wcv-bring-to-front', async (event, { appId }) => {
    const result = bringToFront(mainWindow, appId);
    return { success: result };
  });

  // 批量更新边界（用于窗口 resize 时）
  ipcMain.handle('wcv-batch-update-bounds', async (event, { updates }) => {
    const results = {};
    for (const { appId, bounds } of updates) {
      results[appId] = updateWebContentsViewBounds(appId, bounds);
    }
    return { success: true, results };
  });

  // 打开 DevTools
  ipcMain.handle('wcv-open-devtools', async (event, { appId, options }) => {
    const result = openDevTools(appId, options);
    return { success: result };
  });

  // 关闭 DevTools
  ipcMain.handle('wcv-close-devtools', async (event, { appId }) => {
    const result = closeDevTools(appId);
    return { success: result };
  });

  // 切换 DevTools
  ipcMain.handle('wcv-toggle-devtools', async (event, { appId }) => {
    const result = toggleDevTools(appId);
    return { success: result };
  });

  // 检查 DevTools 是否打开
  ipcMain.handle('wcv-is-devtools-opened', async (event, { appId }) => {
    return isDevToolsOpened(appId);
  });

  console.log('WebContentsView IPC handlers registered');
}

module.exports = {
  createWebContentsView,
  showWebContentsView,
  hideWebContentsView,
  updateWebContentsViewBounds,
  destroyWebContentsView,
  sendToSubApp,
  getSubAppList,
  bringToFront,
  destroyAllViews,
  openDevTools,
  closeDevTools,
  toggleDevTools,
  isDevToolsOpened,
  registerWebContentsViewHandlers,
  subAppConfig
};
