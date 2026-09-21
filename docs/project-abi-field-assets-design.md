# Project Data Store 与 ABS/ABI 大数据外置执行方案

> 历史阶段记录（2026-07-28）：本文保留原始设计及阶段进度；当前 ABS 语法、实施状态及最终验收以 [主线方案](abs-unified-syntax-landing-plan.md) 为准。

## 0. 当前实施进度

已完成并启用：

- `AilyDataRef`、严格项目格式标记、Codec Registry、统一容器、内容寻址、Raw/Deflate、原子写入、并发合并、LRU 和项目 session 隔离；
- 保存前 32 KiB 超限内联扫描，错误包含块 ID、块类型、字段名和 JSON Pointer；
- ABI/ABS 对结构化字段使用紧凑 `@json:` 表示，引用可双向无损往返，ABS 强制 external-only 文件头；
- ABS 导入、直接 ABI 编辑和重新加载在修改工作区前执行超限值与资源完整性预检；
- TFT RGB565/RGB332 与 U8G2 XBM 动画改为 compact state，Payload 存入 `assets/project-data`；
- Image Preview、Image、U8G2 Bitmap 与 LED Matrix Image 已改为 compact state；单色 Bitmap、LED Pattern 等有界小字段已审计并继续内联；
- `aily-blockly-libraries` 保持只读；主程序在加载库定义时对内存副本统一装饰 Project Data 字段并注册 Data Slot，不要求库侧修改 `block.json`、generator 或 i18n；
- 只读库 generator 继续使用原有同步 ABI；主程序在 generator 调用边界把已 prepare 的规范 Payload 瞬态投影为旧字段值，投影不写回 Blockly、ABI、ABS、事件或 Undo/Redo；
- 解码 Worker 直接返回规范字节，不再生成 Base64 或持久化 `number[][][]`；
- 自动生成、编译、上传、Lint 和 Agent 代码生成入口统一执行异步 prepare barrier；
- 超大 variables/objects 生成片段按内容 Hash 输出到项目 `src/*.h`，构建边界将 `src` 同步到临时 Sketch，生成代码只保留 include，Source Map 同步定位到 include；
- 同项目与跨项目剪贴板支持 compact state + Resource Bundle，目标项目先校验、导入全部必需资源，再创建积木；
- 另存为会 flush、校验并复制项目资源后切换 Store session；云归档前会 flush、扫描并校验 ABI/ABS 引用；
- 已实现项目资源统计、7 天宽限期 GC（默认 dry-run）以及 Agent 诊断/手动安全清理入口；GC Roots 覆盖 ABI、ABS、当前工作区、Undo/Redo、checkpoint 和剪贴板引用；
- 资源导入/读取已按 Codec 原始长度、Stored Payload 与容器声明尺寸做前置校验，Deflate 解压使用流式输出上限；
- Agent 增加资源 inspect、文本范围读取、JSON Pointer/分页读取和 compare-and-swap 替换工具；
- 提供一次性迁移脚本 `scripts/migrate-project-data-v1.mjs`，支持旧 TFT Base64 帧和旧 U8G2 像素矩阵。
- 项目模板、项目广场和云市场复制到新目录后，会在写入 external-only 标记前执行同一套一次性导入迁移并校验引用；普通 `projectOpen` 不读取旧格式；
- ABS 导入建块时保留 `@json:` 的结构化对象值，仅对 Blockly 变量字段提取变量 ID/名称；写 ABI 前还会核对 ABS 中的全部资源引用，发现建块归一化导致引用丢失时回滚工作区并拒绝写盘。

已验证：

- 应用 TypeScript 编译和 Angular development build 通过；
- U8G2、WS2812 generator JavaScript 语法检查通过；
- 已撤回并推送库侧两次 Project Data/i18n 修改；9 个目标库目录与引入 Project Data 前的提交树一致；
- 已使用撤回后的真实库定义验证主程序运行时适配：18 个 Project Data 字段完成内存装饰，Adafruit `IMAGE_DATA` 在磁盘上仍为 `field_input`，运行时转换为资源图片字段；
- 基准项目 `project_jul13d_353995` 的 ABI 从 500,545 bytes 降至 1,611 bytes，Payload 以 374,627 bytes 的单一内容寻址资源保存，ABI 体积下降约 99.7%。

尚待联调/验收，不再包含功能性实施项：

- 在实际 UI 中逐项执行编辑、取消、Undo/Redo、跨项目复制、缺失/损坏资源提示和另存为回归；
- 执行固定硬件样本的 TFT/U8G2/LED Matrix 生成字节与固件显示效果对照；
- 补齐保存耗时、首屏、代码生成、峰值内存和事件体积的性能基线；
- 清理仓库现有无关失效 spec 后恢复完整 Karma 测试。目前 Angular test builder 会先编译全部 spec，无法仅运行新增 focused spec。
> 适用仓库：`aily-blockly`
>
> 目标格式：新的内部项目格式，不兼容旧版内联大数据格式
> 核心决策：ABS/ABI/Blockly 持久状态只保存结构、元数据和 `AilyDataRef`，大型 Payload 由项目级 `ProjectDataStore` 管理

## 1. 执行摘要

当前 Blockly 字段会把动画帧、位图像素、Data URL、大数组和长文本直接放进字段值，随后这些值会同时进入：

- Blockly `Field.value_`；
- Blockly 序列化结果；
- `project.abi`；
- `project.abs`；
- Blockly 变更事件和 Undo/Redo；
- 工作区克隆、Minimap、切页和未保存检查；
- 代码生成中间字符串。

这不是单纯的 ABI 文件体积问题，而是“大型 Payload 被当作普通字段值在所有链路中复制”的架构问题。

本方案采用结构与数据分离：

```text
Blockly compact state / project.abi / project.abs
                    │
                    └── metadata + AilyDataRef
                                      │
                                      ▼
                           ProjectDataStore
                                      │
                         assets/project-data/
                                      │
                         content-addressed blob
```

必须同时满足以下结果：

1. `project.abi` 和 `project.abs` 中不再内联大型字符串、数组和二进制派生数据。
2. Blockly 字段规范值、变更事件和 Undo/Redo 中不再携带完整大型 Payload。
3. ABS 与 ABI 转换器只转换引用，不读取、解码或写入资源。
4. 预览、编辑和构建通过统一运行时按需加载资源。
5. 新的大数据功能通过注册 Codec 或通用 JSON/Text Codec 接入，不再各自实现文件管理。
6. 保存、复制、另存为、云同步、Agent 编辑、资源校验和垃圾回收形成完整闭环。

## 2. 当前问题与基准样本

基准项目：

```text
C:\Users\LENOVO\Documents\aily-project\project_jul13d_353995
```

该项目的 TFT 动画数据为 13 帧、120×120、RGB565：

| 项目 | 当前大小 |
| --- | ---: |
| `project.abi` | 500,545 bytes |
| `CUSTOM_ANIMATION` JSON | 约 499,488 chars |
| Base64 帧总长度 | 499,200 chars |
| 原始 RGB565 帧字节 | 374,400 bytes |
| `.temp/sketch/sketch.ino` | 1,532,655 bytes |
| 原始 MP4 | 1,011,174 bytes |

单个动画字段占 ABI 约 99.8%。当前字段还会执行以下高成本操作：

- 更新时克隆全部帧；
- 关闭编辑器时对完整值执行 `JSON.stringify()` 比较；
- 变更事件同时携带完整旧值和新值；
- 保存、ABS 导出和未保存检查重复遍历完整工作区；
- 生成器把 Base64 解码后展开为更大的 C/C++ 文本数组。

U8G2 动画使用 `number[][][]` 保存 1 bit 像素，JSON 结构开销比 Base64 更严重。因此，动画只是首个样本，方案必须覆盖所有大型文本、数组、对象和二进制数据。

## 3. 范围与非目标

### 3.1 本次范围

- 通用 `AilyDataRef` 数据模型。
- 项目级 `ProjectDataStore`。
- 内容寻址、压缩、完整性校验和原子写入。
- 通用 Text、JSON、Binary Codec。
- TFT、U8G2、Bitmap、Image Preview 等类型专用 Codec。
- Blockly Resource-backed Field 运行时模型。
- ABI 保存和加载。
- ABS 双向转换及 Agent 资源操作。
- Minimap、切页、复制粘贴、另存为、云同步。
- 编译前资源准备和生成器接入。
- Dirty State、缓存、错误处理和 GC。
- 单元、集成、故障注入和性能验收测试。

### 3.2 明确不兼容旧格式

旧格式尚未发布，本方案不在正式运行时代码中保留以下能力：

- 不读取旧版内联动画帧和大型字段数据。
- 普通项目打开和正式 ABI 读取不自动迁移旧版字段结构。
- 不提供“完整内联 ABI”兼容导出。
- 不让 `saveState(true)` 重新内联大型 Payload。
- 不为旧版应用保留双写或格式协商。

需要保留的内部样本可使用一次性开发脚本转换，或者重新导入源资源。对尚未发布、但已存在于模板/项目广场/云市场中的内部样本，可在“复制为新本地项目”的导入边界调用同一迁移器；迁移完成并通过资源校验后才写入 external-only 标记。迁移器不得进入普通 `projectOpen`/ABI 加载链路，也不得形成双格式运行时兼容。

### 3.3 第一阶段非目标

- 不引入 SQLite、单文件资源数据库或远程对象存储。
- 不将每一帧拆成独立文件。
- 不把资源放入 `.temp` 或隐藏目录。
- 不把同步 Blockly Generator 全量改造成异步 Generator。
- 不要求第一阶段支持资源增量流式编译。
- 不立即实现复杂的跨项目资源网络传输协议；先完成本地 Clipboard Blob Bundle。

## 4. 架构原则与硬约束

以下约束作为实现和 Code Review 的强制标准。

### INV-001：结构与 Payload 分离

ABS、ABI 和 Blockly 持久状态只允许保存：

- 程序结构；
- 小型字段值；
- 可供 Agent 理解的元数据；
- `AilyDataRef`。

大型 Payload 只能存放在 `ProjectDataStore` 或受控的瞬态编辑缓冲区中。

### INV-002：字段规范值必须紧凑

Resource-backed Field 的 `value_`、`getValue()`、`saveState()` 和 Blockly 变更事件值必须是紧凑状态，不能返回完整 Payload。

错误示例：

```ts
field.value_ = {
  width: 120,
  height: 120,
  frames: ['base64...', 'base64...'],
};
```

正确示例：

```ts
field.value_ = {
  schemaVersion: 1,
  width: 120,
  height: 120,
  frameCount: 13,
  frames: {
    $ailyData: {
      schemaVersion: 1,
      id: 'sha256:...',
      codec: 'tft-rgb565-be-frames-v1',
      storage: 'deflate-raw-v1',
      rawLength: 374400,
      storedLength: 126482,
    },
  },
};
```

### INV-003：资源文件不可变

资源 ID 基于内容 Hash。修改 Payload 必须生成新资源和新引用，禁止覆盖已有 Hash 文件。

### INV-004：先提交资源，再提交引用

任何持久状态只有在资源文件成功原子写入后，才能引用该资源。失败允许留下未引用文件，但不能产生指向不存在资源的 ABI。

### INV-005：转换器保持纯函数

`convertAbiToAbs()` 和 `convertAbsToAbi()` 不允许：

- 读取资源文件；
- 解压或解码 Payload；
- 写入项目目录；
- 隐式修复丢失资源。

### INV-006：未知大值不得静默内联

ABI Repository 保存前必须扫描大值。未注册且超过阈值的字段或 `extraState` 必须返回带 JSON Pointer、块 ID 和字段名的诊断错误，不能静默写入大型 ABI。

### INV-007：资源缺失不得归一化为空

资源缺失、损坏、Codec 不支持或超限时必须保留原引用并进入错误状态。禁止把字段自动改为空数组、空文本或默认图片后继续保存。

### INV-008：Blockly 库保持只读

`aily-blockly-libraries` 不声明 Project Data 存储策略，也不因主程序的持久化实现修改 `block.json`、generator 或 i18n。主程序必须在库定义的内存副本上注册 Data Slot，并在 generator 调用边界提供兼容投影。兼容投影只允许存在于单次同步代码生成调用中，不得进入字段规范值、序列化、ABI、ABS、Blockly 事件或磁盘缓存。

## 5. 术语与分层

### 5.1 术语

| 名称 | 含义 |
| --- | --- |
| Payload | 体积较大的逻辑数据，例如文本、帧数组、位图、图片字节 |
| Metadata | 尺寸、格式、帧率、数量等轻量信息 |
| `AilyDataRef` | 指向项目数据资源的紧凑引用 |
| Codec | 逻辑值与规范字节之间的双向编码规则 |
| Storage Encoding | 对规范字节进行的磁盘压缩方式 |
| Data Handle | 运行时引用、加载状态和缓存句柄 |
| Data Slot | 一个允许持有 `AilyDataRef` 的字段或 `extraState` 位置 |

### 5.2 分层

```text
ProjectDataStore                 通用存储、Hash、压缩、I/O、缓存
    ↑
ProjectDataRuntime               当前项目上下文、Handle、并发与生命周期
    ↑
Blockly Data Adapter             字段、extraState、Minimap、Clipboard
    ↑
ABI Repository / ABS Converter   紧凑持久化与文本转换
    ↑
Builder / Agent Tools            按用途解析数据
```

存储层不得依赖具体 Blockly 字段类型。字段适配层不得自行拼接路径、计算 Hash 或直接调用 `window.fs`。

## 6. 通用引用模型

### 6.1 TypeScript 类型

```ts
export type AilyDataLogicalType = 'text' | 'json' | 'binary';
export type AilyDataStorageEncoding = 'raw-v1' | 'deflate-raw-v1';

export interface AilyDataRef {
  readonly $ailyData: {
    readonly schemaVersion: 1;
    readonly id: `sha256:${string}`;
    readonly logicalType: AilyDataLogicalType;
    readonly codec: string;
    readonly storage: AilyDataStorageEncoding;
    readonly rawLength: number;
    readonly storedLength: number;
  };
}
```

引用中不保存文件路径。资源路径只能由合法 ID 和固定项目资源目录推导。

### 6.2 引用校验

实现必须验证：

- 对象只能使用受支持的 `$ailyData` 引用结构；
- `schemaVersion` 必须受支持；
- ID 必须匹配 `sha256:<64 lowercase hex>`；
- `logicalType`、`codec` 和 `storage` 必须在注册表中；
- `rawLength`、`storedLength` 必须为安全范围内的非负整数；
- 容器中的 Stored Payload 长度必须与 `storedLength` 一致；
- 文件总长度必须等于 Magic、HeaderLength、Header 和 Stored Payload 的长度之和；
- 解压后长度必须与 `rawLength` 一致；
- 重新计算的 Hash 必须与 ID 一致。

### 6.3 Metadata 必须内联

Agent 和 UI 经常需要理解数据语义，但不需要读取 Payload。因此尺寸、格式、帧数等信息应留在父级状态中。

TFT 动画示例：

```json
{
  "schemaVersion": 1,
  "format": "rgb565",
  "encoding": "rgb565-be",
  "width": 120,
  "height": 120,
  "fps": 10,
  "maxFrames": 130,
  "frameCount": 13,
  "frames": {
    "$ailyData": {
      "schemaVersion": 1,
      "id": "sha256:83a5...",
      "logicalType": "binary",
      "codec": "tft-rgb565-be-frames-v1",
      "storage": "deflate-raw-v1",
      "rawLength": 374400,
      "storedLength": 126482
    }
  },
  "sourceName": "demo.mp4",
  "sourceType": "video/mp4",
  "sourcePath": "assets/tftespi-animation/source.mp4"
}
```

大文本示例：

```json
{
  "schemaVersion": 1,
  "language": "plain-text",
  "charCount": 186000,
  "content": {
    "$ailyData": {
      "schemaVersion": 1,
      "id": "sha256:29b7...",
      "logicalType": "text",
      "codec": "utf8-v1",
      "storage": "deflate-raw-v1",
      "rawLength": 201821,
      "storedLength": 48211
    }
  }
}
```

### 6.4 项目格式标记

由于正式运行时不支持旧版内联格式，`project.abi` 顶层必须包含明确的存储能力标记：

```json
{
  "$ailyProjectData": {
    "schemaVersion": 1,
    "mode": "external-only"
  }
}
```

该标记由 `ProjectAbiRepository` 添加和校验，不交给普通字段维护。缺少标记、版本不支持或声明为其他模式的项目必须给出明确的格式错误，不能按旧字段逻辑继续加载。

`project.abs` 的标准 Header 同步输出：

```text
# Project Data Schema: 1 (external-only)
```

ABS Parser 可以忽略该注释完成纯语法解析，但 ABS 导入服务必须校验 Header 与生成出的引用格式一致。

## 7. 项目目录与资源文件

### 7.1 目录结构

```text
project/
├─ project.abi
├─ project.abs
├─ package.json
└─ assets/
   ├─ tftespi-animation/          # 用户导入的原始源文件
   ├─ u8g2-animation/             # 用户导入的原始源文件
   └─ project-data/               # ProjectDataStore 管理的派生/大型数据
      ├─ index.json               # 可选诊断索引，不是事实来源
      ├─ 29/
      │  └─ 29b7....bin
      └─ 83/
         └─ 83a5....bin
```

使用非隐藏目录是强制要求。当前项目打包流程会排除隐藏目录，资源不能放在 `.aily`、`.assets` 或 `.temp`。

### 7.2 路径推导

```ts
function resolveDataPath(projectPath: string, ref: AilyDataRef): string {
  const hash = validateAndExtractSha256(ref.$ailyData.id);
  return path.join(
    projectPath,
    'assets',
    'project-data',
    hash.slice(0, 2),
    `${hash}.bin`,
  );
}
```

所有读取、写入和删除操作必须在解析后再次验证最终路径位于固定资源根目录内。

### 7.3 Hash 规则

Hash 输入：

```text
SHA-256(
  UTF8(codec)
  + 0x00
  + UTF8(storage)
  + 0x00
  + canonicalBytes
)
```

Hash 基于 Codec、Storage Encoding 标识和规范字节，不基于实际压缩结果。`deflate-raw-v1` 必须固定算法参数；调整压缩级别但不改变 Storage Encoding 版本时不会改变 ID，切换 Raw/Deflate 或升级存储算法时会产生新的 ID，从而避免同一路径出现两种容器表示。

### 7.4 文件容器

资源文件建议使用统一容器，避免裸字节无法诊断：

```text
[Magic: "AILYDAT1"]
[HeaderLength: uint32-le]
[Header JSON: UTF-8]
[Stored Payload]
```

Header 至少包含：

```json
{
  "schemaVersion": 1,
  "id": "sha256:...",
  "logicalType": "binary",
  "codec": "tft-rgb565-be-frames-v1",
  "storage": "deflate-raw-v1",
  "rawLength": 374400,
  "storedLength": 126482
}
```

Header 是诊断冗余信息；ABI/ABS 中的引用仍是调用方输入，读取时二者必须一致。

## 8. Codec 与存储编码

### 8.1 职责分离

Codec 只负责：

```text
logical value ⇄ canonical bytes
```

ProjectDataStore 负责：

```text
canonical bytes ⇄ stored bytes
Hash、压缩、容器、I/O、校验、缓存
```

不能把语义 Codec 和压缩方式混为一个不透明字符串，否则难以保证 Hash 稳定和升级边界清晰。

### 8.2 Codec 接口

```ts
export interface ProjectDataCodec<TValue> {
  readonly id: string;
  readonly logicalType: AilyDataLogicalType;
  readonly maxRawLength: number;

  encode(value: TValue): Promise<Uint8Array>;
  decode(canonicalBytes: Uint8Array): Promise<TValue>;
  validate?(value: TValue): void;
}
```

`encode()` 输出必须确定性一致。相同逻辑数据在相同 Codec 下必须产生相同规范字节。

### 8.3 第一批通用 Codec

| Codec | 用途 |
| --- | --- |
| `utf8-v1` | 大文本 |
| `canonical-json-v1` | 通用 JSON 数组和对象 |
| `raw-binary-v1` | 已经是规范字节的二进制 |

Canonical JSON 必须统一：

- UTF-8 编码；
- 对象键排序；
- 数组顺序保持；
- 拒绝 `undefined`、`NaN`、`Infinity`、循环引用等非 JSON 值；
- 不加入缩进和非语义空白。

### 8.4 第一批类型专用 Codec

| Codec | 规范字节 |
| --- | --- |
| `tft-rgb565-be-frames-v1` | 按帧连续的 RGB565 big-endian bytes |
| `tft-rgb332-frames-v1` | 按帧连续的 RGB332 bytes |
| `u8g2-xbm-frames-v1` | 动画逐帧 XBM row bytes，LSB-first |
| `u8g2-xbm-v1` | 单张 U8G2 位图 XBM row bytes，LSB-first |
| `led-matrix-mono-v1` | 单色 LED Matrix row bit-pack |
| `led-matrix-rgba8888-v1` | RGB LED Matrix RGBA8888 bytes |
| `image-original-v1` | PNG/JPEG/WebP 等原始图片字节 |

类型专用 Codec 优先于 `canonical-json-v1`。类型专用 Codec 的目标是减少 JSON/Base64 开销，并让生成器直接消费规范字节。

### 8.5 Storage Encoding

第一阶段支持：

- `raw-v1`；
- `deflate-raw-v1`。

图片、视频等已经压缩的数据默认使用 `raw-v1`。文本、JSON、RGB 帧和 bit-pack 数据可根据压缩收益选择 `deflate-raw-v1`。

压缩必须：

- 在 Worker 或异步后台任务中执行；
- 设置最大解压长度；
- 使用确定的参数；
- 不阻塞项目首屏加载。

第一阶段一个逻辑 Payload 对应一个资源文件。按帧分块和范围解压作为后续优化，不阻塞基础方案落地。

## 9. 通用外置策略

### 9.1 Data Slot

允许产生大数据的字段或 `extraState` 必须声明 Data Slot：

```ts
export interface ProjectDataSlotPolicy<TValue = unknown> {
  readonly id: string;
  readonly codec: string;
  readonly storage: AilyDataStorageEncoding;
  readonly mode: 'always-external' | 'threshold';
  readonly thresholdBytes?: number;
  readonly maxRawLength: number;
}
```

Data Slot 是声明式接入点。新增动画、图片、音频、模型或大文本功能时，只需要选择通用 Codec 或注册专用 Codec，不得自行实现 Hash、目录和文件生命周期。

### 9.2 阈值

推荐默认值：

```text
32 KiB canonical bytes
```

规则：

- 明确的二进制、图片、动画和大型像素字段：`always-external`；
- 文本、数组、对象：规范编码后超过 32 KiB 时外置；
- 阈值以 UTF-8/规范字节长度计算，不使用 JavaScript `string.length`；
- 字段可设置更低阈值，但不能超过项目级安全上限。

### 9.3 只外置大型子树

Metadata 应保持内联。Resource-backed Field 负责明确哪个属性是 Payload，例如：

```text
animation.frames
image.imageData
bitmap.pixels
largeText.content
```

不建议把整个字段状态变成不透明引用，因为 Agent、Toolbox、依赖扫描和 UI 仍需要读取轻量元数据。

### 9.4 通用扫描与强制约束

`ProjectAbiRepository` 在写入前递归扫描所有：

- `fields`；
- `extraState`；
- 页面内容；
- 共享模型中可序列化的用户数据。

扫描器识别 `AilyDataRef`，并报告仍然内联的超阈值值。报告必须包含：

```ts
interface OversizedInlineValueDiagnostic {
  blockId?: string;
  blockType?: string;
  fieldName?: string;
  jsonPointer: string;
  canonicalLength: number;
  threshold: number;
}
```

未知大值不能在 Repository 中被盲目替换为引用，因为对应消费者可能不认识引用。正确处理方式是让数据生产者接入 Resource-backed Field 或 Data Slot，然后重新保存。

## 10. ProjectDataStore

### 10.1 服务接口

```ts
export interface ProjectDataStore {
  configure(projectPath: string, sessionId: string): void;
  reset(sessionId: string): Promise<void>;

  put<T>(request: {
    codec: string;
    storage: AilyDataStorageEncoding;
    value: T;
  }): Promise<AilyDataRef>;

  resolve<T>(ref: AilyDataRef): Promise<T>;
  getCanonicalBytes(ref: AilyDataRef): Promise<Uint8Array>;
  inspect(ref: AilyDataRef): Promise<ProjectDataInspection>;

  prefetch(refs: readonly AilyDataRef[]): Promise<void>;
  flushPending(): Promise<void>;
  validateReferences(refs: readonly AilyDataRef[]): Promise<ProjectDataValidationResult>;

  collectReferences(value: unknown): Set<string>;
  garbageCollect(roots: Set<string>, options: GarbageCollectionOptions): Promise<void>;
}
```

### 10.2 写入流程

```text
1. Codec.validate(value)
2. Codec.encode(value) -> canonicalBytes
3. 校验 maxRawLength
4. 计算 SHA-256(codec + NUL + canonicalBytes)
5. 选择 Storage Encoding
6. 压缩得到 storedBytes
7. 构造统一容器
8. 若目标 Hash 文件已存在，校验后复用
9. 写入同目录临时文件
10. flush/fsync（平台允许时）
11. 原子 rename 为最终文件
12. 返回 AilyDataRef
```

同一 Hash 的并发 `put()` 必须合并，不能产生相互覆盖或重复压缩。

### 10.3 读取流程

```text
1. 严格校验 AilyDataRef
2. 推导固定路径
3. 校验路径和文件长度
4. 解析容器 Header
5. 解压时限制最大输出
6. 校验 rawLength
7. 重新计算 Hash
8. Codec.decode(canonicalBytes)
9. 写入受限缓存
```

### 10.4 缓存与并发

运行时至少维护：

```ts
private readonly pendingReads = new Map<string, Promise<ResolvedProjectData>>();
private readonly pendingWrites = new Map<string, Promise<AilyDataRef>>();
private readonly byteCache = new LruCache<string, Uint8Array>();
private readonly valueCache = new LruCache<string, unknown>();
```

要求：

- 同一 ID 的并发读取只触发一次磁盘 I/O；
- 缓存按总字节数限制，不按条目数限制；
- 当前编辑中的资源和构建使用中的资源可以 pin；
- 项目切换通过 `sessionId` 取消或忽略旧项目异步结果；
- 非活动页面不得自动加载完整 Payload。

## 11. Blockly 运行时模型

### 11.1 Resource-backed Field 基类

建议新增统一基类或组合式 Adapter：

```ts
abstract class ResourceBackedField<TState, TPayload> extends Blockly.Field<TState> {
  protected value_: TState;              // 只包含 metadata + AilyDataRef
  private payloadHandle: DataHandle<TPayload> | null;
  private editSession: DataEditSession<TPayload> | null;

  protected abstract getDataRef(state: TState): AilyDataRef | null;
  protected abstract withDataRef(state: TState, ref: AilyDataRef): TState;
  protected abstract getDataSlotPolicy(): ProjectDataSlotPolicy<TPayload>;
}
```

字段不得将解析后的 Payload 写回 `value_`。

### 11.2 Data Handle 状态

```ts
type DataResolutionState =
  | 'unresolved'
  | 'loading'
  | 'ready'
  | 'missing'
  | 'corrupt'
  | 'unsupported'
  | 'error';
```

Handle 包含：

- `AilyDataRef`；
- 当前加载状态；
- 可取消的加载 Promise；
- 运行时缓存值；
- pin/unpin 状态；
- 块 ID 和字段名诊断上下文。

### 11.3 编辑事务

不能在每次像素点击或文本输入时生成新资源文件。编辑器使用独立事务：

```text
打开编辑器
  -> 按需加载 Payload
  -> 创建可变 draft buffer
  -> 用户连续编辑 draft
  -> Commit
       -> DataStore.put(draft)
       -> 得到新 AilyDataRef
       -> field.setValue(new compact state)
       -> 只产生一次小型 BLOCK_CHANGE 事件
  -> Cancel
       -> 丢弃 draft，不修改字段引用
```

保存项目时如果仍有打开的脏编辑事务，必须先提交或明确阻止保存，不能把未提交数据静默丢弃。

### 11.4 Undo/Redo

Blockly 事件的旧值和新值都只包含紧凑引用：

```text
oldValue -> sha256:A
newValue -> sha256:B
```

Undo/Redo 只切换引用，不复制或重新编码 Payload。旧 Hash 文件不能在当前 Undo 栈仍可能引用时删除。

### 11.5 `saveState()` 与 `loadState()`

```ts
override saveState(_doFullSerialization = false): TState {
  return this.getValue(); // 始终为 compact state
}

override loadState(state: TState): void {
  const compactState = validateCompactState(state);
  this.setValue(compactState);
  this.payloadHandle = runtime.createHandle(this.getDataRef(compactState));
}
```

即使 `doFullSerialization === true`，也不能重新内联 Payload。跨项目复制通过资源 Bundle 完成。

### 11.6 `getValue()` 与 Generator

`getValue()` 必须始终返回紧凑状态。Blockly 字段、序列化和 Agent 链路都不能重新暴露大型数组。

为保持 `aily-blockly-libraries` 只读，主程序在加载 generator 后包装对应 `forBlock` 函数。构建准备完成后，包装器只针对已注册 Data Slot 拦截 `getFieldValue()`，从同步缓存读取规范 Payload，并瞬态投影为该旧 generator 原本接受的字段值：

```ts
const generatorBlock = createProjectDataGeneratorBlockView(block);
return legacyGenerator(generatorBlock, generator);
```

包装器以 `Proxy` 保留原始 Blockly Block 的全部行为，仅覆盖已注册字段的 `getFieldValue()`。TFT、U8G2、LED Matrix 与 Adafruit 等旧 ABI 的恢复只存在于当前函数调用栈，不修改原字段值，也不触发 Blockly 事件。如果资源未准备、损坏或缺失，包装器必须抛出带块 ID、块类型和字段名的明确错误，不能返回空数组。

### 11.7 Minimap 与工作区克隆

Minimap 不得通过完整 Payload 克隆工作区。优先调整为紧凑 JSON 序列化：

```text
Blockly.serialization.workspaces.save()
  -> compact field state
  -> Minimap workspace load
```

如果保留 XML 路径，Resource-backed Field 必须保证 `toXml()/fromXml()` 也只传递紧凑状态。Minimap 只显示占位图或共享首帧缓存，不单独加载完整资源。

## 12. ABI Repository

### 12.1 责任边界

```ts
export interface ProjectAbiRepository {
  readCompact(projectPath: string): Promise<unknown>;
  validateCompact(document: unknown): ProjectAbiValidationResult;
  writeCompact(projectPath: string, document: unknown): Promise<void>;
  collectDataRefs(document: unknown): Set<string>;
}
```

Repository 负责：

- 读取和解析紧凑 ABI；
- 识别和校验 `AilyDataRef`；
- 检测未外置的大值；
- 等待 `ProjectDataStore.flushPending()`；
- 原子写入 ABI；
- 收集 GC/诊断引用。

Repository 不负责解析完整 Payload。需要数据的调用方显式使用 `ProjectDataRuntime`。

### 12.2 项目加载

```text
1. 创建新的 project sessionId
2. ProjectDataStore.configure(projectPath, sessionId)
3. ProjectAbiRepository.readCompact()
4. 校验 ABI 结构和引用格式，不读取全部资源
5. 加载积木库
6. Blockly.serialization.workspaces.load()
7. 字段只创建 Data Handle
8. UI 首屏进入可交互状态
9. 当前可见字段按优先级加载预览
```

项目打开时不得调用 `resolveAllAssets()`。

### 12.3 项目保存

```text
1. 提交或拒绝未完成的字段编辑事务
2. 等待 ProjectDataStore.flushPending()
3. Blockly 序列化 compact workspace
4. ABI Repository 扫描未外置大值
5. 校验所有新引用已经存在
6. 写 project.abi.tmp
7. 原子替换 project.abi
8. 更新 workspaceRevision / dataRevision 保存点
9. 异步安排 GC，不阻塞保存完成
```

项目保存不应重新编码未变化资源，也不应读取未使用资源。

### 12.4 Dirty State

不再通过两次完整 `JSON.stringify()` 判断未保存状态。

```ts
interface ProjectDirtyState {
  workspaceRevision: number;
  dataRevision: number;
  savedWorkspaceRevision: number;
  savedDataRevision: number;
}
```

- 有效 Blockly 变更增加 `workspaceRevision`；
- 编辑事务成功提交新引用后增加 `dataRevision`；
- 保存成功后更新两个 saved revision；
- 项目外部文件变化通过紧凑 ABI mtime/fingerprint 检查。

## 13. ABS 与 Agent 集成

### 13.1 ABS 表示

第一阶段不增加新的 ABS DSL 语法，直接复用结构化引用对象：

```text
seeed_gfx_animation({
  "schemaVersion": 1,
  "width": 120,
  "height": 120,
  "frameCount": 13,
  "frames": {
    "$ailyData": {
      "schemaVersion": 1,
      "id": "sha256:83a5...",
      "logicalType": "binary",
      "codec": "tft-rgb565-be-frames-v1",
      "storage": "deflate-raw-v1",
      "rawLength": 374400,
      "storedLength": 126482
    }
  }
})
```

这样可继续复用当前结构化 JSON 字段解析能力，同时避免在 ABS 中产生几十万字符的单行 Payload。

后续只有在可读性收益明确时，才考虑增加：

```text
data_ref("sha256:...", codec="...")
```

### 13.2 转换规则

```text
ABI AilyDataRef -> ABS AilyDataRef
ABS AilyDataRef -> ABI AilyDataRef
```

转换必须保持以下字段逐项一致：

- `schemaVersion`；
- `id`；
- `logicalType`；
- `codec`；
- `storage`；
- `rawLength`；
- `storedLength`。

转换器不得把引用展开为完整数据，也不得因为文件缺失而删除字段。

### 13.3 ABS 导入事务

Agent 修改 `project.abs` 后：

```text
1. 解析 ABS 为 compact ABI candidate
2. 校验所有 AilyDataRef 结构
3. 异步预检 candidate 新增引用是否存在且合法
4. 预检通过后再应用到 Blockly workspace
5. 应用失败时保持原工作区不变
```

项目正常打开允许以错误状态展示缺失资源；但 Agent ABS 导入属于编辑事务，不能把含未知缺失引用的 candidate 静默应用到现有工作区。

### 13.4 Agent 资源工具

Agent 正常编辑 ABS 时不自动读取 Payload。需要检查或修改大型数据时使用受控工具：

```ts
inspectProjectData(ref): metadata + summary
readProjectText(ref, range): ranged text
readProjectJson(ref, options): summary / selected path / paged items
replaceProjectData(target, expectedRef, input): new ref
```

要求：

- 二进制资源默认只返回摘要，不把完整字节放入 Agent 上下文；
- 大文本和数组必须支持范围或分页读取；
- 修改操作必须指定块、字段和 Payload 路径，并校验 `expectedRef`，防止覆盖同一旧 Hash 的其他共享引用；
- 修改操作先创建新资源，再原子更新指定目标的字段引用；
- Agent 不允许直接覆盖 Hash 文件；
- 普通代码编辑不会触发资源加载。

## 14. 代码生成、编译与构建产物

### 14.1 异步准备、同步生成

保持当前 Blockly Generator 同步模型，在进入 `workspaceToCode()` 前增加资源准备屏障：

```ts
const refs = projectDataRuntime.collectRequiredRefs(workspace, 'codegen');
await projectDataRuntime.prepare(refs, 'codegen');
const code = generator.workspaceToCode(workspace);
```

初始项目加载不应为了后台代码预览而阻塞首屏读取所有资源。代码预览可以延迟、取消或显示“资源准备中”。

### 14.2 Generator 接口

库 generator 本身保持不变。主程序适配层负责以下边界：

```ts
prepareBlocklyProjectDataForCodeGeneration(workspace);
wrapProjectDataGeneratorFunctions(generator, loadedBlockTypes);
projectPreparedFieldValueForLegacyGenerator(kind, compactState, payload);
```

兼容投影可按旧 generator 的既有输入契约，临时生成 Base64、像素矩阵或旧 JSON；这些值不得写回持久状态。主程序自有的新生成路径应直接消费规范字节，避免重复展开。这样既保证库包可独立升级和回滚，也把 Project Data 策略集中在主程序维护。

### 14.3 大型 C/C++ 数据

当前动画最终会膨胀成约 1.53 MB 的 Sketch 文本。后续构建优化应由 Codec 或 Build Adapter 生成：

```text
src/project_data_<hash>.h
```

Sketch 只保留：

```cpp
#include "project_data_<hash>.h"
```

这项优化不改变固件中的最终字节，但能减少：

- `sketch.ino` 体积；
- `build-config.json` 体积；
- 主代码编辑器和 Source Map 的压力；
- 重复格式化大数组的次数。

构建生成文件属于 `.temp`，可随时由 `ProjectDataStore` 中的持久资源重新生成。

## 15. 复制、粘贴、另存为与云同步

### 15.1 同项目复制

只复制 compact block state。相同 Hash 继续共享资源，不产生新文件。

### 15.2 跨项目复制

不能依赖 `saveState(true)` 内联完整数据。Clipboard 使用资源 Bundle：

```ts
interface ProjectDataClipboardBundle {
  compactBlockState: unknown;
  resources: Array<{
    ref: AilyDataRef;
    containerBytes: Uint8Array;
  }>;
}
```

流程：

```text
源项目复制
  -> 收集块中的 AilyDataRef
  -> 打包去重后的资源容器

目标项目粘贴
  -> 校验并导入资源
  -> 所有资源成功后创建积木
```

失败时不得创建带失效引用的半成品积木。

### 15.3 另存为

另存为复制整个项目目录，必须包含 `assets/project-data`。完成复制后重新配置新的 project session，所有引用继续通过项目相对根目录解析。

### 15.4 项目打包和云同步

归档前必须：

1. 提交字段编辑事务；
2. 保存最新 ABI；
3. 等待 Data Store flush；
4. 收集 ABI/ABS 引用；
5. 验证所有引用存在；
6. 确认归档包含 `assets/project-data`。

下载后首次打开需进行引用格式校验；完整 Hash 校验按需读取时执行，也可以由项目诊断功能主动执行。

单独分享 `project.abi` 或 `project.abs` 不再代表完整项目。产品 UI 应统一引导用户分享项目包或整个项目目录。

## 16. 垃圾回收

### 16.1 GC Roots

GC 不能只扫描磁盘上的 `project.abi`。当前系统存在 ABS 工作副本、未保存工作区和 checkpoint。至少收集：

```text
最新 project.abi 引用
+ 最新 project.abs 引用
+ 当前 Blockly workspace 引用
+ 活跃 Undo/Redo 可能引用的 ID
+ 活跃 edit checkpoint 引用
+ 正在进行的 Clipboard/构建事务引用
```

### 16.2 GC 策略

- 保存成功后只更新资源最后引用时间，不立即删除；
- 默认宽限期 7 天；
- 项目关闭、下次打开或用户手动操作时执行；
- 删除前重新收集所有 Roots；
- 只删除 `assets/project-data` 下通过严格文件名校验的资源；
- 原始 MP4/GIF/PNG 和用户手动资源不属于此 GC；
- `index.json` 可辅助诊断，但损坏后必须能从目录和项目引用重建。

### 16.3 磁盘压力

如果资源增长较快，可增加：

- 项目数据占用统计；
- 无引用资源预览；
- 手动“安全清理”；
- 按总容量触发的提醒。

不能为了节省空间缩短宽限期而破坏 Undo、checkpoint 或崩溃恢复。

## 17. 错误处理与安全

### 17.1 错误模型

```ts
interface ProjectDataErrorContext {
  projectPath: string;
  blockId?: string;
  blockType?: string;
  fieldName?: string;
  ref?: AilyDataRef;
  operation: 'read' | 'write' | 'decode' | 'preview' | 'codegen' | 'gc';
}
```

错误分类：

- `missing`：文件不存在；
- `corrupt`：长度、容器或 Hash 不一致；
- `unsupported`：Codec 或 schema 不支持；
- `tooLarge`：超过 Codec/项目限制；
- `cancelled`：项目切换或用户取消；
- `ioError`：磁盘操作失败。

### 17.2 UI 行为

资源异常时字段必须：

- 保留 compact state 和原引用；
- 显示明确状态；
- 支持定位块和字段；
- 禁止依赖该数据的预览、代码生成、编译和上传；
- 允许用户重新导入源文件产生新引用；
- 禁止自动 `setValue(emptyValue)`。

### 17.3 安全边界

- 不接受资源路径、绝对路径和 URI，只接受合法 Hash ID；
- 拒绝 `..`、符号链接逃逸和非普通文件；
- 每个 Codec 设置最大原始长度、尺寸、帧数和数组元素数量；
- 解压时强制输出上限，防止压缩炸弹；
- Canonical JSON 解码限制最大深度和节点数；
- Agent 范围读取限制单次返回大小；
- GC 删除前验证最终解析路径；
- 不执行资源内容中的脚本或动态代码。

## 18. 建议代码结构

通用项目数据能力不应放在某个具体字段目录下。

```text
src/app/services/project-data/
├─ project-data.types.ts
├─ project-data-ref.ts
├─ project-data-store.service.ts
├─ project-data-runtime.service.ts
├─ project-data-codec.registry.ts
├─ project-data-container.ts
├─ project-data-reference-walker.ts
├─ project-data-gc.service.ts
├─ project-data-clipboard.service.ts
└─ codecs/
   ├─ utf8.codec.ts
   ├─ canonical-json.codec.ts
   ├─ raw-binary.codec.ts
   ├─ tft-animation.codec.ts
   ├─ u8g2-animation.codec.ts
   ├─ bitmap.codec.ts
   └─ image-original.codec.ts
```

Blockly 适配：

```text
src/app/editors/blockly-editor/
├─ services/
│  ├─ project-abi-repository.service.ts
│  └─ blockly-project-data-preparer.service.ts
└─ components/blockly/custom-field/
   ├─ resource-backed-field.ts
   ├─ field-tftespi-animation.ts
   ├─ field-u8g2-animation.ts
   └─ ...
```

ABS/Agent 适配：

```text
src/app/tools/aily-chat/
├─ tools/
│  ├─ abiAbsConverter.ts
│  ├─ absParser.ts
│  ├─ inspectProjectDataTool.ts
│  ├─ readProjectDataTool.ts
│  └─ replaceProjectDataTool.ts
└─ services/
   └─ abs-auto-sync.service.ts
```

各字段只负责：

- 定义 Metadata；
- 声明 Data Slot；
- 选择 Codec；
- 管理 UI 编辑事务；
- 渲染加载和错误状态。

各字段不得负责：

- 项目路径拼接；
- Hash；
- 压缩容器；
- GC；
- 跨项目复制；
- ABS 文件读写；
- 云同步。

## 19. 分阶段执行计划

每个阶段必须满足退出条件后再进入下一阶段，避免字段先改为引用、但保存或构建链路尚未准备完成。

### 阶段 0：冻结设计与建立基准

任务：

- 确认本设计中的命名、引用格式、Hash 输入和目录结构；
- 为 TFT、U8G2、Bitmap、大文本准备固定样本；
- 记录 ABI/ABS 大小、字段事件大小、保存耗时、首屏耗时、代码生成耗时和峰值内存；
- 列出所有直接读取/写入 `project.abi` 和调用 Blockly 序列化的入口；
- 明确当前 Minimap 和 Clipboard 的实际序列化路径。

退出条件：

- 数据格式不再有待定项；
- 基准脚本可重复运行；
- 直接 ABI/ABS 入口形成审计清单。

### 阶段 1：ProjectDataStore 基础设施

任务：

- 实现 `AilyDataRef` 类型、校验和路径推导；
- 实现统一资源容器；
- 实现 SHA-256 内容寻址；
- 实现 `raw-v1` 和 `deflate-raw-v1`；
- 实现异步原子写入、并发合并和受限缓存；
- 实现 `utf8-v1`、`canonical-json-v1`、`raw-binary-v1`；
- 实现项目 configure/reset 和 session 取消；
- 实现资源 inspect、完整性校验和错误类型。

退出条件：

- 相同内容写入只生成一个文件；
- 写入失败不产生可见引用；
- 路径穿越、Hash 不匹配和解压超限测试通过；
- 项目切换后旧异步任务不能污染新项目缓存。

### 阶段 2：Blockly Compact State 与 ABI Repository

任务：

- 实现 `ResourceBackedField`/Data Handle；
- 实现编辑事务和小型 Undo 事件；
- 实现 `ProjectAbiRepository`；
- 保存前执行 oversized inline 扫描；
- 改造 Dirty State 为 revision 模型；
- 调整 Minimap 使用 compact state；
- 确保 `saveState(true)` 也不会内联 Payload。

退出条件：

- 测试字段的 `value_`、事件和 ABI 中只包含引用；
- 修改普通积木不会读取、编码或写入资源；
- 未注册大值会被明确拦截并定位；
- Minimap 不加载完整资源。

### 阶段 3：ABS 与 Agent 链路

任务：

- 在 ABI→ABS 中稳定输出 `AilyDataRef`；
- 在 ABS→ABI 中原样恢复引用；
- 增加引用结构校验和导入预检；
- 保证 ABS 转换器无磁盘 I/O；
- 增加 Agent inspect/read/replace 资源操作；
- 增加大文本范围读取和 JSON 分页读取；
- 调整 ABS block line map，确保引用仍定位到所属块。

退出条件：

- ABI→ABS→ABI 后引用逐字段一致；
- ABS 文件中不存在超过阈值的内联 Payload；
- Agent 修改普通代码不触发资源读取；
- 新增不存在引用的 ABS 导入被事务性拒绝。

### 阶段 4：迁移现有大型字段

按优先级迁移：

1. `field_tftespi_animation`；
2. `field_u8g2_animation`；
3. `field_image_preview`；
4. `field_bitmap`、`field_bitmap_u8g2`；
5. `field_led_matrix_image`；
6. 其他超过阈值的数据字段和 `extraState`。

每个字段都要完成：

- Metadata/Payload 拆分；
- Codec；
- 编辑事务；
- 占位/加载/错误 UI；
- Undo/Redo；
- compact serialization；
- 生成器数据获取；
- 字节级回归测试。

退出条件：

- 仓库扫描不再发现目标字段内联大数据；
- 当前基准项目 ABI/ABS 不包含 Base64 帧或像素大数组；
- 缺失资源不会被清空后保存；
- 编辑、预览、撤销和重做行为正确。

### 阶段 5：代码生成和构建产物

任务：

- 增加编译前 `prepare(requiredRefs)`；
- 主程序加载库定义时统一装饰字段、注册 Data Slot 和应用主程序 i18n；
- 主程序加载 generator 后统一包装 `forBlock`，把 prepared payload 瞬态投影到旧 generator ABI；
- 保持 `aily-blockly-libraries` 的 `block.json`、generator 和 i18n 不变；
- 主程序自有生成路径对 TFT/U8G2 直接消费规范字节；
- 将超大 C/C++ 数组输出到项目 `src/*.h`，并在预处理、缓存编译和 Lint 边界同步到临时 Sketch；
- 调整 Source Map 和构建配置以处理生成头文件；
- 资源错误阻断生成、编译和上传并定位块。

退出条件：

- 项目打开首屏不等待全部代码生成资源；
- 编译前资源缺失会明确失败；
- 基准项目固件帧字节与重构前一致；
- Sketch 主文件不再内联超大动画数组。

### 阶段 6：项目生命周期闭环

任务：

- 实现同项目复制复用引用；
- 实现跨项目 Clipboard Resource Bundle；
- 适配另存为、项目模板、项目广场和云同步；
- 归档前执行引用完整性预检；
- 实现 GC Roots 收集、宽限期和手动清理；
- 增加项目数据诊断和占用统计；
- 审查所有直接 ABI 工具并统一通过 Repository。

退出条件：

- 跨项目复制不会产生失效引用；
- 云上传下载后所有资源可验证；
- GC 不破坏 Undo/checkpoint；
- 仓库中不存在绕过 Repository 保存项目 ABI 的入口。

### 阶段 7：强制启用与清理

任务：

- 删除主程序持久化链路中的旧字段结构和内联兼容代码；保留只读库 generator 边界的集中适配器；
- 删除正式运行时中的内联迁移分支；
- 对内部测试项目执行一次性转换或重新创建；
- 默认启用 oversized inline 保存拦截；
- 更新开发规范，新增大数据功能必须声明 Data Slot。

退出条件：

- 代码库只有一种正式持久化格式；
- 所有 CI、集成和性能验收通过；
- 文档、示例项目和实现保持一致。

## 20. 测试计划

### 20.1 单元测试

- `AilyDataRef` 严格格式校验；
- Hash 输入和路径推导；
- 容器 Header 编解码；
- Raw/Deflate 往返；
- Canonical JSON 确定性；
- Text UTF-8 字节长度；
- TFT RGB565/RGB332 字节顺序；
- U8G2 bit-pack 位序；
- Codec 最大长度限制；
- 并发读取/写入合并；
- LRU pin/unpin；
- session 取消；
- 路径穿越、符号链接、Hash 不匹配；
- 压缩炸弹和 JSON 深度限制；
- oversized inline 诊断定位；
- 引用收集与 GC 白名单。

### 20.2 Blockly 集成测试

- `value_` 和 `saveState()` 只包含 compact state；
- `doFullSerialization` 不内联 Payload；
- 编辑 Commit 只产生一个小型变更事件；
- Cancel 不修改引用；
- Undo/Redo 在不同 Hash 之间切换；
- 缺失资源保留引用；
- 切页和 Minimap 不加载非活动 Payload；
- 项目切换取消旧请求；
- 保存普通积木不触发资源写入；
- 打开脏编辑器时保存行为明确。

### 20.3 ABS/ABI 集成测试

- ABI→ABS→ABI 引用完全一致；
- Metadata 保持一致；
- 转换不读取资源文件；
- ABS 中没有 Base64 帧和大数组；
- 引用缺失时转换仍保留引用；
- ABS 导入预检失败时工作区不变化；
- block line map 在紧凑引用下正确；
- Agent 普通编辑不加载资源；
- Agent 范围读取和替换生成新 Hash。

### 20.4 项目生命周期测试

- 保存过程中资源写入失败；
- ABI 原子替换失败；
- 应用崩溃后不存在 ABI 指向半写资源；
- 同项目复制；
- 跨项目复制；
- 另存为；
- 项目模板；
- 云上传、下载和解压；
- checkpoint 回滚；
- 7 天宽限期 GC；
- 手动清理；
- 项目目录只读或磁盘空间不足。

### 20.5 生成结果回归

- TFT 每帧字节逐字节一致；
- RGB565 大端序一致；
- U8G2 位序和行宽一致；
- 图片透明像素和颜色精度一致；
- C/C++ 符号、帧数和延时一致；
- 生成头文件与旧内联数组包含相同固件数据。

### 20.6 性能测试

固定样本至少记录：

- `project.abi`/`project.abs` 文件大小；
- ABI JSON parse 时间；
- Blockly load 时间；
- 首屏可交互时间；
- 字段打开和首帧显示时间；
- 普通积木保存时间；
- 动画 Commit 时间；
- 代码生成准备时间；
- 峰值 JS Heap；
- 资源实际读取次数；
- Blockly 事件序列化大小。

## 21. 验收标准

以下条件全部满足后才能默认启用：

1. `project.abi` 和 `project.abs` 中没有目标字段的 Base64 帧、Data URL 或大型像素数组。
2. 基准项目 `project.abi` 大字段体积减少至少 95%。
3. 单个 `AilyDataRef` 的 ABS 表示保持在小型固定规模，不随 Payload 体积增长。
4. Resource-backed Field 的 `value_`、事件和 Undo/Redo 不包含完整 Payload。
5. 修改并保存普通积木不会读取、编码或重写未变化资源。
6. 项目首屏不读取非活动页面完整资源。
7. 同一资源在同一项目会话内只发生一次实际并发读取。
8. 资源缺失、损坏和不支持时不会静默清空字段。
9. ABS→ABI 导入具备事务性，失败不破坏当前工作区。
10. 跨项目复制、另存为和云同步不会产生失效引用。
11. GC 不删除 ABI、ABS、工作区、Undo 或 checkpoint 仍引用的资源。
12. 编译产物中的数据字节与重构前一致。
13. Oversized inline 扫描在 CI 和运行时保存入口均生效。
14. 所有项目 ABI 读写入口统一通过 `ProjectAbiRepository`。

## 22. 实施决策清单

以下决策在编码前视为已确定，不应在各阶段重复选择不同方案：

| 事项 | 决策 |
| --- | --- |
| 旧格式兼容 | 不支持 |
| 正式格式数量 | 仅 compact state + `AilyDataRef` |
| 资源目录 | `assets/project-data` |
| 资源寻址 | SHA-256 内容寻址 |
| ABI 中保存路径 | 不保存，由 Hash 推导 |
| 大值阈值 | 默认 32 KiB canonical bytes |
| 动画/图片 | `always-external` |
| 通用大文本 | `utf8-v1` |
| 通用数组/对象 | `canonical-json-v1` |
| 压缩 | Store 层 `raw-v1` / `deflate-raw-v1` |
| Blockly 字段值 | 只保存 Metadata + Ref |
| 完整 Payload | 编辑事务或受限运行时缓存 |
| `saveState(true)` | 仍保存引用，不内联 |
| ABS 表示 | 第一阶段复用结构化引用 JSON |
| ABS 转换器 I/O | 禁止 |
| Generator | 异步 prepare + 同步 generate；只读库使用主程序瞬态 ABI 投影 |
| 跨项目复制 | Compact state + Resource Bundle |
| GC | 多 Root + 7 天宽限期 |
| 原始源文件 | 保留，不纳入 ProjectData GC |

## 23. 最终执行原则

本次重构的完成标准不是“ABI 变小”，而是大型 Payload 从 Blockly 普通状态链路中彻底退出。

正确的数据生命周期应始终是：

```text
导入或编辑 Payload
    -> 编辑事务缓冲区
    -> Codec.encode
    -> ProjectDataStore.put
    -> immutable AilyDataRef
    -> Blockly compact state
    -> ABI / ABS

需要预览或生成代码
    -> AilyDataRef
    -> ProjectDataRuntime.resolve / prepare
    -> 受限运行时缓存
    -> UI / Builder
    -> 主程序 Generator Adapter
    -> 只读库 generator 的瞬态旧 ABI（不持久化）
```

任何重新把完整数组、Base64、Data URL 或大型文本放回 `Field.value_`、Blockly 事件、ABS 或 ABI 的实现，都应视为违反本设计，而不是临时优化不足。
