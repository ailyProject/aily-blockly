# WebContentsView 子应用架构说明

## 概述

本项目使用 Electron 的 `WebContentsView` API 将各种工具面板拆分成独立的子应用。每个子应用运行在独立的渲染进程中，通过 IPC 与主应用通信。

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│                     Main Process                        │
│  ┌─────────────────────────────────────────────────────┐│
│  │           web-contents-view.js                      ││
│  │  - 管理 WebContentsView 实例                         ││
│  │  - 处理子应用的创建、显示、隐藏、销毁                  ││
│  │  - 处理边界更新和 z-index 排序                        ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
                           │ IPC
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Main Renderer                        │
│  ┌─────────────────────────────────────────────────────┐│
│  │       WebContentsViewService (Angular)               ││
│  │  - 提供 TypeScript API                               ││
│  │  - 管理子应用状态                                     ││
│  │  - 处理边界计算                                       ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────┐│
│  │       SubAppContainerComponent                      ││
│  │  - 占位组件                                          ││
│  │  - 监听大小变化                                      ││
│  │  - 协调显示/隐藏                                     ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              Sub App Renderers (WebContentsView)        │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐              │
│  │code-viewer│ │aily-chat  │ │serial-mon │ ...          │
│  └───────────┘ └───────────┘ └───────────┘              │
└─────────────────────────────────────────────────────────┘
```

## 文件结构

```
electron/
├── web-contents-view.js      # WebContentsView 管理模块
├── preload.js                # 添加了 webContentsView API
└── main.js                   # 注册了 handlers

src/app/
├── services/
│   └── web-contents-view.service.ts  # Angular 服务
├── components/
│   └── sub-app-container/
│       └── sub-app-container.component.ts  # 子应用容器组件
└── main-window/
    ├── main-window.component.ts    # 支持两种模式
    └── main-window.component.html  # 模板更新
```

## 支持的子应用

| 子应用 ID | 名称 | 路由 |
|-----------|------|------|
| code-viewer | 代码预览 | /tools/code-viewer |
| serial-monitor | 串口监视器 | /tools/serial-monitor |
| aily-chat | AI 助手 | /tools/aily-chat |
| simulator | 模拟器 | /tools/simulator |
| app-store | 应用商店 | /tools/app-store |
| cloud-space | 云空间 | /tools/cloud-space |
| model-store | 模型商店 | /tools/model-store |
| user-center | 用户中心 | /tools/user-center |

## 使用方式

### 切换模式

在 `main-window.component.ts` 中，通过 `useWebContentsView` 属性控制：

```typescript
// 使用 WebContentsView 模式（独立进程）
useWebContentsView = true;

// 使用传统模式（内嵌组件）
useWebContentsView = false;
```

### 在代码中操作子应用

```typescript
import { WebContentsViewService } from '../services/web-contents-view.service';

constructor(private wcvService: WebContentsViewService) {}

// 显示子应用
async showTool() {
  await this.wcvService.showSubApp('aily-chat', {
    x: 100,
    y: 100,
    width: 400,
    height: 600
  });
}

// 隐藏子应用
async hideTool() {
  await this.wcvService.hideSubApp('aily-chat');
}

// 向子应用发送消息
async sendMessage() {
  await this.wcvService.sendToSubApp('aily-chat', 'custom-event', { data: 'hello' });
}

// 监听子应用消息
ngOnInit() {
  const unsubscribe = this.wcvService.onMessage('sub-app-event', (data) => {
    console.log('Received from sub app:', data);
  });
  
  // 在销毁时取消监听
  this.unsubscribe = unsubscribe;
}
```

### Preload API

在渲染进程中，可以通过 `window.electronAPI.webContentsView` 访问：

```javascript
// 创建子应用
await window.electronAPI.webContentsView.create('aily-chat');

// 显示子应用
await window.electronAPI.webContentsView.show('aily-chat', { x: 0, y: 0, width: 400, height: 600 });

// 隐藏子应用
await window.electronAPI.webContentsView.hide('aily-chat');

// 更新边界
await window.electronAPI.webContentsView.updateBounds('aily-chat', { x: 0, y: 0, width: 500, height: 700 });

// 销毁子应用
await window.electronAPI.webContentsView.destroy('aily-chat');

// 获取子应用列表
const list = await window.electronAPI.webContentsView.list();

// 向子应用发送消息
await window.electronAPI.webContentsView.send('aily-chat', 'event-name', { data: 'value' });

// 置顶子应用
await window.electronAPI.webContentsView.bringToFront('aily-chat');

// 监听消息
const unsubscribe = window.electronAPI.webContentsView.onMessage('event-name', (data) => {
  console.log(data);
});
```

## 优势

1. **进程隔离**：每个子应用运行在独立的渲染进程中，一个子应用崩溃不会影响其他应用
2. **性能优化**：可以独立管理每个子应用的资源，减少主应用的内存压力
3. **独立开发**：子应用可以独立开发和测试
4. **热重载**：可以单独重载某个子应用而不影响主应用
5. **安全隔离**：不同子应用之间的数据隔离更加安全

## 注意事项

1. **边界计算**：子应用的位置是相对于主窗口的，需要正确计算偏移量（包括标题栏高度）
2. **z-index 管理**：通过 `addChildView` 的顺序来管理层级，后添加的在上层
3. **内存占用**：每个 WebContentsView 都会占用一定的内存，注意及时销毁不需要的实例
4. **IPC 通信**：子应用间的通信需要通过主进程中转

## 扩展子应用

要添加新的子应用，需要：

1. 在 `electron/web-contents-view.js` 的 `subAppConfig` 中添加配置
2. 在 `src/app/app.routes.ts` 的 `tools` 路由下添加对应路由
3. 创建对应的 Angular 组件

```javascript
// electron/web-contents-view.js
const subAppConfig = {
  // ... 现有配置
  'new-tool': {
    name: '新工具',
    route: '/tools/new-tool',
    preload: false
  }
};
```

```typescript
// src/app/app.routes.ts
{
  path: "tools",
  children: [
    // ... 现有路由
    {
      path: 'new-tool',
      loadComponent: () => import('./tools/new-tool/new-tool.component').then(m => m.NewToolComponent)
    }
  ]
}
```
