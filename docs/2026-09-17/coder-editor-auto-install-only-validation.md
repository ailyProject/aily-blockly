# Coder Editor 自动安装与 only 范围验证

日期：2026-09-17。

- `aily-coder/package.json#ailySubapp.app` 增加 `autoInstall: true` 和 `defaultToolbar: false`，保持根级 `only: "aily coder"`。
- 正式目录生成与开发链接均原样传播 app 配置，并把根级 only 规范化后写入目录。
- 主窗口通用初始化先等待 `ConfigService.init()`，再用目录 only 与 `getApplicationName()` 匹配；自动安装每次启动检查，默认置顶仅首次安装处理，范围不匹配时跳过。
- 通用初始化改为复用 `RequiredSubappService.ensureInstalled()`，和 Coder 已有必需编辑器安装/重试共用单个在途任务。已安装版本直接复用。

验证：

- Angular ChromeHeadless 目标测试更新为 50/50 通过，含首次安装置顶专项 17 项。每次启动补装与保留手动置顶布局的验证见同目录 `default-subapps-bootstrap-validation.md`。
- 新增场景覆盖 Coder Editor 在 Blockly 下跳过、切换到匹配产品后安装、两个产品各自的 only/all/缺省匹配、不匹配的已安装应用不置顶，以及启动提示和通用初始化并发时仅一次底层安装。
- `tsc -p tsconfig.app.json --noEmit` 通过。
- `aily-coder` 的 `node scripts/generate-subapp-index.mjs` 成功；对生成产物运行宿主 `validateIndex` / `createCatalogState`，确认 `only: "aily coder"`、`autoInstall: true`、`defaultToolbar: false` 一致。
- 涉及仓库 `git diff --check` 通过。

范围：源码、生成目录及测试验证；未发布远端目录、未重启用户正在使用的 Electron、未模拟全新用户执行远端在线下载。测试中 network offline 日志来自既有的失败重试用例。
