# 文档维护入口

原 `docs/`、`contracts/`、`.draft/` 已迁移整理至独立 **aily-blockly-docs** 仓库。之后按需求日期统一维护在 **`docs/YYYY-MM-DD/`**，接口协议也使用同样的目录方式。

入口位于 `aily-blockly-docs` 仓库的 `docs/目录.md`。按仓库实际检出位置打开；文档仓库不是软件运行或构建依赖。

- 文档名称使用简洁中文，记录需求、当前实现、源码位置、必要结论与未完成项。
- 不收录端到端测试报告、截图、测试日志和证明附件。
- 本次实现核对在 `docs/2026-10-15/`，包含 ABS 同步/存储/文件锁、子应用、Coder、Project Data 等说明。
- 不另设 contracts、archive 或 proposals 目录。提案也放在对应日期，明确标为未实现。
- 原 docs/contracts 全量迁移保存在文档仓库提交 `4e8228b`；旧 `.draft` 原文保留在主软件 Git 历史，对应需求整理到 2026-06-24 和 2026-06-29。
- 修改主软件时同步对应日期需求文档，两仓分别提交；保留其他任务的未提交改动。

文档仓库只保存 Markdown，不保存 JSON 清单或源码校验元数据，也不记录用户绝对路径。源码版本与相对路径直接写在相关文档中。

临时查看服务结构使用 `npm --prefix tests run architecture:services:inventory`，只输出到终端。
