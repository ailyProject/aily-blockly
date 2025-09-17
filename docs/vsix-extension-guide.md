# VSIX 扩展加载功能

本项目已经集成了加载 VSCode VSIX 扩展的功能，使 Monaco 编辑器能够支持 VSCode 的扩展。

## 功能特点

- **自动扫描扩展**: 自动扫描 `child/vsix` 目录下的所有 `.vsix` 文件
- **扩展解析**: 使用 7za.exe 解析 VSIX 文件，读取扩展清单和资源
- **Monaco 集成**: 将扩展的语言支持、语法高亮、主题和命令集成到 Monaco 编辑器
- **IPC 通信**: Electron 主进程和渲染进程之间的扩展数据传输

## 实现结构

### Electron 端 (electron/vsix-loader.js)
- `VsixLoader` 类：负责扩展包的解析和管理
- 使用 7za.exe 解压和读取 VSIX 文件
- 提供 IPC 接口供渲染进程调用

### 渲染端 (src/app/editors/code-editor/services/vsix.service.ts)
- `VsixService` 服务：管理扩展的加载和激活
- 处理扩展的激活事件和贡献点
- 提供扩展管理的 API

### Monaco 编辑器集成 (components/monaco-editor/monaco-editor.component.ts)
- 在编辑器初始化时加载扩展支持
- 注册语言、语法高亮、主题和命令
- 将 VSCode 扩展功能映射到 Monaco 编辑器

## 支持的扩展类型

1. **语言支持**: 新的编程语言定义
2. **语法高亮**: TextMate 语法文件
3. **主题**: VSCode 主题文件
4. **命令**: 编辑器命令和动作

## 使用方式

1. 将 `.vsix` 扩展文件放入 `child/vsix` 目录
2. 启动应用程序
3. 扩展将自动加载并集成到代码编辑器中

## 扩展目录结构

```
child/
└── vsix/
    ├── vscode-clangd-0.2.0.vsix
    └── [其他扩展文件.vsix]
```

## API 接口

### VSIX 服务方法

```typescript
// 获取所有可用扩展
await vsixService.getAvailableExtensions();

// 加载指定扩展
await vsixService.loadExtension(extensionPath);

// 获取扩展清单
await vsixService.getExtensionManifest(extensionPath);

// 读取扩展文件
await vsixService.readExtensionFile(extensionPath, filePath);

// 卸载扩展
await vsixService.unloadExtension(extensionPath);
```

### IPC 接口

- `vsix:get-available-extensions`: 获取可用扩展列表
- `vsix:load-extension`: 加载扩展
- `vsix:get-manifest`: 获取扩展清单
- `vsix:read-file`: 读取扩展文件
- `vsix:get-file-list`: 获取扩展文件列表
- `vsix:unload-extension`: 卸载扩展

## 技术细节

### 扩展解析
- 使用 `process.env.AILY_7ZA_PATH` 指定的 7za.exe 工具
- 支持标准的 VSIX 包结构（ZIP 格式）
- 解析 `package.json` 清单文件

### 激活事件
- `*`: 立即激活
- `onLanguage:*`: 当特定语言文件被打开时激活
- `onCommand:*`: 当特定命令被执行时激活
- `workspaceContains:*`: 当工作区包含特定文件时激活

### 贡献点
- `languages`: 语言定义
- `grammars`: 语法高亮规则
- `themes`: 编辑器主题
- `commands`: 编辑器命令
- `configuration`: 扩展配置

## 注意事项

1. 本实现主要支持编辑器相关的扩展功能
2. 某些 VSCode 特有的 API 可能无法完全兼容
3. 扩展的复杂功能（如调试、任务等）可能需要额外的实现
4. 建议使用轻量级的语言支持扩展进行测试

## 示例扩展

项目中包含了 `vscode-clangd-0.2.0.vsix` 作为示例，提供 C/C++ 语言支持。

## 故障排除

1. 检查 `child/vsix` 目录是否存在且包含有效的 VSIX 文件
2. 确认 7za.exe 工具可以正常工作
3. 查看控制台输出的扩展加载日志
4. 验证扩展的 `package.json` 文件格式是否正确