# Blockly 13 真实项目验证（2026-09-28 至 29）

工作树：`/Users/downey/Projects/OutSource/aily-i3w1009`。这是合并后的真实项目补测，独立于上一份六类块构造压力数据。

## 项目与隔离

- 源项目：`/Users/downey/Documents/aily-user-project/project_aug30a`，项目名「岩石测量装置」，ESP32P4 Core Board 3.3.11。
- 原始 ABI 有 **7,765 个块、98 类块、320 个变量、3 个入口**；最大初始化栈 **7,005 块**，JSON 深度约 2,272。
- 使用项目已安装的 22 个依赖，包括 LVGL、三个本地 WaveShare 库。独立页面重放从实际主软件捕获的 433 步注册、定义、消息与生成器脚本，不替换为模拟块。
- 在私有副本中复制项目原有 `lvgl_label_set_text` 与文字输入子块，追加 250 组，共 **8,265 块**，最大栈 **7,505 块**。新增块使用新 ID，变量引用保持不变。
- Electron 使用临时 appdata；测试仅写入副本。副本开发板 `boardDependencies` 清空，避免下载编译器污染计时。这是编辑器验证，不是硬件编译、上传验证。
- 原项目四个根文件的 SHA-256 保存在 `source-hashes.json`。原 ABI SHA-256：`bf63caeca0330b09c7995038b3e152f782064ccc131c7db8c8858ed7eba1455c`。
- 原 ABI 没有 `$ailyData` / `asset://` 引用；早期夹具未复制历史 `.assets`，正式可复用准备脚本保留该目录。

证据目录：`e2e/.artifacts/blockly-real-project-2026-09-28/`。私有项目、注册脚本、截图和生成代码只保留在本机忽略目录。

## 实际发现与修复

1. **原生颜色恢复失败**。真实 LVGL 背景色 `#3a1f6b` 不在默认调色板内；颜色字段继承下拉 UI，被误当成固定枚举，导致整个项目无法打开。运行时契约现识别已注册颜色字段，交由其原生校验器恢复任意有效颜色。补齐 pnpm 的 colour/grid-dropdown 13.3.0 覆盖，与 npm 约束一致。
2. **主软件生成、保存路径拒绝深层块链**。直接调用 Arduino 生成器能成功，但正式项目快照使用资源 payload 的 512 层 JSON 限制。增加有界、无递归的项目文档 canonical writer，并接入版本比较、预生成代码、保存、构建来源查询和 ABS 事务。保留原 canonical 字节顺序、特殊键、循环与非法值检查；文档限制为 32,768 层 / 2,000,000 节点。外部 `canonical-json-v1` 资源编解码仍维持原有 512 层限制。
3. **批量加载时的文本测量布局开销**。诊断中约 9 秒落在 `getTextWidth` 的样式读取。加载入口暂缓内建 serializer 每个根块的立即渲染，在大工作区渲染前集中读取标准字段字体，预热原有文本宽度缓存，包含下拉文字箭头与 RTL 顺序。保留自定义字段、图片下拉和自定义 serializer 的原路径，作用域结束或出错后恢复原方法。
4. **ABI Worker 传输爆栈**。深层 JSON 本身可以解析，但 Worker `postMessage` 返回对象时递归克隆溢出。新增忽略字符串内容的深度扫描，超过 512 层时让出一帧后直接使用原生 JSON.parse；浅层项目保留 Worker 路径，解析错误照常报告。

未保留 CSS 选择器和 SVG 字体图标替换实验：没有证实稳定的完整拖动收益。

## 测量方法

Apple M4 Pro / 24 GiB / macOS 27.0；Electron 35.7.5、Chromium 134，1440×800 内容区域，DPR 2，加载完成后 GPU 合成启用。单元测试另用 Chrome Headless 153，耗时不混入性能表。

- `official`：官方 Blockly 13.3.0 + Thrasos，加载同一份真实项目和库定义。
- `aily-ui`：当前 vendor 核心 + Aily Thrasos、真实图标和自定义字段的独立页面。
- `host`：实际主软件生产构建，经打开项目入口加载副本，小地图开启。
- 独立页面走原生序列化加载；主软件首次打开走真实应用入口。各变体均另测原生 JSON 重载，不能将重载指标当成完整项目打开时间。
- 拖动为可信鼠标事件、12 次移动、96×48 位移，确认实际整栈坐标改变；官方版释放后的连接避让可能再次移动根块，测试记录原生 `bump` 位移并单独扣除后验证鼠标位移。随后缩放、重绘，核对全部块 ID、类型、连接、字段签名与代码。
- `dragMs` 是鼠标按下至释放接口完成的墙钟时间，不代表所有后续绘制结束；新增 `dragPaintedMs` 在释放后再等待两帧。旧记录没有后者，不将两种口径混算。
- 正式计时关闭 CPU Profiler/Tracing，串行运行，取三轮中位数。单次剖析只定位热点，不作为优化百分比依据。
- 早期 `before-*` / `diagnostic-*` 数据存在主软件 canonical 深度错误，只可用于诊断；直接生成器代码正确及 `pageerror=[]` 不代表主软件正式生成成功。后续测试同时检查生成错误通知对应的控制台错误，并通过正式预生成、保存路径验收。

## 主软件优化前后

为避免“打不开或生成失败反而更快”的错误对照，`healthy-before` 与 `after` 均包含颜色、深文档和 Worker 兼容修复，仅前者使用优化前的加载助手。两组都开启小地图，原生加载计时来自真实打开流程，不是独立页面模拟。

单位秒，三轮中位数；完整范围见本机 `summary.json`。

| 项目 | 指标 | 优化前 | 优化后 | 耗时下降 |
| --- | --- | ---: | ---: | ---: |
| 原始 7,765 块 | 首次同步原生加载 | 18.16 | 12.54 | 31.0% |
| 原始 7,765 块 | 工作区可见、运行时就绪 | 23.56 | 22.99 | 2.4% |
| 原始 7,765 块 | 包括小地图就绪 | 34.78 | 34.53 | 0.7% |
| 扩展 8,265 块 | 首次同步原生加载 | 20.19 | 13.68 | 32.2% |
| 扩展 8,265 块 | 工作区可见、运行时就绪 | 32.07 | 24.92 | 22.3% |
| 扩展 8,265 块 | 包括小地图就绪 | 38.27 | 36.54 | 4.5% |

同步加载减少约三分之一，但完整打开收益明显更小，不能把 31–32% 写成整机或整个编辑器提速。扩展项目优化前可见时间范围 26.37–37.13 秒，优化后 24.16–25.30 秒；三轮结果存在运行环境波动。原项目的完整打开收益很小。

加载前后主软件所有块/字段几何摘要一致；原始与扩展代码 SHA-256 分别为 `54f21dbea3d1dd2b87c913e78cb9fb7c47f3e4f1c665c26ecdaf0509be38232d`、`bac374ebbd01843c1ee42079c83cbeb4b75291988d9c0dc0dafeec8f03e66074`。原始项目代码还与其历史构建产物的源码哈希相同。

## 独立 Blockly 与主软件对照

以下为相同状态的**原生 JSON 重载**、真实指针拖动及重绘，单位秒，三轮中位数。重载特意绕过主软件新加载助手，保留相同原生 API 路径，用来观察运行环境差异；不能用这一列评价主软件首次打开优化是否生效。主软件实际首次打开的结果在上表。

| 项目 | 运行环境 | 原生重载至两帧 | 拖动事件完成 | 重绘至两帧 |
| --- | --- | ---: | ---: | ---: |
| 7,765 块 | 官方独立 13.3.0 / Thrasos | 14.22 | 19.22 | 2.26 |
| 7,765 块 | Aily 独立 / Aily Thrasos | 16.64 | 7.89 | 2.59 |
| 7,765 块 | 优化后主软件 | 19.76 | 12.69 | 2.88 |
| 8,265 块 | 官方独立 13.3.0 / Thrasos | 15.74 | 21.42 | 2.57 |
| 8,265 块 | Aily 独立 / Aily Thrasos | 18.57 | 8.60 | 2.90 |
| 8,265 块 | 优化后主软件 | 22.25 | 14.55 | 3.29 |

独立页面首次原生加载至两帧：官方为 12.70 / 18.01 秒，Aily 为 18.73 / 20.02 秒（原始 / 扩展）。此值不含主软件项目服务、库加载入口和小地图，不与完整项目打开直接等同。

独立 Aily 与主软件的全部块/字段几何哈希相同，三种环境的生成代码哈希相同。官方 Thrasos 几何不同，其 SVG 数量也较少：扩展项目官方 89,585 个 SVG 后代，Aily 独立 113,564，主软件 113,565。因此官方对照是引擎参考，不能将全部差额归因于 Angular 或某一个服务。

补充释放后绘制计时（没有开启 Profiler/Tracing，不混入原三轮统计）：8,265 块主软件 `painted-check` 一次完整验证中，鼠标事件完成 14.30 秒，等待后续两帧实际达到 **20.61 秒**；代码、连接和几何仍通过。独立版后两轮对应完整绘制时间，官方为 26.14 / 24.07 秒，Aily 为 13.82 / 14.73 秒。这些新增记录样本量不同，只用于揭示释放后的额外等待，不计算优化百分比。

## 尚未解决的性能边界

加载优化没有解决大栈拖动。原项目主软件 `dragMs` 中位数 12.79 → 12.69 秒；扩展项目 14.43 → 14.55 秒，没有实质收益。扩展项目优化后第一轮出现 **109.18 秒** 的拖动，最长任务 **97.84 秒**，该样本保留在正式统计中，未以重跑的快结果替换。

拖动仍涉及大型 SVG 树的样式、布局与合成；已有诊断不能证明该极端样本的唯一原因，也不能证明 60 FPS。测试期间观察到虚拟机、代理及系统文件服务的后台负载，未停止用户进程；跨 28–29 日的测量不是隔离实验室结果。

两次窗口提前关闭的未完成运行，以及官方版首次因自动避让而触发的测试位移断言，原始 JSON/日志均保存在 `interrupted/`。补测用于补齐缺失的完整记录；功能中断记录不伪装成性能成功样本。

## 功能与工程验证

- 24 份完整三轮性能记录通过汇总校验：2 种拓扑 ×（健康基线主软件、优化后主软件、官方独立、Aily 独立）× 3 轮；统一核对块数、13.3.0 版本、1440×800 / DPR 2、代码、状态及相应几何摘要。运行中断和断言失败的额外记录另存，不计为通过记录。
- 新计时口径另补测主软件扩展项目 1 次，包含释放后两帧检查，同样通过；未覆盖或替换原来保留的 109 秒异常样本。
- 原始与扩展项目两条真实 Electron 验收均通过：320 个变量、数字字段实际点击编辑/撤销、HSV 滑块编辑/撤销、正式 `runWithPreparedProjectCode` 生成、保存、关闭后重开，块数和代码一致，运行错误列表为空。
- 201 个针对性单元测试通过（65 + 136），最终加载/解析小改动另复核 6 个测试。覆盖深文档 canonical 字节兼容、12,000 层块链序列化、资源 codec 原限制、标准字段几何、RTL、定制 serializer、异常恢复和原生颜色。
- 最终生产构建通过；E2E TypeScript 以 `--module esnext` 检查通过。E2E 默认 CommonJS 设置遇到现有 `import.meta` 文件不适用，不声称其通过。
- Angular 服务架构检查：194 个文件、0 基线违规、0 循环。原项目四个根文件哈希保持不变。
- 未进行当前源码的硬件编译、上传或设备运行验证。文档 writer 的 12,000 块链测试不等同于 12,000 块 UI 流畅性保证。

## 复现

在工作树根目录执行。准备命令不覆盖已有 `project` 夹具；已有结果应先保留到另一目录。

```sh
pnpm install --ignore-scripts
node scripts/run-angular.cjs build --base-href ./
node -e "require('fs').cpSync('dist/aily-blockly/browser','renderer',{recursive:true})"
pnpm perf:blockly:real:fixture fixture /Users/downey/Documents/aily-user-project/project_aug30a

# 指向已安装 builder 的隔离种子，避免计时过程中下载安装。
export AILY_E2E_TOOLCHAIN_SEED="$PWD/e2e/.artifacts/blockly-performance-2026-09-28/toolchain-seed"
pnpm perf:blockly:real:test real-project.spec.ts
pnpm perf:blockly:real:fixture expand
pnpm perf:blockly:real:prepare
pnpm perf:blockly:real:test real-contract.spec.ts

BLOCKLY_PERF_VARIANTS=official,aily-ui,host BLOCKLY_PERF_TOPOLOGIES=original,expanded \
BLOCKLY_PERF_ROUNDS=3 BLOCKLY_PERF_LABEL=after pnpm perf:blockly:real:test real-compare.spec.ts
pnpm perf:blockly:real:fixture verify
# 需要保留的 healthy-before 三轮记录及两份 contract 记录齐全后：
node scripts/summarize-blockly-real-performance.cjs
```

独立页面可单独启动：

```sh
PORT=8314 BLOCKLY_PERF_DIRECTORY=e2e/.artifacts/blockly-real-project-2026-09-28 \
  node scripts/serve-blockly-performance.cjs
# 另一个终端：
BLOCKLY_PERF_URL='http://127.0.0.1:8314/official.html?topology=expanded' \
  env -u ELECTRON_RUN_AS_NODE npx electron e2e/performance/electron.cjs
```

`BLOCKLY_PERF_PROFILE=1` / `BLOCKLY_PERF_TRACE=1` 仅用于拖动剖析，`BLOCKLY_PERF_LOAD_PROFILE=1` 用于原生重载剖析。保持单实例，不与构建或其他性能测试同时运行。
