# 文档维护入口

主软件的需求、架构、实现说明和接口协议集中维护在独立仓库 [ailyProject/aily-blockly-docs](https://github.com/ailyProject/aily-blockly-docs)。原 `docs/`、`contracts/`、`.draft/` 已迁移整理到该仓库，后续相关文档统一写入 **`docs/YYYY-MM-DD/`**。

## 阅读入口与职责

- [仓库说明](https://github.com/ailyProject/aily-blockly-docs#readme)：用途、目录组织和基本使用方式。
- [文档目录](https://github.com/ailyProject/aily-blockly-docs/blob/HEAD/docs/目录.md)：按日期查找需求与实现说明。
- [维护规范](https://github.com/ailyProject/aily-blockly-docs/blob/HEAD/docs/2026-10-15/维护规范.md)：命名、源码关联、历史与提交规则。

主软件仓库维护源码、测试以及 [开发与打包说明](develop.md)，本文件保留文档仓库的管理入口。文档仓库维护需求、方案、接口约定和实现记录；普通运行和构建不依赖它。面向软件使用者的操作指南仍见 [使用文档](https://yiyu.pro/doc)。

## 克隆与更新

需要查阅或修改开发文档时，在自行选择的工作目录执行：

```bash
git clone https://github.com/ailyProject/aily-blockly-docs.git
cd aily-blockly-docs
```

直接打开 `docs/目录.md`，无需安装依赖。两个仓库按实际检出位置使用，不要求相邻目录，也不要把文档仓库复制进主软件或重建主软件的 `docs/`、`contracts/`、`.draft/`。

日常更新在文档仓库内进行：

```bash
git status --short
```

确认工作区干净且当前分支已设置上游后，再执行：

```bash
git pull --ff-only
```

有本地改动时先检查归属，保留其他任务的修改；分支分叉导致快进失败时，按当前协作流程处理分支关系。主软件与文档是两个独立 Git 仓库，拉取或提交其中一个不会自动更新另一个。

## 开发时如何使用

1. 在文档目录中定位相关功能；已安装 ripgrep 时，也可在文档仓库执行 `rg -n '关键词' docs`。
2. 查看文档的需求日期、复核日期和关联源码 commit，再对照主软件当前实现。旧文档或旧验证结论不能直接作为当前行为依据。
3. 修改软件行为时，在同一任务内同步相应实现说明或接口协议，写明变更、源码位置、验证范围和未完成项。
4. 修改已有需求时更新原文并标明复核日期；跨日期的新需求写入 `docs/YYYY-MM-DD/简洁中文名称.md`，链接前文并更新 `docs/目录.md`。未实现内容明确标为提案。

2026-10-15 的实现核对位于文档仓库 `docs/2026-10-15/`，包含 ABS 同步、工程存储、文件锁、子应用、Coder 和 Project Data 等说明；阅读时仍需核对后续源码变化。

## 跨仓提交与检查

两个仓库分别检查、暂存和提交本任务文件，不混入其他任务的改动。涉及源码变更时，先提交本次源码改动，再在主软件根目录取得对应提交：

```bash
git rev-parse HEAD
```

将实际关联的源码 commit、仓库名和相对路径写入需求正文，源码链接固定为 `https://github.com/ailyProject/aily-blockly/blob/<commit>/<相对路径>`。源码提交尚未推送时，可在主软件仓库用 `git show <commit>:<相对路径>` 查看。纯文档整理引用已有源码基线，无需制造源码提交。

例如仅修改文档仓库的维护规范时，在文档仓库执行：

```bash
git diff -- docs/2026-10-15/维护规范.md
git diff --check
git add -- docs/2026-10-15/维护规范.md
git diff --cached
git commit -m "docs: 更新文档维护规范"
```

其他任务应替换为实际修改的文件路径；新增文档时一并暂存 `docs/目录.md`。提交前检查日期归属、名称、相对链接和源码引用；按各仓库的协作流程分别推送或提交评审。纯文档整理不重新宣称历史性能、安装包或硬件验收结果。

## 内容边界与历史

业务文档只使用 Markdown，根目录保留 README 和必要的仓库配置。文档名称使用简洁中文，记录需求、当前实现、源码位置、必要结论与未完成项。文档仓库不另设 `contracts/`、`archive/`、`proposals/` 或 `.draft/`，不收录端到端测试报告、截图、测试日志、证明附件、JSON 清单或源码校验元数据。跨仓引用使用仓库名和相对路径，不记录个人绝对路径。

原 `docs/` 和 `contracts/` 全量迁移保存在文档仓库提交 `4e8228b`；在文档仓库执行 `git -c core.quotePath=false ls-tree -r --name-only 4e8228b` 查找旧路径，再用 `git show 4e8228b:旧路径` 查看原文。旧 `.draft` 原文保留在主软件 Git 历史，对应需求已整理到文档仓库的 2026-06-24 和 2026-06-29 目录。过时内容通过 Git 历史查阅，不另存完整归档副本。

查找旧草稿时，在主软件根目录执行 `git log --all -- .draft/`，找到包含所需文件的历史提交后，用 `git show <历史提交>:.draft/<文件名>` 阅读。如果定位到的是删除提交，应查看它的父提交 `<删除提交>^`，并可用 `git ls-tree -r --name-only <历史提交> -- .draft/` 确认文件路径。

需要临时查看服务结构时，在主软件根目录执行 `npm --prefix tests run architecture:services:inventory`，只输出到终端。
