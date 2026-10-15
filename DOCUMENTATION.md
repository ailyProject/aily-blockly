# 文档维护入口

从 2026-10-15 起，原 `docs/` 与 `contracts/` 整体迁移至独立 **aily-blockly-docs** 仓库，现行方案、接口约定、历史证据和后续改进文档统一在那里维护。

本机入口：[aily-blockly-docs](../../ZCK/aily-blockly-docs/README.md)。该相对链接对应当前工作区布局；其他机器使用自己的检出位置，文档仓库不是运行/构建依赖。

| 内容 | 文档仓库内位置 |
| --- | --- |
| 总索引与源码基线 | `README.md`、`source-baseline.json` |
| 当前实现 | `docs/architecture.md`、`docs/abs-sync.md`、`docs/subapps.md` 等 |
| 当前协议 | `contracts/` |
| 历史归档与迁移去向 | `archive/`、`docs/migration-review.md`、`migration-manifest.json` |
| 协同维护规则 | `AGENTS.md`、`docs/maintenance.md` |

修改主软件行为时同步新仓库对应说明，记录源码 commit 和实际验证范围；尚未实现的建议标为提案。不要在主软件重建 `docs/` 或 `contracts/`。

服务架构检查仍可独立运行；需要归档清单时显式指定文档根：

```sh
AILY_DOCS_ROOT=/path/to/aily-blockly-docs node scripts/check-angular-service-architecture.mjs --write-inventory
```

不写文件的查看命令仍为 `npm run architecture:services:inventory`。
