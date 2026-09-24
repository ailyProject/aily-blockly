# Issue #710 项目加载失败排查

日期：2026-09-24。问题链接：https://github.com/ailyProject/aily-blockly/issues/710

## 结论

尚未完整复现报告者在 Windows 0.9.100-cn 上的项目加载失败，因此本轮没有修改产品源码。已经通过本地实验确认深层 JSON 的 Worker 回传、受限栈下的 JSON 深拷贝、Blockly 原生长连接链加载均存在爆栈路径，但不能把其中任何一个直接认定为 #710 的现场根因。

当前源码和 `v0.9.100` 标签源码均能在本机 Electron 加载留存样本的全部 7,765 个积木、准备保存数据并生成代码。真实故障版本的项目文件及失败调用栈仍是缺失证据。

## 现场信息与样本

- issue：Windows、0.9.100-cn、Arduino 模式、ESP32P4 Core Board、22 个直接依赖。
- 截图项目名：岩石测量装置。工作区和工具箱为空，页脚停在“正在加载 Blockly 程序”。这将排查范围缩小到库加载之后的 ABI 解析、项目数据准备、原生工作区还原及加载后快照阶段。
- 当前失败：2026-09-23T11:01:28Z，`RangeError: Maximum call stack size exceeded`，没有调用栈。
- 附带的 `RendererGone/killed` 发生在 2026-09-18，比当前失败早 5 天；不能据此认定为当前 GPU、内存不足或进程崩溃问题。
- 本地样本：`/Users/downey/Documents/aily-user-project/project_aug30a`。名称、开发板、依赖数量与 issue 一致，但 ABI 修改时间为 2026-09-16T06:04:16.496Z，不能认定与 9 月 23 日现场文件相同。
- ABI：871,273 字节，7,765 个积木、320 个变量、3 个根块；最长连续 next 链 994，语法输入嵌套深度 8，JSON 容器深度 2,271。连续语句链在 ABI 中也表现为嵌套对象；不能只看视觉上的 if/loop 嵌套层数。
- ABI SHA-256：`bf63caeca0330b09c7995038b3e152f782064ccc131c7db8c8858ed7eba1455c`。

原项目只读。测试没有操作设备，没有改写原 ABI，也没有把项目内容发送到外部服务。

## 本地测试

环境：macOS，Electron 35.7.5 / Chromium 134.0.6998.205 / V8 13.4，实际安装的 `aily-project-blockly@1.0.2`。源码分别为当前 `759e5780` 和 `v0.9.100`（`2a7c3ec4`）。

使用隔离 Electron BrowserWindow 执行源码加载探针：实际项目 board.json、21 个积木库的 block.json / generator.js / i18n、生成器隔离运行域、项目数据归一化、`BlocklyService.normalizeProjectAbiForLoad`、`loadProjectDocument`、原生 SVG 工作区、保存快照及代码生成。项目文件接口不写盘；Project Data store 在该无外部数据引用样本上使用空引用适配器；旧版代码生成的 addMacro 只返回成功，不写 package.json。

这验证了关键加载服务和 SVG 运行路径，**不是整个主客户端 UI 打开流程、Windows 安装包或编译/烧录验收**。两版源码使用同一批本地已安装的积木库，并非恢复所有依赖的历史发布内容。

| 用例 | 结果 |
| --- | --- |
| 当前源码，默认 Electron 栈 | 加载 7,765 块；保存快照 7,765 块，全部 ID 保持；生成 181,380 字符代码 |
| v0.9.100 源码，默认 Electron 栈 | 同上 |
| 原项目主线程 JSON.stringify / structuredClone | 通过 |
| 原项目，实际 project-abi-parser.worker | JSON.parse 后 postMessage 爆栈，报 DedicatedWorkerGlobalScope 的结构化克隆错误 |
| 当前源码，显式 `--stack-size=984` / `768` | 项目数据归一化、原生加载及代码生成通过 |
| 当前源码，显式 `--stack-size=512` | JSON.stringify 深拷贝爆栈，停在 migrateLegacyShadowIdentities；该参数仅为压力实验，不代表 Windows 实际栈配置 |
| 原生 Blockly，500/1,000/1,500/2,000 个连续语句（Node 24，无渲染） | 加载通过 |
| 原生 Blockly，3,000 个连续语句（同上） | RangeError，栈反复进入 appendPrivate → loadNextBlocks → loadConnection → appendPrivate |
| 日志字符串化 | Error 原对象有 stack；现有 args.join('\n') 只保留名称和消息，丢失栈帧 |

## 可能原因排序与证据边界

### 1. 长连接链触发原生 Blockly 递归耗尽：重点候选

`loadProjectDocument → loadActivePageIntoWorkspace → loadWorkspaceJson → loadBlocklyWorkspace → serialization.workspaces.load` 最终进入仍为递归实现的 `appendPrivate / loadNextBlocks / loadConnection`。已在 3,000 个连续语句的独立压力用例中取得重复递归调用栈。

样本的连接结构确实很深，但其 994 长度在本机正常加载。现场项目可能增加了连接长度，也可能有不同的原生线程栈或库回调开销；这些都是待验证条件，不是已证实事实。没有固定的“积木总数上限”，压力用例阈值也不能作为产品限制。

### 2. 深层 JSON 的克隆/跨线程传输：已复现，但不足以解释本次致命失败

`project-abi-parser.worker.ts` 在 JSON.parse 后回传完整对象，postMessage 位于 try/catch 之外。样本在 Electron 的 Worker 回传阶段可以稳定出现结构化克隆栈溢出。

不过 `BlocklyEditorComponent.parseProjectAbiContent` 已对 Worker 的非语法错误回退到主线程 JSON.parse（578–591 行，onerror 在 629–632 行），本地后续加载成功。因此不能只修 Worker 就宣布 #710 已解决。单纯改成 structuredClone 也不能作为深层数据的通用解法。

项目准备和页面模型还多次使用 `JSON.parse(JSON.stringify(...))`，受限栈实验确实失败，但 512 KB 是人为测试参数；报错点还位于当前版新增的身份迁移代码，不能反推到旧版现场。

### 3. 自定义积木回调递归或运行上下文差异：未排除

原生加载会调用各库的 init、loadExtraState、field.loadState 等逻辑。不同版本的库或现场新增字段值可能引发重入。当前样本的实际库组合加载成功，尚无具体异常栈支持这一归因。22 个依赖本身不能证明存在循环依赖。

### 4. 日志丢栈使后续归因困难：已确认

`blockly.component.ts` 的 console.error 包装器使用 `args.join('\n')` 生成 notice detail（793、797 行），把 Error 转成单行字符串。由此能得到与 issue 一致的 `加载项目失败   RangeError: Maximum call stack size exceeded`，而没有原始栈。

同一包装器还是箭头函数，却把 `arguments` 传给 originalError（787 行），拿到的并非本次错误的参数。此处是诊断信息缺失问题，不能当作业务加载爆栈的已确认原因。

## 修复方案

1. **先恢复可定位的失败证据。** 加载链路记录阶段、库名（适用时）、完整 `error.stack`，并将阶段及经过路径脱敏的栈放入反馈日志。错误转发使用显式 `[message, ...args]`；不要只依赖 Error.toString()。这能区分 JSON clone、原生反序列化、库回调和加载后保存。
2. **若现场栈命中原生加载递归，修正所用 Blockly 分支的遍历。** 将 next/输入装载改成显式任务栈，保留父连接先于字段加载、extraState、字段顺序、shadow 默认值、子块初始化完成顺序及事件嵌套计数。覆盖项目打开、页切换、恢复快照和 ABS 的共同原生入口。不能只换用现有 ABS 分片装载器或在 node_modules 临时打补丁后宣称已修复。
3. **若现场栈命中 JSON 深拷贝，统一替换对应持久化链路。** 使用可处理深层 JSON 的显式遍历复制/序列化，严格保持数组、原型键、非法值、循环检测及既有 JSON 语义；同时覆盖归一化、页面合成和保存，避免只推迟到下一个 clone 才失败。
4. **Worker 做明确可恢复的回传失败协议。** 把对象回传错误和 JSON 语法错误分开，只让回传错误触发主线程回退；避免产生误导性未捕获异常。保留语法错误的明确失败，防止吞掉真正的损坏文件。
5. **最终验收**：现场 ABI + package.json / 锁文件 / 本地库，在 Windows 0.9.100-cn 和修复版重复打开、切页、保存、重新打开；核对块 ID、连接、shadow、字段值和代码输出，再测实际界面交互。当前证据不足以跳过这一步。

不建议把加大 JS 堆内存、重装依赖或删除用户积木作为该问题的直接修复。调用栈和堆内存是不同的限制。

## 本地证据

持久化测试输出位于 `test-results/issue-710-20260924/`（git ignored）：

- `electron-current-final.log`、`electron-v100-final.log`：最终完整探针输出。
- `electron-current-default.png`、`electron-v100-default.png`：两个版本的 SVG 加载结果。
- `electron-512.log`、`electron-768.log`、`electron-984.log`：显式栈预算的实验结果。
- `native-chain.cjs`、`native-chain.log`：原生长链加载复现脚本和包含重复递归的栈。
- `harness.ts`、`prepare.cjs`、`server.cjs`、`electron.cjs`：本次本地探针；临时构建及样本数据位于 `/tmp/aily-issue710-gl3Ydi`，没有提交用户项目内容。

继续定位最需要的是 **9 月 23 日失败时的项目副本**，或在该机器捕获一次 `加载项目失败` 原始调用栈。目前只有同名的 9 月 16 日本地样本，尚不满足“完整复现并确认该 issue 根因”的直接修复条件。
