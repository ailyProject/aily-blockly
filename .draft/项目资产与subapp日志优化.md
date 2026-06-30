原始需求：
```bash
项目中新增了.assets、.log两个目录。

【.assets】 用于存储项目使用过的静态资源，如播放动画使用原视频文件、要存入FFS的文件等. 项目开发过程中使用过,且之后还可能使用的文件;
AI要能操作这些文件，用于组织开发工作。

【.log】 用于存储各种日志信息, 包括软件在项目打开后产生的log、编译上传的log、subapp产生的log(串口工具产生的log、蓝牙工具产生log)
AI要能读取这些日志，配合开发调试；
AI采用全文本文件形式存储，日志存储路径，路径为  ./.log/<subapp>/<年月日>/<时分>，如./.log/serial-debugger/20260626/21-57.log
AI使用一个统一的工具，读取所有的log（不用给每个subapp开发一套数据获取方法），工具查询参数：来源（来自 编译/上传/subapp等）、时间段、类型（默认INFO/DEBUG/ERROR三个级别），对应日志路径。通过这种方式查询。

大部分subapp，不用再通过接口获取数据，直接通过文件获取。这样开发简单，且耦合性更低。
```

# 资产与日志目录重构计划

## Summary
- 资产根目录固定为 `<aily-blockly数据目录>/.assets/<projectId>/`，不再放在项目根目录，也不再使用 `files/` 或 `.related-files.json`。
- 所有 session / “添加上下文” 复制进来的文件和文件夹都进入同一个项目资产目录，保留原名；若已存在同名资产，则先做 hash 比对，相同则忽略，不同则自动加后缀保留两份。
- URL 资源统一落到 `.assets/<projectId>/RELATED_URLS.txt`。
- 记忆管理弹窗里，项目范围的“关联内容”面板直接显示该项目 `.assets/<projectId>/` 下的全部资产列表。
- 新增两个统一工具：`assets_tool` 查询/读取项目资产，`log_tool` 按来源、时间段、级别查询 `.log`。
- chat command process 的落盘位置迁移到 `.log`，不做旧数据迁移。

## Key Changes
- 资产存储重构
  - 用新的资产存储服务替换当前 `ProjectRelatedFileStorage` 的 `files/` + `.related-files.json` 方案。
  - 资产根目录解析为：`<aily-blockly数据目录>/.assets/<projectId>/`。
  - `projectId` 采用：优先 `package.json.cloudId`，缺失时回退项目目录名。
  - 项目级与会话级文件不再分目录、不再加前缀，所有复制文件/文件夹统一进入同一个 `.assets/<projectId>/`。
  - 导入规则固定为：
    - 不存在同名项：直接复制，保持原名。
    - 存在同名文件/文件夹：计算 hash。
    - hash 相同：忽略本次导入，不生成重复副本。
    - hash 不同：自动生成唯一后缀名，例如 `name-2.ext`、`folder-2`。
  - 文件夹 hash 采用递归内容 hash：基于相对路径、文件内容 hash、目录结构稳定排序生成目录指纹。
  - 删除 `.related-files.json` 的读写与依赖；资产列表完全通过扫描 `.assets/<projectId>/` 推导。
  - Memory Manager 与聊天输入框 Add Context 两条入口都切到这套复制逻辑。
  - 聊天资源项最终保存为复制后的 `.assets` 路径，而不是外部原始路径；这样 AI、白名单和后续读取全部统一。

- URL 资源落盘
  - URL 资源不再只存在内存态，也不再走旧 external link 元数据。
  - 所有 URL 统一追加存储到 `.assets/<projectId>/RELATED_URLS.txt`。
  - 文件格式固定为纯文本，一行一个 URL；重复 URL 按规范化后去重，相同则不重复写入。
  - 删除 URL 资源时，从 `RELATED_URLS.txt` 中移除对应行。
  - 记忆管理弹窗的“关联内容”面板要把 `RELATED_URLS.txt` 中的 URL 解析为 link 类型条目显示。
  - 聊天 Add Context 添加 URL 时，也同步写入 `RELATED_URLS.txt`，保证聊天入口和记忆管理入口一致。

- 记忆管理弹窗调整
  - “关联内容”面板不再按旧的 project/session 物理目录读取。
  - 当用户切到项目范围时，面板直接显示 `.assets/<projectId>/` 下的全部资产列表，以及 `RELATED_URLS.txt` 中解析出的全部 URL 条目。
  - 当用户在 session 范围下查看“关联内容”时，仍显示同一个项目资产池，不再做 session 物理隔离。
  - 删除操作直接作用于 `.assets/<projectId>/` 中的真实文件/文件夹，或 `RELATED_URLS.txt` 中的对应 URL 行。
  - 面板文案更新，移除 `related-files` 和旧 session 目录的暗示。

- `assets_tool`
  - 在 `child/aily-lex` 增加只读核心工具 `assets_tool`，搜索根固定为当前项目的 `.assets/<projectId>/`。
  - 工具接口固定为：
    - `action: "search" | "read"`
    - `query`：glob 查询，仅 `search` 使用
    - `assetPath`：相对 `.assets/<projectId>/` 的路径，仅 `read` 使用
    - `maxResults`
    - `encoding: "utf8" | "base64"`，默认 `utf8`
  - `search` 返回资产相对路径列表；默认包含普通文件/文件夹，也能返回 `RELATED_URLS.txt`。
  - `read` 可读取普通资产文件，也可直接读取 `RELATED_URLS.txt` 原文。
  - 实现复用 `globTool` / `globUtils` 的匹配逻辑，并同步注册到 core tools、tool settings、discovery 文案。

- 日志目录与统一日志写入
  - 统一日志路径：`./.log/<source>/<YYYYMMDD>/<HH-mm>.log`。
  - 日志文件仍为纯文本，单行格式统一为：
    - `[YYYY-MM-DD HH:mm:ss.SSS] [LEVEL] [source] message`
  - 统一来源至少包含：
    - `app`
    - `compile`
    - `upload`
    - `process`
    - 子应用 id，如 `serial-debugger`、`ble-debugger`、`network-debugger`、`mqtt-debugger`、`industrial-bus-debugger`
  - 增加通用日志写入器，供 Electron 主进程、编译/上传流程、subapp backend 统一调用。
  - `electron/logger.js` 在项目打开后写入当前项目 `.log/app/...`；项目未打开前可保留全局 fallback。
  - 编译/上传输出在现有 stdout/stderr 汇总点追加日志落盘；子应用通过统一 helper 写到各自 source 目录。

- `log_tool`
  - 在 `child/aily-lex` 增加只读核心工具 `log_tool`。
  - 工具接口固定为：
    - `source`：单个来源或来源数组
    - `from` / `to`：时间段
    - `levels`：默认 `["INFO","DEBUG","ERROR"]`
    - `maxFiles` / `maxLines`
  - 行为固定为：
    - 先按来源和时间段解析目标日志文件路径
    - 再按 `[INFO]` / `[DEBUG]` / `[ERROR]` 过滤文本行
    - 返回命中文件、统计摘要和裁剪后的日志片段
  - 不为各 subapp 单独做读取接口，统一通过 `log_tool` 查询。

- Process 存储迁移到 `.log`
  - chat command process 的 `.log` 输出与 `.json` 元数据从 `.chat_history/.../process` 迁移到项目 `.log/process/<YYYYMMDD>/`。
  - 文件命名固定为：
    - 日志：`<HH-mm>-<processId>.log`
    - 元数据：`<HH-mm>-<processId>.json`
  - 保留 `.json` 元数据，因为进程列表、详情窗口、恢复逻辑仍依赖结构化摘要。
  - 更新所有 process 相关入口：写入、枚举、恢复、详情窗口打开输出文件、删除记录。
  - 不做历史数据迁移，也不回读旧路径。

## Public APIs / Interfaces
- 新工具 `assets_tool`
  - `assets_tool({ action, query?, assetPath?, maxResults?, encoding? })`
  - 作用域固定为 `<aily-blockly数据目录>/.assets/<projectId>/`
- 新工具 `log_tool`
  - `log_tool({ source, from, to, levels=["INFO","DEBUG","ERROR"], maxFiles?, maxLines? })`
  - 查询根固定为当前项目 `.log/`
- URL 资源持久化
  - 固定文件：`.assets/<projectId>/RELATED_URLS.txt`
  - 固定格式：一行一个 URL
- 资源附件内部表示
  - 文件/文件夹保存复制后的资产路径
  - URL 保存为 `RELATED_URLS.txt` 中的条目
  - 不再依赖 `.related-files.json`
- process 持久化路径
  - 输出与元数据文件统一迁入 `.log/process/...`

## 人工测试脚本
- 添加同一个文件两次，只保留一份资产。
- 添加同名但内容不同的文件，自动生成 `-2` 后缀副本。
- 添加同一个文件夹两次，只保留一份资产。
- 修改文件夹内容后再次添加，自动生成 `-2` 后缀目录。
- 添加 URL 后会写入 `.assets/<projectId>/RELATED_URLS.txt`。
- 重复添加同一个 URL 时，`RELATED_URLS.txt` 不会重复写入。
- 从记忆管理弹窗删除 URL 时，`RELATED_URLS.txt` 中对应行被移除。
- 记忆管理弹窗项目“关联内容”显示该项目全部 assets 和全部 URL。
- 不同 session 打开记忆管理弹窗时看到同一个项目资产池。
- 从记忆管理弹窗删除资产时，同步删除 `.assets/<projectId>/` 中的真实文件。
- 聊天 Add Context 添加后的资源路径指向 `.assets/<projectId>/`。
- `assets_tool` 可以搜索到项目 assets 中的文件、文件夹和 `RELATED_URLS.txt`。
- `assets_tool` 可以读取文本资产、二进制资产和 `RELATED_URLS.txt`。
- 打开项目并执行常规操作后，会生成 `.log/app/...` 日志文件。
- 编译和上传后，会分别生成 `.log/compile/...` 与 `.log/upload/...` 日志文件。
- 打开 subapp 并操作后，会生成对应 `.log/<subapp>/...` 日志文件。
- `log_tool` 按来源查询时，只返回对应来源日志。
- `log_tool` 按时间段和 ERROR 级别查询时，只返回匹配日志。
- 聊天长命令执行后，会在 `.log/process/...` 下生成 `.log` 和 `.json`。
- 进程管理器能打开、读取和删除新的 process 日志文件。

## Assumptions
- `<aily-blockly数据目录>` 解释为应用数据根目录，即当前运行时使用的 app data / `AILY_APPDATA_PATH` 对应目录。
- `projectId` 采用 `package.json.cloudId ?? basename(projectPath)`。
- `RELATED_URLS.txt` 中 URL 去重按规范化字符串比较。
- 不做旧 `files/`、`.related-files.json`、`.chat_history/.../process` 的迁移与兼容回读。
