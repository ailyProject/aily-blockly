# 端到端测试（E2E）

使用 [Playwright](https://playwright.dev/) 的 `_electron` API 对 aily-blockly 桌面应用做端到端测试。
测试直接启动 `electron/main.js` 主进程，针对 **生产构建产物** 运行。

## 工作原理

1. `global-setup`（[global-setup.ts](global-setup.ts)）先执行 `ng build --base-href ./`，
   再把构建产物 `dist/aily-blockly/browser` 暂存为项目根目录下的 `renderer/`。
   这正是 `electron-builder` 打包时的映射关系（`browser` → `renderer`）。
2. 启动夹具（[fixtures/electron-app.ts](fixtures/electron-app.ts)）用 `_electron.launch`
   以项目根为 `cwd`、`args: ['.']` 启动 Electron。主进程走「非 `--serve`」分支，
   通过 `loadFile('renderer/index.html')` 加载生产渲染层 —— 无需完整 `electron-builder` 打包。
3. 每个测试使用独立的临时 `--user-data-dir`，隔离 Electron 的用户配置；全流程所需的开发板包、编译器与 SDK 仍使用配置中的应用数据目录。

应用采用 hash 路由（`withHashLocation()`），测试用 `navigate(win, '/路由')` 切换页面。

## 运行

```powershell
# 完整跑（每次重新构建渲染层，最接近真实）
npm run test:e2e

# 快速迭代（复用已暂存的 renderer/，跳过重新构建）
npm run test:e2e:fast

# 注意：fast 模式会复用现有 renderer/，改过前端代码后请先跑一次完整 test:e2e

# 可视化 / 调试
npm run test:e2e:ui
npm run test:e2e:headed

# 查看上次 HTML 报告
npm run test:e2e:report

# 只跑某个文件
npm run test:e2e -- smoke.spec.ts
```

## 测试套件

| 文件 | 覆盖 | 默认是否运行 |
|------|------|------|
| [tests/smoke.spec.ts](tests/smoke.spec.ts) | 启动、主窗口、标题、版本、无崩溃 | ✅ |
| [tests/guide.spec.ts](tests/guide.spec.ts) | 指南主页与入口菜单 | ✅ |
| [tests/project-new.spec.ts](tests/project-new.spec.ts) | 新建项目向导渲染（含已装开发板时的选择） | ✅ |
| [tests/tools.spec.ts](tests/tools.spec.ts) | 串口监视器 / 终端面板（无需真实设备） | ✅ |
| [tests/aily-chat.spec.ts](tests/aily-chat.spec.ts) | AI 聊天工具离线 UI | ✅ |
| [tests/blockly-editor.spec.ts](tests/blockly-editor.spec.ts) | 打开项目、Blockly 工作区/工具箱 | ⏭️ 需环境变量 |
| [tests/compile.spec.ts](tests/compile.spec.ts) | 点击编译并等待结果 | ⏭️ 需环境变量 |
| [tests/full-flow.spec.ts](tests/full-flow.spec.ts) | 单/全开发板连续编译两次；项目广场全量编译 | ⏭️ 需环境变量 |

## 环境受限的用例（默认自动跳过）

Blockly 编辑器与编译需要真实项目和工具链，默认跳过。具备条件时按需开启：

```powershell
# Blockly 编辑器：指定一个含 project.abi 的项目目录
$env:AILY_E2E_PROJECT = 'D:\path\to\blockly-project'
npm run test:e2e -- blockly-editor.spec.ts

# 编译：还需已安装编译器/SDK（AILY_COMPILERS_PATH 等）并显式开启
$env:AILY_E2E_PROJECT = 'D:\path\to\blockly-project'
$env:AILY_E2E_COMPILE = '1'
npm run test:e2e -- compile.spec.ts

# 全流程：默认复用 %LOCALAPPDATA%\aily-project，再安装开发板包、使用默认项目名创建真实项目并调用真实编译工具链
$env:AILY_E2E_FULLFLOW = '1'
$env:AILY_E2E_BOARD_KEYWORD = 'uno r4' # 可选，默认 uno r4
# 可选：仅在需要全新环境时清空应用数据（会删除已安装的开发板包、编译器与 SDK 缓存）
# $env:AILY_E2E_CLEAR_APPDATA = '1'
# 指定多个开发板时用逗号分隔；设置后优先于 AILY_E2E_BOARD_KEYWORD
$env:AILY_E2E_BOARD_KEYWORDS = 'uno r4,esp32'
# 可选：新电脑首次下载依赖较慢时可调大，单位毫秒
$env:AILY_E2E_SINGLE_BOARD_TIMEOUT_MS = '3600000' # 默认 60 分钟
$env:AILY_E2E_INSTALL_TIMEOUT_MS = '1800000'      # 默认 30 分钟
$env:AILY_E2E_COMPILE_TIMEOUT_MS = '600000'       # 默认 10 分钟
npm run test:e2e:fast -- full-flow.spec.ts

# 全开发板全流程：默认复用 %LOCALAPPDATA%\aily-project，再逐个验证所有可创建开发板，每块板连续编译两次
$env:AILY_E2E_ALL_BOARDS = '1'
npm run test:e2e:fast -- full-flow.spec.ts

# 仅测试项目广场：不要同时设置 AILY_E2E_FULLFLOW / AILY_E2E_ALL_BOARDS
# 测试会下载、打开并编译所有公开项目；失败项目会在最后统一列出
$env:AILY_E2E_PROJECT_PLAZA = '1'
# 可选：单个广场项目下载、进入编辑器并完成加载的总超时，默认 3 分钟
$env:AILY_E2E_PROJECT_PLAZA_LOAD_TIMEOUT_MS = '180000'
# 可选：单个广场项目安装开发板依赖的超时，默认 5 分钟
$env:AILY_E2E_PROJECT_PLAZA_INSTALL_TIMEOUT_MS = '300000'
# 可选：单个项目编译超时，默认 10 分钟（与其他全流程用例共用）
$env:AILY_E2E_COMPILE_TIMEOUT_MS = '600000'
# 可选：同时执行的项目数，默认 2；资源有限或排查单项目时可设为 1
$env:AILY_E2E_PROJECT_PLAZA_CONCURRENCY = '2'
npm run test:e2e:fast -- full-flow.spec.ts
```

macOS / Linux 下使用 `VAR=value` 前缀或 `export`：

```bash
AILY_E2E_FULLFLOW=1 AILY_E2E_BOARD_KEYWORD='uno r4' npm run test:e2e:fast -- full-flow.spec.ts
AILY_E2E_FULLFLOW=1 AILY_E2E_BOARD_KEYWORDS='uno r4,esp32' npm run test:e2e:fast -- full-flow.spec.ts
AILY_E2E_ALL_BOARDS=1 npm run test:e2e:fast -- full-flow.spec.ts
AILY_E2E_PROJECT_PLAZA=1 npm run test:e2e:fast -- full-flow.spec.ts
# 仅在需要全新环境时添加 AILY_E2E_CLEAR_APPDATA=1
```

> 说明：当前未覆盖「上传(upload)」流程，因为它需要连接真实外设，不便在 CI/本地稳定运行。

> 全流程用例默认保留应用数据目录（Windows 默认 `C:\Users\<user>\AppData\Local\aily-project`，macOS 默认 `~/Library/aily-project`）。仅当设置 `AILY_E2E_CLEAR_APPDATA=1` 时，启动前才会清空并重建该目录；这会删除已安装的开发板包、编译器与 SDK 缓存。新建开发板项目前会清理 `aily-builder` 的临时项目与对象缓存；项目广场批量测试会保留 `aily-builder` 自身管理的哈希缓存，并默认用 2 个独立 Electron 并发执行。新建项目使用页面生成的默认项目名，项目广场项目则下载到默认项目目录；测试结束后都会清理。单项失败后继续验证后续条目，并在最后汇总失败清单。开发板项目第一次编译成功后才执行第二次编译；第一次失败会记录为“第 1 次编译失败”并结束该板子的编译。

## 备注

- Playwright 用例仍串行执行（`workers: 1`）；项目广场用例内部默认并发处理 2 个隔离 Electron。
- 选择器优先使用组件标签（如 `app-header`、`app-serial-monitor`）与稳定 CSS 类；
  应用目前几乎没有 `data-testid`，后续可逐步补充以提升稳定性。
- `renderer/`、`test-results/`、`playwright-report/` 已加入 `.gitignore`。
