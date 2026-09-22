# P3 Electron 宿主交付

更新：2026-09-09。主线：Services `docs/initiatives/provider-stream-recovery-copilot-codex-alignment-plan.md` P4-i/j。

## 边界

已按用户要求先提交并推送 `i3w-sim-preview`，再切到 `i3w-sim`。实际远端对应分支名为 `origin/downeyin-subapp-aily`，不存在 `origin/downey-subapp-aily`；已 fast-forward 合入其最新 `9ed08f33`，再迁入宿主修复。Services 交付到 `stao`、Lex 到 `i3w-pi`，完整发布还须包含本分支宿主代码。

原分支提交 `e5d4fcfd` 仅为此前 simulator compile 改动，保留在 preview；宿主提交 `16fa0e1a` 按功能 cherry-pick 为 `f8974bcc`。冲突处理保留同事的 `SubappManagerService` 及启动前安装已就绪更新逻辑、主进程 auth store 和凭据迁移，不整文件覆盖。另迁入 preview 既有 `appdata-path.js` 数据目录解析依赖，避免显式目录被覆盖。

本轮不改 ChatModel、TurnResponse、操作重放/撤回协议、计费公式，不增加恢复时自动重执行工具。存活 runtime 可以继续原调用；runtime 死亡后只能中断收口，未返回结果的工具不能自动再执行。

## 必要修改

| 文件 | 职责 |
| --- | --- |
| `electron/aily-host-auth-relay.js` | 主进程有界 pending 队列；读取凭据等待 renderer ready；导航轮换 relayId，旧页面迟到响应失效；保留原截止时间；refresh/logout 不自动重投；窗口关闭/进程退出清理 |
| `electron/window.js` | 删除旧散落 relay，接入模块；主窗口 sender 和 generation 校验；导航/ready/退出绑定 |
| `electron/main.js` | 向 window handler 提供现有 rendererGeneration，不新建第二份 generation |
| `electron/appdata-path.js` | 复用 preview 的目录选择：显式 AILY_APPDATA_PATH 优先，否则平台默认值；main 在初始化 auth store 前确定统一数据根 |
| `src/app/services/core/auth/auth.service.ts` | `hasLocalAuthSession` 区分离线本地可用和远端验证成功，失效/退出仍拒绝 |
| `src/app/services/core/auth/bridges/aily-chat-host-auth-runtime-bridge.ts` | 离线仍可取得已有凭据 lease，不逐次重试远端 /me；不缓存第二份 token |
| `src/app/services/core/app-shell/ui.service.ts` | 只放行 AI 本地入口的初始化/离线状态；其他受保护工具继续要求登录 |

`window.js` 还包含本轮之前的必要 runtime exit 改动，冷退出全组合在这些改动上验证。关联文件是 `electron/cmd.js`、`src/app/services/integrations/subapps/child-tool-process.service.ts`、`src/app/tools/child-tool-host/child-tool-host.component.ts`：进程结束应按精确 stream 广播，正常停止标记 expected，只有非预期退出才恢复宿主；不是执行新的 agent turn。不要在移植 auth relay 时丢掉这些已验证能力。

`child/scripts/compile.js` 等 preview 改动未一概迁入 sim。无关未跟踪文件保持原状。切分支时两个与上游新增文件重名的本地未跟踪 pnpm 文件已保留到 `D:/codes/.tmp/provider-recovery-p4j-untracked-pnpm/`，分支内使用上游锁文件，不覆盖同事的依赖声明。

## 回归

preview 原定向回归 30 项通过。合并后 sim 的测试集合不同，加入目录解析/实际 main 接线验证后最新 **29 项通过、0 skipped**；Angular 模板/类型编译通过。不能将两个分支的测试数量直接当作测试丢失：

```powershell
node --test electron/appdata-path.test.js electron/aily-host-auth-relay.test.js electron/aily-chat-offline-auth.test.js electron/child-tool-process.test.js electron/child-tool-runtime-exit.test.js electron/child-tool-session-process.test.js
node node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js -p tsconfig.app.json --noEmit
```

真实 Electron 24 检查点由 Lex `packages/aily-chat/scripts/electron-recovery-smoke.cjs` 驱动，完整本机启动/结束命令见 Services `docs/operations/PROVIDER_STREAM_RECOVERY_RELEASE.md`。专用 appdata 通过 junction 连接本机 `packages/aily-chat/dist/aily-chat`；不得拿用户原数据目录或正式服务做故障注入。

2026-09-09 在合并后的 sim 重跑完整矩阵，24 检查点全部通过。证据 `D:/codes/.tmp/provider-recovery-p4j-final-verified/`：52 次合成供应商调用、38 个实际 Interaction，26 completed、11 interrupted、1 预期预算耗尽 failed；无 running/lock，实际文件写入恰好 2 次。Service fixture 正常退出，pytest 1 passed；模型/Auth/账本边界为合成，不代表真实扣费或自然故障率。

第一轮准备因 sim 缺少显式数据目录接线，读到了默认目录的界面配置，在选择测试模型前失败，未发送会话，也不计验收通过。修复后使用全新目录重跑；Lex 验收入口现在断言 appdata、agent 和 API 都指向隔离目标。没有覆盖用户默认目录来迁就测试。

## 发布前

- [x] 离线入口/认证 IPC 根因修复及定向测试。
- [x] Windows Electron 全组合，真实审批文件副作用次数核对。
- [x] 用户指定 `i3w-sim`，合入最新同事分支、宿主改动及必要测试，并重新完成 Windows Electron 全组合。
- [ ] 团队按正式版本重新打包 Blockly/Lex，执行已打包应用启动验收；本轮 Electron 使用真实宿主 main.js 与 Angular dev 构建，不冒充最终安装包。
- [ ] macOS 实机及上线后自然故障观察。该项不是延长重试或开放未知身份的理由。
