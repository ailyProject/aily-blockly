# Project Data 通用大值与 Generator Runtime 隔离修复方案

> 历史阶段记录（2026-08-04）：本文保留当时的修复范围与验收状态；当前实施状态及真实 Electron 验收以 [主线方案](abs-unified-syntax-landing-plan.md) 第 10、11 节为准。
>
> 适用仓库：`aily-blockly`
> 约束：`aily-blockly-libraries` 保持只读；不依赖具体库名、积木类型或字段名

## 1. 问题与根因

部分旧项目在打开时抛出：

```text
ProjectDataError: Project contains oversized inline field value(s).
```

当前 Project Data 已实现内容寻址 Store、`utf8-v1`、`canonical-json-v1`、专用动画 Codec 和超限扫描，但通用 Text/JSON Codec 没有接到 Blockly 持久化边界。结果是：

- 专用动画、图片字段可以保存紧凑引用；
- 普通字符串、数组和对象超过 32 KiB 时只会被扫描器拒绝；
- `project.abi`、`project.abs` 仍可能包含几十万字节的单字段或单行；
- Markerless 项目的已知动画可以迁移，未知大文本不能迁移；
- Project Data 校验失败发生在 Generator iframe 已激活之后，失败分支没有完整回收半加载 Runtime。

`field_multilinetext` 的实现和注册位于主程序
`src/app/editors/blockly-editor/components/blockly/custom-field/field-multilineinput.ts`，
库只通过 `block.json` 引用注册名。它不是某个库私有字段，但仅修补这一种字段类型仍不能覆盖未来新增的字符串字段、自定义 JSON 字段或 `extraState`。

## 2. 核心决策

采用两层策略：

1. **专用 Data Slot 优先。** 动画、图片、位图等继续使用现有 compact state 和专用 Codec，只外置其 Payload 子树。
2. **通用持久化兜底。** 对 `fields` 与 `extraState` 的直接值进行统一扫描；纯字符串、数组或普通 JSON 对象超过 32 KiB 且不含现有 `AilyDataRef` 时，将完整值外置。

通用外置不把引用直接交给未知 Blockly Field 或只读库 Generator。持久化文档使用统一 Envelope，进入 Blockly 工作区前由主程序还原原始值：

```ts
interface AilyProjectDataValue {
  $ailyProjectDataValue: {
    schemaVersion: 1;
    ref: AilyDataRef;
  };
}
```

Codec 选择：

| 原始值 | Codec | Storage |
| --- | --- | --- |
| 字符串 | `utf8-v1` | `raw-v1` |
| 数组、普通对象 | `canonical-json-v1` | `raw-v1` |

`raw-v1` 作为 v1 固定存储编码，保证 ABI、ABS 往返时相同逻辑值产生相同引用。后续如引入压缩策略，需要版本化并调整引用保持校验。

## 3. 为什么不按字段类型做特例

主程序不能可靠预测未来库会新增哪些字段类型，也不能要求只读库认识 `AilyDataRef`。因此：

- 不建立 `custom_code.CODE` 白名单；
- 不以库包名判断；
- 不只装饰 `field_multilinetext`；
- 不把引用直接传给未知字段的 `loadState()`；
- 不在 Generator 中增加库特定分支。

只要字段的持久值是字符串、数组或普通 JSON 对象，通用边界都能无损外置并在消费前还原。包含已有资源引用的复杂状态不会被整体二次外置，避免 GC 看不到嵌套资源；这类值继续要求专用 Data Slot。

## 4. 数据流

### 4.1 ABI 保存

```text
Blockly workspace serialization
  -> clone project document
  -> dedicated compact fields remain unchanged
  -> externalize oversized generic fields/extraState
  -> flush ProjectDataStore
  -> oversized-inline assertion
  -> reference validation
  -> atomic project.abi write
```

### 4.2 项目加载

```text
read project.abi
  -> validate marker / migrate known legacy payloads
  -> externalize remaining generic oversized values
  -> validate all references
  -> atomically persist normalized external document
  -> clone and materialize generic Envelopes
  -> normalize Blockly document
  -> load workspace
```

持久化文档保持 external-only；Blockly Field 和只读库 Generator 始终看到原来的字符串/数组/对象契约。

### 4.3 ABS 导出与导入

- 导出：工作区序列化后先通用外置，再执行 ABI→ABS；ABS 只保存小型结构化 Envelope。
- 导入：先校验 ABS 中全部引用，再还原通用 Envelope，最后创建 Blockly Block。
- 导入保存：重新外置相同值，必须产生相同内容寻址引用，并继续执行 dropped-ref 校验。

## 5. Generator Runtime 隔离约束

通用值在进入工作区前已经还原，因此 Generator Runtime 不需要知道通用 Envelope，也不访问父页面 `window.Arduino`。

必须保持：

- 专用 Project Data Generator 包装仍安装在当前项目 iframe Runtime 的 `loadGenerator()` 边界；
- 异步外置/还原受 Project Data session guard 保护；
- 项目加载失败时销毁当前 Generator Runtime、workspace 和库注册状态，不能把半加载 session 留给下一个项目；
- 失败清理顺序仍遵循 workspace dispose → host checkpoint restore → iframe remove。

## 6. 错误与安全边界

- 通用外置只处理 JSON 可序列化值；循环对象、非普通原型、非有限数值继续明确失败。
- 值中包含 `AilyDataRef` 时不得整体外置，防止资源引用被藏进另一个资源而逃离 GC Roots。
- Envelope 必须严格校验唯一键、schema、Codec 与 logical type。
- 资源缺失、损坏、Codec 不匹配或项目 session 切换必须阻断加载/保存。
- UI 错误需显示块类型、字段名、JSON Pointer、实际大小和阈值。

## 7. 实施清单

- [x] 定义并校验通用 Project Data Value Envelope。
- [x] 实现通用 externalize/materialize 模块及纯函数测试。
- [x] 旧 ABI 加载和一次性迁移脚本接入通用外置。
- [x] 正常项目保存接入通用外置。
- [x] ABS 导入/导出接入外置与还原。
- [x] 直接 ABI 编辑/重新加载工具接入相同边界。
- [x] 修复同步未保存状态比较。
- [x] 项目加载失败执行 Runtime 隔离清理并输出结构化诊断。
- [x] 使用 `moniqi_709437(1)` 的副本完成迁移、资源引用及 ABI→ABS→ABI 离线验收。
- [x] TypeScript 应用配置检查、Project Data 测试类型检查与 Angular development build 通过。
- [ ] 在 Electron 界面内重新打开原项目，确认 Blockly 显示与最终 C++ 代码逐字节一致。
- [ ] 修复仓库现有全量 Karma 测试入口后运行浏览器测试；当前入口会先被无关的缺失模块和旧测试编译错误阻断。

## 8. 验收标准

1. `custom_code.CODE` 只是验证样本，生产代码中没有该积木或字段名特例。
2. 任意字符串字段超过 32 KiB 后，ABI/ABS 不再内联完整值。
3. 任意纯 JSON 数组/对象字段超过 32 KiB 后可无损往返。
4. 小值格式和现有专用动画/图片 compact state 不变。
5. 库 Generator 获得的字段值与改造前类型和值一致。
6. ABI→ABS→ABI→Blockly 后大值逐字节/逐结构相同。
7. Agent 编辑 ABS 时不再跨越几十万字节单行寻找正常代码。
8. 加载失败后不存在活动的半加载 Generator iframe session。

## 9. 已执行结果（2026-08-04）

### 9.1 日志与样本定位

`D:\codes\aily-lex\logs\log.log` 中的失败发生在
`assertNoOversizedInlineValues()`。对原始
`C:\Users\LENOVO\Documents\aily-project\moniqi_709437(1)\project.abi`
只读扫描后确认只有一个超限值：

| 块类型 | 字段 | 类型 | UTF-8 大小 |
| --- | --- | --- | ---: |
| `custom_code` | `CODE` | string | 230,618 bytes |

这只是复现样本；通用实现中不存在 `custom_code`、`CODE`、库名或
`field_multilinetext` 的判断。

### 9.2 样本副本离线迁移

- 原 ABI：263,371 bytes。
- 迁移后 ABI：33,036 bytes。
- 生成一个 `utf8-v1` / `raw-v1` 内容寻址资源，`rawLength` 为 230,618 bytes。
- 资源 ID：`sha256:cbd7fb758952d003124e1a86fa5c1b53f9ba99091679ad479cb7e3d658b7adc8`。
- 还原前后文本 SHA-256 均为
  `c2130c75eb715062832125991ef1cda44c9bdb52b904d82077914c92cd64dfcf`。
- 迁移后超限内联值数量为 0。
- ABI→ABS 后文件为 13,204 bytes，最大行长为 1,299 bytes；ABS→ABI
  后仍保留相同 Project Data 引用。

测试只修改临时副本，未改写用户原项目；应用下次打开原项目时会自动建立备份并规范化。

### 9.3 构建与测试

- `npx tsc --noEmit -p tsconfig.app.json`：通过。
- 通用 externalize/materialize 与 legacy import spec 的独立 TypeScript 检查：通过。
- `npx ng build --configuration development --no-progress`：通过。
- 独立 ABI→ABS→ABI 冒烟：通用 Envelope 完整保留，引用行保持短小。
- `git diff --check`：通过（仓库换行符提示不影响检查结果）。
- 定向 Karma 尚未执行到本次用例：Angular test builder 会先编译仓库全部测试，当前被既有的 simulator、child tool 与 Aily Chat 测试缺失依赖/旧接口错误阻断。本次没有扩大范围修改这些无关测试。
