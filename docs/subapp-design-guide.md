# Aily Blockly 子应用 (SubApp) 设计规范

## 概述

本文档定义了 Aily Blockly 项目中子应用的设计规范。子应用是独立的 Angular 应用程序，通过 iframe 嵌入到主应用中，并使用 penpal 7.x 进行跨窗口通信。

## 目录结构

```
projects/
  └── {subapp-name}/
      ├── package.json           # 子应用依赖配置
      ├── tsconfig.json          # TypeScript 基础配置
      ├── tsconfig.app.json      # 应用编译配置
      └── src/
          ├── index.html         # 入口 HTML
          ├── main.ts            # Angular 启动入口
          ├── styles.scss        # 全局样式
          └── app/
              ├── app.component.ts       # 根组件
              ├── app.component.html     # 根组件模板
              ├── app.component.scss     # 根组件样式
              ├── app.config.ts          # 应用配置
              ├── components/            # 子组件目录
              ├── services/              # 业务服务
              ├── config/                # 配置文件
              └── penpal/                # Penpal 通信层
                  ├── penpal.service.ts  # Penpal 服务
                  └── types.ts           # 通信类型定义
```

## Penpal 7.x 通信规范

### 1. 类型定义 (`penpal/types.ts`)

```typescript
/**
 * 父窗口暴露给子窗口的方法
 * 主程序实现这些方法，供子应用调用
 */
export interface ParentMethods {
  // 必须添加索引签名以兼容 penpal 7.x
  [key: string]: ((...args: any[]) => any) | ParentMethods;
  
  // 定义具体方法...
  methodName(param: ParamType): Promise<ReturnType>;
}

/**
 * 子窗口暴露给父窗口的方法
 * 子应用实现这些方法，供主程序调用
 */
export interface ChildMethods {
  // 必须添加索引签名以兼容 penpal 7.x
  [key: string]: ((...args: any[]) => any) | ChildMethods;
  
  // 定义具体方法...
  onEvent(data: DataType): void;
}
```

### 2. 子应用 Penpal 服务 (`penpal/penpal.service.ts`)

```typescript
import { Injectable, NgZone } from '@angular/core';
import { connect, WindowMessenger, RemoteProxy, Connection } from 'penpal';
import { BehaviorSubject, Subject } from 'rxjs';
import { ParentMethods, ChildMethods } from './types';

@Injectable({
  providedIn: 'root'
})
export class PenpalService {
  private parentMethods: RemoteProxy<ParentMethods> | null = null;
  private connection: Connection<ParentMethods> | null = null;
  private connectionReady = new BehaviorSubject<boolean>(false);

  // 事件广播
  eventReceived = new Subject<EventType>();

  constructor(private ngZone: NgZone) {
    this.initConnection();
  }

  private async initConnection() {
    try {
      // 定义子应用暴露的方法
      const childMethods: ChildMethods = {
        onEvent: (data) => {
          this.ngZone.run(() => {
            this.eventReceived.next(data);
          });
        }
      };

      // penpal 7.x 使用 WindowMessenger + connect
      const messenger = new WindowMessenger({
        remoteWindow: window.parent,
        allowedOrigins: ['*'] // Electron 环境允许任意来源
      });

      this.connection = connect<ParentMethods>({
        messenger,
        methods: childMethods
      });

      this.parentMethods = await this.connection.promise;
      this.connectionReady.next(true);
      console.log('[SubApp] Penpal connection established');
    } catch (error) {
      console.error('[SubApp] Failed to connect to parent:', error);
    }
  }

  // 等待连接就绪
  async waitForConnection(): Promise<void> {
    if (this.connectionReady.value) return;
    return new Promise((resolve) => {
      const sub = this.connectionReady.subscribe((ready) => {
        if (ready) {
          sub.unsubscribe();
          resolve();
        }
      });
    });
  }

  // 调用父窗口方法
  async callParentMethod(param: ParamType): Promise<ReturnType> {
    await this.waitForConnection();
    return this.parentMethods!.methodName(param);
  }
}
```

### 3. 主程序 Bridge 服务

```typescript
import { Injectable, ElementRef } from '@angular/core';
import { connect, WindowMessenger, RemoteProxy, Connection } from 'penpal';
import { ParentMethods, ChildMethods } from './penpal-types';

@Injectable({
  providedIn: 'root'
})
export class SubAppBridgeService {
  private connection: Connection<ChildMethods> | null = null;
  private childMethods: RemoteProxy<ChildMethods> | null = null;

  async initConnection(iframeRef: ElementRef<HTMLIFrameElement>): Promise<void> {
    if (this.connection) {
      this.connection.destroy();
    }

    // 定义主程序暴露的方法
    const parentMethods: ParentMethods = {
      methodName: (param) => this.handleMethod(param)
    };

    // penpal 7.x 使用 WindowMessenger + connect
    const messenger = new WindowMessenger({
      remoteWindow: iframeRef.nativeElement.contentWindow!,
      allowedOrigins: ['*'] // Electron 本地文件
    });

    this.connection = connect<ChildMethods>({
      messenger,
      methods: parentMethods
    });

    try {
      this.childMethods = await this.connection.promise;
      console.log('[Bridge] Connection established');
    } catch (error) {
      console.error('[Bridge] Failed to connect:', error);
    }
  }

  destroy() {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
      this.childMethods = null;
    }
  }

  // 调用子应用方法
  notifyChild(method: string, ...args: any[]): void {
    if (!this.childMethods) return;
    const fn = (this.childMethods as any)[method];
    if (typeof fn === 'function') {
      fn(...args);
    }
  }
}
```

### 4. 主程序 Iframe 组件

```typescript
import { Component, ElementRef, ViewChild, OnDestroy, AfterViewInit } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { SubAppBridgeService } from './subapp-bridge.service';

@Component({
  selector: 'app-subapp-iframe',
  template: `
    <div class="iframe-container">
      <iframe 
        #subappIframe
        [src]="iframeSrc"
        (load)="onIframeLoad()">
      </iframe>
    </div>
  `,
  styles: [`
    .iframe-container {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
  `]
})
export class SubAppIframeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('subappIframe') iframeRef!: ElementRef<HTMLIFrameElement>;
  
  iframeSrc: SafeResourceUrl;
  
  constructor(
    private sanitizer: DomSanitizer,
    private bridgeService: SubAppBridgeService
  ) {
    // 开发模式使用独立端口，生产模式使用相对路径
    const isDev = window.location.port === '4200';
    const iframeUrl = isDev 
      ? 'http://localhost:4201' 
      : './subapp-name/index.html';
    
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(iframeUrl);
  }
  
  async onIframeLoad() {
    if (this.iframeRef) {
      await this.bridgeService.initConnection(this.iframeRef);
    }
  }
  
  ngOnDestroy() {
    this.bridgeService.destroy();
  }
}
```

## Angular 工作区配置

### angular.json 子项目配置

```json
{
  "projects": {
    "{subapp-name}": {
      "projectType": "application",
      "schematics": {
        "@schematics/angular:component": {
          "style": "scss",
          "skipTests": true
        }
      },
      "root": "projects/{subapp-name}",
      "sourceRoot": "projects/{subapp-name}/src",
      "prefix": "app",
      "architect": {
        "build": {
          "builder": "@angular-devkit/build-angular:application",
          "options": {
            "outputPath": "dist/{subapp-name}",
            "index": "projects/{subapp-name}/src/index.html",
            "browser": "projects/{subapp-name}/src/main.ts",
            "polyfills": ["zone.js"],
            "tsConfig": "projects/{subapp-name}/tsconfig.app.json",
            "inlineStyleLanguage": "scss",
            "assets": [
              {
                "glob": "**/*",
                "input": "public/fonts",
                "output": "assets/fonts"
              }
            ],
            "styles": [
              "projects/{subapp-name}/src/styles.scss",
              "node_modules/ng-zorro-antd/ng-zorro-antd.dark.css"
            ]
          },
          "configurations": {
            "production": {
              "outputHashing": "all"
            },
            "development": {
              "optimization": false,
              "sourceMap": true
            }
          },
          "defaultConfiguration": "production"
        },
        "serve": {
          "builder": "@angular-devkit/build-angular:dev-server",
          "configurations": {
            "production": {
              "buildTarget": "{subapp-name}:build:production"
            },
            "development": {
              "buildTarget": "{subapp-name}:build:development"
            }
          },
          "defaultConfiguration": "development",
          "options": {
            "port": 4201  // 子应用使用不同端口
          }
        }
      }
    }
  }
}
```

### 子应用 package.json

```json
{
  "name": "{subapp-name}",
  "version": "1.0.0",
  "description": "Description of the sub-application",
  "scripts": {
    "start": "ng serve --project {subapp-name} --port 4201",
    "build": "ng build --project {subapp-name}",
    "build:prod": "ng build --project {subapp-name} --configuration production"
  },
  "dependencies": {
    "@angular/animations": "^19.0.0",
    "@angular/common": "^19.0.0",
    "@angular/core": "^19.0.0",
    "@angular/forms": "^19.0.0",
    "@angular/platform-browser": "^19.0.0",
    "@angular/platform-browser-dynamic": "^19.0.0",
    "ng-zorro-antd": "^19.0.0",
    "penpal": "^7.0.4",
    "rxjs": "~7.8.0",
    "zone.js": "~0.15.0"
  }
}
```

## 开发流程

### 1. 创建新子应用

```bash
# 创建项目目录
mkdir -p projects/{subapp-name}/src/app/{components,services,config,penpal}

# 复制基础文件模板
# - index.html
# - main.ts
# - styles.scss
# - app.component.ts
# - app.config.ts
# - penpal/penpal.service.ts
# - penpal/types.ts
```

### 2. 开发模式

```bash
# 终端 1: 启动主应用
npm start

# 终端 2: 启动子应用
ng serve --project {subapp-name} --port 4201
```

### 3. 构建生产版本

```bash
# 构建子应用
ng build --project {subapp-name} --configuration production

# 复制到主应用输出目录
# dist/{subapp-name}/ -> dist/aily-blockly/browser/{subapp-name}/
```

## 通信模式

### 1. 子应用调用主程序方法 (请求-响应)

```typescript
// 子应用调用
const result = await this.penpalService.getPortsList();
```

### 2. 主程序推送数据到子应用 (事件推送)

```typescript
// 主程序推送
this.bridgeService.notifyChild('onSerialData', dataItem);

// 子应用接收
this.penpalService.serialDataReceived.subscribe((data) => {
  // 处理数据
});
```

### 3. 双向通信流程图

```
┌─────────────────┐                    ┌─────────────────┐
│    主程序        │                    │    子应用        │
│  (Parent)       │                    │   (Child)       │
├─────────────────┤                    ├─────────────────┤
│                 │  ──── request ───► │                 │
│  ParentMethods  │                    │  PenpalService  │
│                 │  ◄─── response ─── │                 │
├─────────────────┤                    ├─────────────────┤
│                 │  ──── event ─────► │                 │
│  BridgeService  │                    │  ChildMethods   │
│                 │                    │                 │
└─────────────────┘                    └─────────────────┘
```

## 最佳实践

### 1. NgZone 处理
在 penpal 回调中使用 `NgZone.run()` 确保 Angular 变更检测正常工作：

```typescript
onSerialData: (data) => {
  this.ngZone.run(() => {
    this.serialDataReceived.next(data);
  });
}
```

### 2. 连接生命周期
- 在 iframe `load` 事件后初始化连接
- 在组件 `ngOnDestroy` 时销毁连接

### 3. 错误处理
- 使用 try-catch 包裹连接初始化
- 调用远程方法前检查连接状态

### 4. 类型安全
- 为所有接口添加索引签名以兼容 penpal 7.x
- 在两端共享相同的类型定义

### 5. 开发/生产环境
- 使用端口检测区分环境
- 开发模式使用独立服务器
- 生产模式使用相对路径加载

## 示例：serial-monitor-app

完整的子应用示例可参考：
- 子应用代码：`projects/serial-monitor-app/`
- 主程序集成：`src/app/tools/serial-monitor-iframe/`

## 依赖版本

| 依赖 | 版本 |
|------|------|
| Angular | ^19.0.0 |
| penpal | ^7.0.4 |
| ng-zorro-antd | ^19.0.0 |
| rxjs | ~7.8.0 |
