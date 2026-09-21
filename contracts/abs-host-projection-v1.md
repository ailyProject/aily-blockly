# ABS Host Projection v1

状态：第十五批接入现有 legacy ABS 生产路径。此协议不是 ABS v2/map v1，也不授予无损导入权限。

## 1. 职责与边界

Blockly 主程序拥有当前工作区、库定义、Project Data runtime 和镜像发布能力。Agent 不复制这些规则，只验证本次调用返回的来源、输出及落盘证据。协议通过现有已认证的 CLI bridge `abs_projection` 操作传输，不新增 HTTP 服务或事务引擎。

投影范围是**当前活动页**。回执绑定整个已保存 ABI 的字节版本，但不证明其他页面已投影，也不证明从 ABS 重建后保留所有 ID、保护属性、serializer 或自定义模型。当前 validation scope 只能是 `legacy-syntax-and-project-data`。

## 2. 请求与回执

请求 params：

```json
{
  "version": 1,
  "requestId": "随机 UUID，每次调用重新生成",
  "expectedAbiHash": "sha256:64位小写十六进制",
  "includeHeader": true,
  "publish": true
}
```

- `requestId` 接受 16～80 位字母、数字和连字符。请求进入异步队列前复制，调用方后续修改不影响已排队任务。
- `expectedAbiHash` 是 Agent 在请求前捕获的物理 `project.abi` 精确字节哈希，不是格式化 JSON 的哈希。
- `includeHeader=false` 仅去掉说明性注释，含 Project Data 时仍保留必需的 schema 头。
- `publish` 默认为 true，只允许主程序写 `project.abs`。false 返回经过相同验证的投影，但不发布镜像、不更新镜像缓存；资源准备仍可能生成不可变载荷文件。

成功响应包含 `ok: true`、`operation: "abs_projection"`、`project`、`abs` 和 `receipt`：

| receipt 字段 | 含义 |
| --- | --- |
| version / requestId / project | 协议版本、本次请求随机标识、实际工程根 |
| scope.pageId | 本次投影的活动页 |
| scope.contextEpoch / workspaceRevision | 宿主投影上下文与完整持久状态 revision；非负安全整数 |
| source.abiHash | 与请求一致的 ABI 精确字节版本 |
| output.file | 固定为 project.abs；readonly 请求也描述规范投影名，而不是调用方自定义路径 |
| output.hash / bytes | 返回 ABS 的 SHA-256 与 UTF-8 字节数 |
| output.persisted | 本次是否通过宿主发布规范 ABS |
| validation | 固定为 `{ "ok": true, "scope": "legacy-syntax-and-project-data" }` |

## 3. 宿主执行边界

1. 沿现有自动化入口检查目标工程、Blockly 编辑器及加载就绪状态，再进入 `AbsAutoSyncService` 既有工程 FIFO。不得在外层重复获取同一队列造成重入等待。
2. flush pending 之后固定项目、页面、工作区、Generator、Project Data session、完整文档 revision 以及磁盘 ABI/ABS 原文。请求 ABI 版本必须匹配；现有规范化工程快照必须确认内存已保存且与磁盘相同。
3. 使用既有 Project Data 准备与 ABI→ABS 转换。反向解析所生成文本，拒绝解析错误/警告，验证所含资源。这里只验证投影的语法和资源，不把反向解析结果装载到工作区。
4. 结构查询只读已有积木实例和静态定义。带 ID 时读取该实例的实际动态形状；不带 ID 时仅使用同类型一致的现有结构。没有证据时保留能力拒绝，不创建临时块、变量，不执行库 init，不缓存跨项目的类型结构。
5. 所有异步准备后和发布前后核对上下文/revision/ABI。发布使用已有 preload writer 的共同工程锁、预期目标版本 CAS 和提交读回，不新增裸写盘路径。

用户未应用的 ABS 外部编辑不能被覆盖。变更/冲突保留现场；提交后证据失效时不能谎称没有写入。普通非回执导出原有的已提交结果语义保持不变。

## 4. Agent 消费规则

1. 调用前捕获 ABI、ABS/自定义目标的原始字节和物理根身份，拒绝逃逸、链接及覆盖 ABI 源的输出路径。
2. 只有真正不存在 live host 时，才允许调用现有受限 headless 导出。存在宿主但不支持操作、返回失败、回执缺失/不符或传输不确定时，均不得转离线覆盖。
3. 核对 operation、协议版本、随机 requestId、工程根、源哈希、合法 scope、唯一 validation scope、输出文件名/标志/哈希/字节数。再读物理 ABI 确认精确字节与根身份未变；persisted=true 时读物理 ABS 确认与返回文本完全相同。
4. 自定义 outFile 使用 publish=false。验证回执后，以调用前捕获的目标和 ABI 源观测调用既有 `publishPreparedProjectFiles`；回执仍描述宿主 readonly 产物，实际自定义落盘证据由 publication 提供。
5. `absPersistence.verified` 只有完成上述检查后才能返回。传输/读回异常可能发生在宿主提交后，按 UNKNOWN 保守报告；不得自动回滚或覆盖第三方新内容。

## 5. 已接入入口与后续协议

已接入 `abs_export`、`project_save`、`blocks_tidy` 的投影/后置检查。保存或整理已经执行但投影失败时明确报告后置失败，不能撤销已确认的 ABI 保存。

第十六批已单独接入 [Host Candidate v1](D:/codes/aily-blockly/contracts/abs-host-candidate-v1.md)：`abs_validate`、`abs_apply` 绑定用户候选 ABS 的精确字节哈希与工程基线，不能拿当前已保存工作区投影替代候选验证。完整 ABI/ABS/map generation、身份保护往返及多页契约仍按主执行方案实施，不在这两份 legacy 回执协议内提前开启。

## 6. 本机开发链接

本机 app 下的 `@aily-project/subapp-aily-chat` 链接到 `D:/codes/aily-lex-pro/packages/aily-chat`，其 `@aily-project/aily-agent` 链接到相邻的 `packages/aily-agent`；Agent 包入口为 `dist/index.js`。更新 Agent 源码后需重建 dist 并重启对应 Chat 子应用进程，不需要为此替换已安装发布包。既有 link-dev watcher 不代表 Agent 源码热更新。本协议同时修改了 Blockly renderer/main，宿主也必须运行更新后的代码。是否已部署、是否已重启与是否已连接是三个不同的事实。
