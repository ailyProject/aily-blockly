# P3 Electron 宿主交付

2026-09-08。主线：Services `docs/initiatives/provider-stream-recovery-copilot-codex-alignment-plan.md` P4-i。

## 边界

当前本地分支为 `i3w-sim-preview`，本轮尚未提交推送 Blockly。Services 交付到 `stao`、Lex 到 `i3w-pi`，不意味着 Blockly 宿主代码已随之发布。先确认 Blockly 发布分支，再按功能合入，不覆盖同事的模拟器实现。

本轮不改 ChatModel、TurnResponse、操作重放/撤回协议、计费公式，不增加恢复时自动重执行工具。存活 runtime 可以继续原调用；runtime 死亡后只能中断收口，未返回结果的工具不能自动再执行。

## 必要修改

| 文件 | 职责 |
| --- | --- |
| `electron/aily-host-auth-relay.js` | 主进程有界 pending 队列；读取凭据等待 renderer ready；导航轮换 relayId，旧页面迟到响应失效；保留原截止时间；refresh/logout 不自动重投；窗口关闭/进程退出清理 |
| `electron/window.js` | 删除旧散落 relay，接入模块；主窗口 sender 和 generation 校验；导航/ready/退出绑定 |
| `electron/main.js` | 向 window handler 提供现有 rendererGeneration，不新建第二份 generation |
| `src/app/services/core/auth/auth.service.ts` | `hasLocalAuthSession` 区分离线本地可用和远端验证成功，失效/退出仍拒绝 |
| `src/app/services/core/auth/bridges/aily-chat-host-auth-runtime-bridge.ts` | 离线仍可取得已有凭据 lease，不逐次重试远端 /me；不缓存第二份 token |
| `src/app/services/core/app-shell/ui.service.ts` | 只放行 AI 本地入口的初始化/离线状态；其他受保护工具继续要求登录 |

`window.js` 还包含本轮之前的必要 runtime exit 改动，冷退出全组合在这些改动上验证。关联文件是 `electron/cmd.js`、`src/app/services/integrations/subapps/child-tool-process.service.ts`、`src/app/tools/child-tool-host/child-tool-host.component.ts`：进程结束应按精确 stream 广播，正常停止标记 expected，只有非预期退出才恢复宿主；不是执行新的 agent turn。不要在移植 auth relay 时丢掉这些已验证能力。

`child/scripts/compile.js` 等此前工作区改动不因本轮一概暂存。必须逐项确认发布依赖，不能 `git add .` 或整目录覆盖。

## 回归

新增 `electron/aily-host-auth-relay.test.js` 与 `electron/aily-chat-offline-auth.test.js`。本机连同既有进程测试 30 项通过、0 skipped，Angular 模板/类型编译通过：

```powershell
node --test electron/aily-host-auth-relay.test.js electron/aily-chat-offline-auth.test.js electron/child-tool-process.test.js electron/child-tool-runtime-exit.test.js electron/child-tool-session-process.test.js
node node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js -p tsconfig.app.json --noEmit
```

真实 Electron 24 检查点由 Lex `packages/aily-chat/scripts/electron-recovery-smoke.cjs` 驱动，完整本机启动/结束命令见 Services `docs/operations/PROVIDER_STREAM_RECOVERY_RELEASE.md`。专用 appdata 通过 junction 连接本机 `packages/aily-chat/dist/aily-chat`；不得拿用户原数据目录或正式服务做故障注入。

## 发布前

- [x] 离线入口/认证 IPC 根因修复及定向测试。
- [x] Windows Electron 全组合，真实审批文件副作用次数核对。
- [ ] 团队确认 Blockly 发布分支，并移入上述宿主改动及必要测试。
- [ ] 团队按正式版本重新打包 Blockly/Lex，执行已打包应用启动验收；本轮 Electron 使用真实宿主 main.js 与 Angular dev 构建，不冒充最终安装包。
- [ ] macOS 实机及上线后自然故障观察。该项不是延长重试或开放未知身份的理由。
