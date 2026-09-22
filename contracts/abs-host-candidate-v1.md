# ABS Host Candidate v1

状态：第十六批接入当前 legacy 生产路径。依赖 [Host Projection v1](D:/codes/aily-blockly/contracts/abs-host-projection-v1.md) 的认证宿主桥接，不是 ABS v2/map，也不是完整身份合并协议。

## 1. 两类证据不能混用

`abs_projection` 证明当前已保存活动页的投影；`abs_validate` 必须证明调用方提供的**候选文本**。用户候选不因当前工作区能导出就自动有效。`abs_apply` 还必须验证候选实际装载后的请求状态，以及随后真实保存的 ABI/ABS 字节。

验证不装载积木、不改 ABI/ABS，但通用大值准备可以生成不可变资源。应用会替换活动工作区；目前仍不是完整基线/map 合并，不能承诺保留 ABS 中没有表达的旧身份和属性。

## 2. 验证请求

通过既有认证 RPC 调用 `abs_validate`，params：

```text
version: 1
requestId: 每次请求独立生成的 UUID
expectedAbiHash: sha256:...（物理 ABI 精确字节）
candidateHash: sha256:...（完整输入 ABS 的 UTF-8 字节）
abs 或 absPath: 二选一
```

Agent 先捕获物理工程根身份和 ABI 字节，文本在整个请求内不改写。大于 256 KiB 的候选，或显式文件/分片选项，使用新建临时目录固定候选文件；请求结束只清理本次目录。不写回用户源文件，也不修改布尔枚举以兼容旧宿主。

宿主在既有工程 FIFO 中执行：flush pending → 固定完整文档 revision 与 ABI 原文 → 核对输入/源哈希及内存已保存 → 共用候选解析/资源准备/还原 → 再次核对上下文、revision、源字节。未知类型警告、解析错误、缺失/损坏资源及无法可靠定位的大值替换均失败。

`ok:true` 响应携带 operation/project、候选块计数及 receipt：

| receipt 字段 | 内容 |
| --- | --- |
| version / requestId / project | 协议、请求标识、实际工程根 |
| scope | pageId、contextEpoch、workspaceRevision |
| source.abiHash | 请求指定的已保存源版本 |
| candidate.hash / bytes | 输入 ABS 精确 SHA-256 和 UTF-8 字节数 |
| validation | `{ok:true, scope:"legacy-syntax-and-project-data"}` |

contextEpoch 在项目切换，以及所观察到的工作区、页面、Generator 或 Project Data session 替换时失效；同一 Generator 内开发板配置、库注册和库 i18n 更新也使其失效。进行中的操作逐次比较实际实例与运行时配置 revision，不只依赖数字 epoch。

## 3. 应用请求与二次核对

`abs_apply` params 提供同一完整 `abs`/`absPath`，`validation` 为上述回执，可选 `chunk:true`。缺少回执的旧 RPC 请求在修改工作区前拒绝；图形界面的既有本地导入不受该 RPC 形状约束，但共用候选准备模块。

回执不是可跳过验证的授权票据，也不需要跨调用全局缓存。宿主进入同一 FIFO 后重新检查已保存状态，在编辑租约内验证项目、scope、ABI 哈希、候选哈希/字节数；再用相同模块解析和验证资源，不接受已经变化的候选或基线。

通过既有普通/分片 loader 装载，并保留独立候选副本用于 `assertAbsRequestedState`。原生库 loadState 修改其参数不能污染比较基准。实际读回不满足请求时走既有条件恢复/隔离路径，不以块数相近代替结构检查。

装载后、最终读回前，在相同编辑租约内完成一次同步 Generator 准备。库的必要模型注册在该阶段发生，随后重新核对候选字段、连接、变量及共享引用，才固定实际 revision。允许库添加运行时默认模型，不允许改变或丢弃请求状态；不按库名或字段名豁免。

代码、生成头文件和代码映射以不可变值保留，绑定完整文档 revision、workspace/page、Generator 实例/配置版本和 Project Data session。后续保存消费这一结果，不再次执行 Generator。代码生成异常不会被当成可编译证明，也不发布部分代码/头文件；语法/资源验证入口本身不执行生成器。

## 4. 保存后的回执

ABS 镜像发布仍使用既有宿主 writer，ABI 保存仍走原项目服务。应用成功返回的本地确认闭包保留上下文、实际 revision 与发布文本；保存完成后重新进入 FIFO，核对未被修改的应用状态、已保存内存/磁盘一致性以及磁盘精确字节，然后才能形成最终 receipt。

最终回执保留原 version/requestId/project/scope/source/candidate，并增加：

```text
applied.scope: 本次实际应用的页面、contextEpoch、revision
applied.abiHash: 实际保存的 ABI 精确字节哈希
applied.absHash / absBytes: 实际发布的 ABS 精确字节
validation: {ok:true, scope:"legacy-requested-state-and-project-data"}
```

Agent 核对原候选绑定、前置 scope、应用 scope、规定的验证范围，再读取 ABI/ABS，检查物理根身份、哈希和字节数。只有全部匹配才返回 `absPersistence.verified` 和 `applyVerification.ok`。

## 5. 失败与不重放

- 无宿主、旧宿主、回执缺失/不符均不能改走 headless 转换。离线 import 的空工程能力保持独立限制。
- 超时、断连、宿主错误不自动重试，也不等待 idle 后重放导入。分片是调用前明确选择的装载模式，不是未知结果的恢复手段。
- 保存或最终证据校验失败可能发生在工作区/ABS/ABI 已改变之后；按失败或 UNKNOWN 保留现场，不宣称未写入或盲目回滚。只读验证失败不等于应用失败。
- 现有 ABS 发布与 ABI 保存仍是两个提交阶段，不保证跨文件原子可见；完整 generation 事务仍待实现。
- 异步 ABI 版本检查从固定磁盘快照按需 resolve 资源，检查等待期间的项目、runtime、revision 和源字节，不依赖同步 prepared 缓存恰好命中。

## 6. 能力边界

本协议不证明 C++ 可编译、BREAK/CONTINUE 所在业务位置合法、对象跨作用域可用或所有第三方自定义语义正确；旧 Agent 的独立语义 warnings 不再冒充宿主验证。主程序需要的语义规则应以独立共享模块继续补充，而不是复制整套 Agent converter。

完整旧 ID、deletable:false、未访问页、serializer、自定义模型、休眠 shadow 和 map/base generation 的证明仍按主执行方案继续。同步关闭窗口的未保存检查仍是既有保守路径；本批修复的是异步自动化版本校验的冷缓存遗漏。
