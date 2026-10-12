# Blockly 13.3.0 升级与验收

日期：2026-09-16。基线：宿主 `265c3a774`，旧核心 `893da3608`。

## 版本与交付方式

原 `aily-project-blockly@1.0.2` 基于上游 11.2.2，不是 Blockly 1.x。
本次升级到官方最新稳定版 13.3.0（上游 `bf35c82fce034a7728d07c7827a513b2a3073a1b`），
保留 Aily fork；不直接替换为丢失定制行为的官方 npm 包。

核心源码现在位于 `aily-npm-blockly/packages/blockly/core`。核心本地升级提交
`fbee0c44d` 保留旧 Aily 分支为祖先；`AILY_FORK.md` 记录全部旧补丁的责任映射。

2026-10-10 起，宿主通过 `blockly: npm:aily-project-blockly@1.0.3` 安装
[线上发行包](https://www.npmjs.com/package/aily-project-blockly)，其上游基线和运行时版本均为 13.3.0。
npm/pnpm 锁文件记录线上包的完整性哈希，override 保证插件共用宿主核心。
本地 tarball、补丁快照和源码同步脚本已移除；安装宿主无需邻接核心源码仓库。
三个官方插件同步到 13.3.0，并强制 field-colour/grid-dropdown 使用 13.3.0。
升级时 `npm ls --all` 确认所有插件共享同一核心，无 11/12/13 多副本混用。下文验收数据保留原验证时间和版本。

Node.js 最低 22；本次构建 Node 24.16.0，宿主内置 Node 22.21.0。

### 原目录落地状态与运行中版本

- `/Users/downey/Projects/ZCK/aily-npm-blockly` 已合入核心升级 `fbee0c44d`，原目录独立执行核心测试通过。
- `/Users/downey/Projects/OutSource/aily--blockly` 已从 `265c3a774` 快进到宿主升级 `6ad2f5b3`，并安装对应 lockfile 依赖。
  原目录单测 **394/394**、TypeScript 检查通过；Node 读取 Blockly.VERSION 为 **13.3.0**，依赖树全部复用该版本，工作区无未提交代码。
- 两仓库均保留 `codex/blockly-v11.2.2-backup` 分支；未发布 npm 包。
- 最初保留的 `ng serve`（PID 8953）继续使用旧 Vite 预打包缓存。
  隔离 Electron 窗口当时读取 Blockly.VERSION 为 **1.0.2**，版本烟测失败；
  `.angular/cache/19.2.24/aily-blockly/vite/deps/chunk-CQKEK7E7.js` 同样包含旧版本。
  这与新版生产构建的桌面 E2E 通过是不同层次。
- **用户授权后已重启开发服务**：仅停止旧 `ng serve`，新服务 PID 68255 继续监听 4200，
  Vite 日志确认因 lockfile 变化重新预打包。连接该开发服务的全新隔离 Electron 实例已读取 **13.3.0**，
  39 块测试项目加载、代码生成（572 字符）通过，无 pageerror；烟测退出码 0。
  原 Electron（PID 9036）仍存活，没有主动关闭窗口或写入用户项目。
  版本回读来自隔离实例，不冒充直接读取了原用户窗口的内部状态。
  证据：`/tmp/aily-blockly-v13-restarted-smoke2.log`、`/tmp/aily-blockly-v13-dev-server.log`。
  原窗口另外通过只读 CLI `app_info` 健康检查（HTTP 200、ok=true、Thrasos／dark），未进行项目写操作；
  `e2e/.artifacts/blockly-v13/original-window-health.json` 不含鉴权 token。

## 新能力及边界

- 13.2 改善插入标记、连接数据库更新、变量名比较和积木坐标计算，并修复相关内存泄漏。
  [官方 13.2 发布说明](https://github.com/RaspberryPiFoundation/blockly/releases/tag/blockly-v13.2.0)。
- 13.3 增加可选工具箱／flyout 跳转、工作区滚动快捷键，开放更多拖拽策略扩展接口，
  修复撤销栈被渲染影响、拖拽误连接／删除等问题；workspace-search 插件增加读屏支持。
  [官方 13.3 发布说明](https://github.com/RaspberryPiFoundation/blockly/releases/tag/blockly-v13.3.0)。
- v12/v13 的焦点、可访问性、变量及 CSS/API 变更需要宿主适配，不能仅修改版本号。
  [v12](https://github.com/RaspberryPiFoundation/blockly/releases/tag/blockly-v12.0.0)、
  [v13](https://github.com/RaspberryPiFoundation/blockly/releases/tag/blockly-v13.0.0)。
- 这些上游能力不代表 Aily 已打开所有可选快捷键／安装 workspace-search 插件。
  本次目标是保留既有交互，不额外改变用户快捷键。
- 13.3 没有工作区“只创建可见积木 SVG”的虚拟化开关。批量渲染、headless 生成与
  SVG 工作区虚拟化不是同一能力；现有 Minimap 仍会建立 XML 镜像，不能承诺数万积木无卡顿。

## 兼容实现

1. 保留块／工作区注释的未失焦文本保存、初始文本、pinned、零坐标、尺寸调整位置及固定气泡布局。
2. 为独立发布的旧积木库提供 v11 variable workspace API、getVars、setEnabled 兼容层；不改变变量 ID。
3. 适配 v13 FocusManager/IDraggable：多选整组焦点、拖动 disposition、粘贴后的异步焦点恢复、清理监听器。
4. 相邻块避让改为按工作区控制，避免项目库 runtime 重建后恢复原型导致布局跳动。
5. 迁移 Toolbox/field CSS 名称；维持隐藏原生工具箱、显示 Aily 外部分类面板的原布局。
6. 修复音符字段构造验证顺序，以及角度、滑杆、音符编辑器重复获取临时焦点的问题。
7. 保留现有 Arduino 长链迭代生成、大资源引用扫描、分页／项目 runtime 隔离逻辑。
8. 真实大项目截图暴露旧通知进度动画会显示负数：同一帧内长任务使 rAF 时间戳早于动画启动时间，
   原缓动比例未限制下界。现限制比例和显示值，并覆盖早到帧、倒退／中断及非法起止值；不改下载数据或动画样式。

## 已执行验证

| 层级 | 结果 |
| --- | --- |
| 升级前宿主基线 | 381/381 单测通过 |
| 升级后核心含历史和新增注释契约 | 4035 通过；5 项上游测试 pending，未将其算作通过 |
| 升级后宿主 ChromeHeadless | 394/394 通过，含 6000 连续语句链生成、12000 层资源扫描及通知进度边界／真模板多帧 |
| Electron 主进程 Node tests | 91/91 通过；使用原 checkout 随附的离线 Coder 资源包补齐测试环境 |
| Arduino / MicroPython / Python 旧新核心对照 | 固定嵌套、注释、禁用、值块、语句尾链的生成片段和 JSON 往返一致 |
| 17 类定制字段 | 实际渲染、值序列化／还原、编辑器打开／关闭通过 |
| Electron Blockly 交互 | JSON/XML 代码一致、撤销重做、未失焦注释、多选真键鼠拖动／复制／粘贴／删除通过 |
| 项目运行时 | 两项目切换隔离、未使用库移除后原地重建且保留 DOM／代码／位置、iframe 焦点边界通过 |
| 干净安装 | 临时空目录 npm ci --ignore-scripts 通过，未使用 legacy-peer-deps |
| TypeScript | tsc --noEmit 通过 |
| 架构审计 | 基线与升级版输出完全相同，仍有 6 项既有测试文件 import 违规；无新增差异 |
| 桌面常规回归 | 57 项通过；另行运行的大项目、真实编译及小地图结果见下文；外部条件项没有算作通过 |
| 真实编译 | ESP32-S3 项目预处理、编译、成功状态、当前 buildInfo 和日志断言通过；生成 ELF/BIN，未执行烧录 |
| 真实大项目 | 当前副本为 7765 个工作区积木；JSON 往返、数值撤销、保存、重开和代码逐字一致已重复通过，最终图像验收见下文 |

测试修正不改变产品行为：等待 Playwright 附加预热 Page；macOS 使用原生窗口关闭生命周期；通过真实关闭按钮处理登录弹窗；
库移除的临时目录移到 node_modules 外；编译等待项目依赖／预处理就绪；精确鼠标位移测试关闭网格吸附。

### 真实大项目的代码与性能边界

本轮实际磁盘项目已不同于早先 2583 块的调查快照：当前工作区为 **7765 块、320 个变量**，
生成 Arduino 代码 **181380 字符**。只操作排除原实例锁的临时副本，原项目不写入。
另起独立旧版 Electron，复用原 `ng serve` 的旧版基线，运行相同项目副本。
两版生成代码 SHA-256 均为：

```text
54f21dbea3d1dd2b87c913e78cb9fb7c47f3e4f1c665c26ecdaf0509be38232d
```

新版两轮功能复测的整套加载／重载／撤销／保存／重开耗时分别约 **82.2 / 81.5 秒**，
其中首次加载约 **17.5 / 18.2 秒**，一次同步代码生成约 **202 / 205 ms**。
保存调用墙钟约 15.9–16.8 秒包含前序渲染任务等待；诊断日志中保存处理函数从进入到代码发布约 0.5 秒。
这些是本机单次流程记录，后台还可能有工具链初始化，**不是性能基准或“无卡顿”承诺**。
旧版对照是开发构建，新版是生产构建，也不能以此作严格速度比值。

初期测试直接重载整个 SVG 工作区，未采用正式宿主已有的事件批处理事务，出现过 180 秒超时。
大项目回归现按正式页加载器的事件批处理和文本宽度缓存方式执行，数字编辑／撤销仍启用事件。
两轮功能复测末尾的 CDP 截图另出现 30 秒超时；没有把这两次测试总结果记为通过。
最终使用 Electron 原生 compositor 窗口截图，仍保留并人工核对真实画面；不能用关闭录制解释全部性能开销。

最终桌面专项 **5/5 通过**（同一轮 2.8 分钟）：大项目、JSON/XML／注释／撤销、17 类字段、小地图同步与点击平移、多选键鼠操作。
最终大项目核心流程 85.9 秒，首次加载 19.2 秒、代码生成 219 ms；保存并重开后代码哈希仍完全一致。
原生窗口截图 3024×1768 已人工检查，积木、分类栏及通知显示正常；通知显示 4%，未再出现原截图的 -442%。
初次加载通知观察器记录 1 次合法采样；这不是连续帧性能测试。早到／中间／结束帧另用 ChromeHeadless 真模板断言 0%／75%／100%。

首轮按不同测试用例去重，**60 项 E2E 套件用例已通过**（57 项常规，另加大项目、真实编译及小地图）；
这些结果来自分批运行，不冒充一次全量全绿。5 项外部条件测试未开启，详见下一节。
其中套件同时包含 Electron 交互和编排辅助逻辑测试，不将全部用例都计为真实桌面交互。

### 重启后的扩展回归

新增 `blockly-v13-extended.spec.ts`，五项均在真实 Electron 生产加载路径通过：

1. 原生数字编辑器提交／Escape 取消、撤销重做；键盘编辑滑杆到 100；中英双行文本输入。
2. 实际发布库的 `variables_get` 重命名、引用查询、代码输出及 JSON 恢复保留变量 ID。
3. 已连接语句块的折叠不改变代码；独立禁用原因不被旧 setEnabled API 清除；断开／撤销／JSON 恢复。
4. 未失焦注释和数值改动真正写入 project.abi，关闭测试进程后用新 Electron 进程恢复，代码逐字一致。
5. Thrasos／Zelos 两种 Aily 渲染器分别重新进入编辑器；逐块检查 SVG 正尺寸，放大／缩小还原比例，积木数与代码不变。

扩展首轮 4/4，日志 `/tmp/aily-blockly-v13-extended-second.log`；随后加入双渲染器测试，完整套件中五项全部通过（48.1 秒）。
第一轮数字撤销用例未等待字段提交事件入撤销栈，
已改为等待编辑器关闭且对应字段事件入栈后执行撤销；未更改产品逻辑或放宽值断言。
旧全流程脚本会清理共享 aily-builder 缓存，未运行该清理路径；新增创建／编译用例仅使用临时项目目录，
只替代系统目录选择器返回值，其余创建、依赖安装、预处理和编译走实际应用流程。

新建／连续编译用例 **1/1 通过**（1.8 分钟）：`@aily-project/board-xiao_esp32s3`，
两次分别核验本次 buildInfo 的时间和 success 状态，并核验 BIN 大小与两次编译完成日志。
另行复跑已有项目真实编译用例 **1/1 通过**；均未执行上传／烧录。
日志：`/tmp/aily-blockly-v13-create-compile-third.log`、`/tmp/aily-blockly-v13-create-compile-first.log`（后者首个新用例失败、原编译用例通过）。
新建用例初次曾匹配到 Plus 板型，随后目录断言定位到两个输入框；均为新测试选择器问题，
已精确匹配基础板型和非 board 的路径输入框，未修改产品选板／创建逻辑。

本轮原目录重新执行：宿主 **394/394**、Electron **91/91**、三种代码生成器旧新对照通过；
新增 E2E 文件 TypeScript 检查通过；架构审计仍为原有 6 项违规，输出与基线一致。

重启后的完整 E2E 首轮结果为 **63 通过、1 失败、7 未开启**（6.5 分钟），保留原始 JSON 报告，未覆盖失败记录。
唯一失败在大项目的通知采样数量断言：功能恢复、撤销、保存重开及代码一致性断言均已通过，
但采样器只观察首次编辑器中的通知节点，重开后节点已被替换，下载百分比出现时仍观察旧节点。
现每次进入编辑器前重新绑定观察器，并额外断言两次挂载；保留百分比样本大于零和全部处于 0–100 的断言。
该修正仅修改测试，不改变通知组件或业务行为。修正后专项 **1/1 通过**，两次挂载、4 次合法百分比采样，无 pageerror；
完整功能流程 85.0 秒（首次加载 18.3 秒、单次代码生成 211 ms），7765 块／320 变量／181380 字符及旧版 SHA-256 均不变。
截图人工核对为正常工作区，右下角通知 5%；证据为 `large-after-restart-contract.json`、`large-after-restart.png`。

本轮按用例去重累计 **66 项通过**：完整套件的 63 项、大项目修正后复测 1 项、另行执行的编译 2 项。
这是分批最终通过结果，**不是一次全量全绿**；仍有 5 个门控用例未运行（AI 1、旧全流程 3、模拟器 1）。
旧单板全流程由本轮安全的新建／两次编译用例覆盖了所选 XIAO ESP32-S3，不代表所有板型均通过。

无工具链 seed 的编辑器批次会在隔离 appdata 中触发后台工具下载；部分截图显示 SDK 路径尚未就绪，
测试退出时相应 npm 子进程由正常清理生命周期终止。这些编辑器断言不等于 SDK／编译验收；
真实编译采用前述白名单工具链 seed 独立执行，没有将背景安装中断算作编译成功。
随后带白名单工具链再次复跑跨进程恢复和双渲染器，**2/2 通过**（2.7 分钟，重复用例不增加总数）。
两种渲染器截图已人工核对，未再显示 SDK 路径错误；恢复注释截图仍有依赖安装进度，
没有因此声称这两项已完成全部工具链安装。报告／截图保存在 `seeded-renderer-restore.json` 和 `seeded-renderer-restore-results/`。

本机证据保存在原宿主和升级工作区的 `e2e/.artifacts/blockly-v13/`：
`large-workspace-contract.json`、`large-workspace.png`、`negative-progress-before.png`、`minimap-pan.png`、`compile-success.png`。
原宿主另保存本轮 `full-after-restart.json` 和 `full-after-restart-results/`，包括双渲染器和跨进程恢复注释截图；
`new-project-compiled-twice.png` 为新建项目连续两次编译的真实窗口证据。
最终桌面专项日志为 `/tmp/aily-blockly-v13-final-acceptance.log`。
原目录复核日志为 `/tmp/aily-blockly-v13-original-unit.log`、`/tmp/aily-blockly-v13-original-typecheck.log`；
旧开发缓存版本烟测失败见 `/tmp/aily-blockly-v13-original-smoke.log`，没有将该烟测计入通过数。

本次使用 webapp-testing 技能要求的真实 Electron 页面及交互验证；按 ui-function-repair 的实际入口／截图复核要求定位并修复通知动画越界，
不能把构建／单测通过当作 UI 或硬件验收。

## 仍需外部条件的验收

- 实机串口、烧录、BLE、不同开发板全量工具链及 Windows/Linux 发布包未完成验收；没有选择或烧录用户设备。
- 真实账号／模型调用的 AI 操作遮罩测试未开启；没有复制账号凭据到测试环境。
- 在线项目广场当前出现 `ERR_CERT_DATE_INVALID`；没有禁用 TLS 检查来伪造成功。
- 模拟器 QEMU/GDB 专项需要对应的 runtime 包；本机缺少现有测试要求的 win32-x64 包。
- 定制媒体字段的编辑器契约通过不等于所有视频／音频格式、导入导出及实机播放已穷举。
- 已通过测试的范围不能表述为“所有平台、所有账号、所有硬件、所有第三方库功能 100% 验证完成”。

## 复现

```sh
# 核心
npm ci
npm run test:aily

# 宿主：在源码 checkout 执行
npm ci
# pnpm 用户使用 pnpm install --frozen-lockfile
npm run test:unit:ci
node --test electron/*.test.js electron/tests/*.test.js
node scripts/verify-blockly-generator-parity.mjs /absolute/path/to/old/node_modules/blockly

AILY_E2E_PROJECT=/absolute/path/to/installed-fixture \
AILY_E2E_PROJECT_SECOND=/absolute/path/to/second-fixture \
AILY_E2E_LARGE_PROJECT=/absolute/path/to/real-large-project \
npm run test:e2e

# 仅复制工具链白名单，所有测试均使用独立临时 appdata
AILY_E2E_PROJECT=/absolute/path/to/installed-fixture \
AILY_E2E_TOOLCHAIN_SEED=/absolute/path/to/toolchain-appdata \
AILY_E2E_COMPILE=1 npm run test:e2e -- compile.spec.ts

# 新建向导和两次真实编译：仅使用隔离工具链和临时项目，不清理共享缓存
AILY_E2E_TOOLCHAIN_SEED=/absolute/path/to/toolchain-appdata \
AILY_E2E_COMPILE=1 npm run test:e2e -- blockly-v13-create-compile.spec.ts
```

旧新核心对照脚本是 headless 合同验证，不是三种语言所有第三方库的穷举测试。
基线版本由参数指定；不要在基线 checkout 已升级后仍把它当作旧核心。

## 回退

源码历史保留升级前提交。回退时应将核心 tarball、宿主兼容层、官方插件和 lockfile 作为一个单元处理，
先保留当前未提交内容，再用新的回退提交或独立工作区恢复基线；不要只单独降级 blockly，
也不要对现有开发目录执行 hard reset。本次先保留既有进程，确认旧缓存并获得用户授权后仅重启 `ng serve`；原 Electron 窗口保持运行。
