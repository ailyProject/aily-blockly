# origin/i3w-sim 合并验证

日期：2026-09-23。仓库：`aily--blockly`；目标分支：`downeyin-subapp-aily`。

- 合并前 HEAD：`316bce884550f533cefbd6a6bb3606f1fed7e94f`。
- 本次 fetch 后的 `origin/i3w-sim`：`e8824fd2c591f17fd2071eb2b6200d6c2fccfe46`。
- 共同祖先：`bb0fbc72cb3dae7f5831422df81c685a4a4a1d9f`。
- 起始工作区干净；使用保留双方历史的 merge，不推送远端。

## 功能保留与冲突处理

双方共修改 5 个相同文件，其中 4 个出现文本冲突，均位于 Credit 配置、服务、模型和测试。
`project.service.ts` 自动合并后已核对 Coder 换板依赖来源处理和 Blockly 导入迁移两个路径。
当前分支独有的 15 个文件和远端独有的 31 个文件，均与各自父提交逐字节一致（包括远端文件删除）。

- 保留 Coder 专属设置显隐、原生菜单品牌、云项目构建哈希/归档规则、换板模板依赖来源保护。
- 保留远端 ABS generation v2 请求与准备回执校验、运行库指纹校验、旧 shadow 身份迁移、原始 ABI 备份、复制时整项目 ID 去重和代码视图同步。
- 按远端设计停止旧 `abi_*` 远程写操作，保留原生 Blockly 编辑；当前 Agent 源码无这些旧操作调用。
- 额度统一经 `API.creditSnapshot` 请求 `/api/v1/credits/me`。保留当前分支对直接账本和网关 `status: 200` 成功包络的支持，解包仅发生在 HTTP 适配入口。
- 保留远端独立的账本适配器、金额安全整数校验、可选字段归一化、瞬时错误退避重试、确定性错误不重试、登出失效保护和同账号快照保留。
- 通用额度快照入口继续接受明确带 micros 字段的无 unit 账本；错误数据不会退回旧次数额度。
- 合并双方测试，新增成功包络的 HTTP 生命周期回归，保留对失败包络和包络内非法金额的拒绝验证。
- 保留远端更新服务器的时区判断扩展。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `tsc -p tsconfig.app.json --noEmit --pretty false` | 通过 |
| `npm run architecture:services` | 188 个服务文件，0 违规、0 循环 |
| `npm run test:abs-sync -- --progress=false` | 1,139 / 1,139 |
| `abs-project-load` ChromeHeadless | 9 / 9 |
| `tsconfig.user-center-credit.spec.json` Credit 合同与渲染 | 57 / 57 |
| `tsconfig.coder-cloud.spec.json` 构建哈希与云项目 | 41 / 41 |
| `tsconfig.settings-mode.spec.json` Coder/Blockly 设置与品牌 | 22 / 22 |
| `TMPDIR=/private/tmp node --test electron/project-file-writer.test.cjs electron/application-menu.test.js` | 36 / 36 |
| `node child/scripts/board-toolchain-dependencies.test.js` | 4 / 4，含 Coder/Blockly 预处理及上传参数 |
| `npm run test:e2e -- smoke.spec.ts` | 生产 Angular 构建通过；隔离 Electron 5 / 5 |
| 包版本、锁文件版本、冲突索引及 diff 空白检查 | 通过，版本均为 0.9.100 |

Angular 命令使用 `NG_BUILD_MAX_WORKERS=2`、`--watch=false --browsers=ChromeHeadless`。
聚焦 Angular 合计 1,268 项，Node 合计 40 项。Electron 使用临时 appdata 和 userData。

## 已定位的验证限制

- 全量测试 TypeScript 编译被 `src/app/tools/child-tool-host/resource-lifecycle-adapter.spec.ts:1` 的旧导入
  `../../services/subapp-resource-lifecycle-adapter` 阻断。该文件与合并前 HEAD 完全相同；未将全量单测报告为通过。
- 文件写入测试首次有两项故障注入未生效：默认 macOS 临时路径是 `/var/...`，生产写入器使用真实路径 `/private/var/...`，测试按字符串匹配失败。
  在合并前 HEAD 的独立临时副本复现相同两项失败。以真实临时目录 `TMPDIR=/private/tmp` 运行后 36 项全部通过，无需更改生产代码。
- ABS 首轮与其他 Angular 构建并行，后者短暂删除共享的 `.generated/blockly-runtime/native-candidate.js`，导致 3 项资源 404。
  构建脚本在重建开始时显式删除旧 bundle；顺序运行后 1,139 项全部通过。后续使用该共享输出的构建和测试应串行。
- 本次未执行真实账号额度请求、云发布、硬件烧录、Windows/Linux 实机或安装包发布验收；新增的两个外部项目 acceptance 脚本未运行。
