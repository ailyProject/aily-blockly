# Desktop Dev Startup Association

## Goal

修复根目录 `pnpm dev` 的桌面开发启动链路，让 Electron 只在前端 dev server 真正可访问后再启动，避免：

- Dock 图标过早出现
- Electron 提前创建隐藏窗口但没有可加载的前端
- 4200 端口被占用时 Electron 连接到错误/旧页面，表现成“只有图标没有窗口”

## Constraints

- `REFACTOR.md` 明确把 `/Users/xiewendao/Documents/Projects/polywise/` 作为桌面端架构参考。
- 当前工作树已存在用户修改，尤其是 `package.json`、`packages/desktop/scripts/*.mjs`、`packages/desktop/src/app/*`，本次应避免覆盖这些改动。
- 根目录 `pnpm dev` 当前通过 `turbo run dev --filter=ui --filter=desktop` 并行启动，两边没有 readiness 关联。

## Findings

1. 当前 desktop dev 的启动门槛只依赖 desktop 自身构建产物，不依赖 UI dev server 是否 ready。
2. `packages/desktop/src/app/index.ts` 在 `loadDesktopMainWindow()` 前就会完成 `app.whenReady()`、`dock.show()`、`createDesktopMainWindow()`。
3. `packages/desktop/src/app/window.ts` 虽然会等待 dev server 可访问再 `loadURL()`，但这只延迟页面加载，不会延迟 Electron 进程和 Dock 图标出现。
4. 本地复现时 `ui:dev` 报 `Port 4200 is already in use.`，但 desktop 仍继续使用 `http://127.0.0.1:4200`，存在错误绑定风险。
5. `polywise` 的参考点：
   - 主进程不会把“真实 UI ready”交给并行脚本碰运气。
   - 当真正页面还没准备好时，会先显示一个明确的 loading 页，再由 preload/renderer 发信号结束 loading。

## Plan

1. 新增根目录 `scripts/dev.mjs`，显式编排 dev 启动顺序。
2. 先启动 `ui` dev 任务，并等待 `http://127.0.0.1:4200` 可访问。
3. 仅在 UI ready 后再启动 `desktop` dev 任务，并把 `AILY_UI_DEV_SERVER_URL` 传给 desktop。
4. 在根脚本里做 4200 端口占用预检查，避免启动到错误前端。
5. 把根目录 `package.json` 的 `dev` 指向新脚本。
6. 固定 `packages/ui` 的 dev host/port，避免 Electron 与 Angular dev server 的地址约定漂移。

## Progress

- [x] 问题复现与日志确认
- [x] 对照 `polywise` 桌面启动代码
- [x] 实现根目录 dev 编排脚本
- [x] 更新脚本入口与 UI dev 参数
- [x] 验证端口占用失败路径
- [x] 验证正常启动路径
