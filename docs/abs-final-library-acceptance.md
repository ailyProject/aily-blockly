# ABS 最终抽样验收与交付记录

日期：2026-09-17。执行主线：`abs-native-runtime-execution-plan.md` 第 25 节之后的收口验收。任意异步结构不在本次范围，不新增库专用适配或 ABS 文法。

## 1. 样本与方法

运行前固定种子 `cda244f93f8e6d04`，按 `SHA256(seed + ":" + directory)` 分层排序，从动态/字段联动候选池取 5 个、常规池取 2 个。完整候选池与 ABS 在 `scripts/abs-final-library-cases.cjs`，单测验证选择可复现；失败样本不得换库。检索现有验收脚本、夹具与文档，未找到这七库已有的完整真实 ABS 导入验收；ai-vox 曾做源码审查，不声称从未检查过源码。

| 库 | 实际覆盖 | 三轮变化 |
| --- | --- | --- |
| ai-vox-xzai | 动态字段/输入增减 | I²S → PDM → I²S，WS 消失/恢复与生成引脚 |
| seeed_HM3301 | 板级动态引脚选项与普通嵌套值块 | 三组 SDA/SCL、三种 PM 读数，批量修改 |
| arduino_r4_LED_Matrix | serializer 驱动可变输入、二维数组字段 | 2 → 3 → 2 帧、延时及图案 |
| spa06 | 板级动态选项、类型变量下拉 | 地址/引脚/模式，批量修改 |
| pid | 原生 preset 字段联动，非拓扑 mutator | 温度 → 电机 → 自定义参数，类型变量与值输入 |
| serial_transfer | 常规块、变量、数字/文本嵌套 | 波特率、包号、负数、中文/emoji，批量修改 |
| ArduinoFFT | 常规块、下拉与数值参数顺序 | double → float → double、采样参数及窗函数 |

使用真实 Electron 页面、完整未修改库脚本、当前 lex 的 `blocks_list/block_info/read/write/edit/abs_export/abs_validate/abs_import/project_save`。每库三个正例；R4 另有一个缺失形状状态的拒绝反例。验证读取真实工作区字段/输入、ABI 和 C++，块身份、保护入口、批量编辑，以及关闭重开后的完整工作区/C++/ABI/ABS/map 一致性。证据文件放在工程旁，不参与工程历史事务。

原工程和库目录只读，验收使用临时副本。R4 库在统一 ESP32 夹具中验证结构与转换，**不代表 R4 固件可在 ESP32 编译**。本批不是新的 LLM 自主会话或固件编译测试，不把工具调用测试写成自主 Agent 成功。

## 2. 首轮发现与处理

首轮目录：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-xhxTsG`，日志 `.tmp-abs-final-seven-electron.log`。总结果失败，五库通过，保留原始证据。

1. **R4 测试丢弃了原生状态**：第二帧默认导出已有 `@extra:{"itemCount":2}`；测试重写调用却丢弃状态，第三帧 `ADD2` 因不存在而拒绝。修正测试以原生导出为依据，把 itemCount 改为 3/2；保留遗漏状态的负例，要求拒绝且三份镜像不变。不按 ADD 名称猜 serializer，不修改库，也不为 R4 添加转换器分支。这是既有 `@extra` 状态透传，不是新增身份/坐标 `@meta`。README 未给出任意帧数所需完整状态，不能仅凭简写推断未知 mutator 协议。
2. **ai-vox 首次候选超时**：独立 validate 超时后，import 自己重新验证并成功，验收按严格条件仍判失败。未提高候选预算、未加自动重试，完整复跑保留同样的预算。
3. **测试证据干扰失败回滚**：原 runner 把证据 JSON 写进受历史事务管理的工程，异常清理时报告文件变化，遮盖原断言。改为工程旁独立证据文件；不改产品保存/回滚流程。

## 3. 最终门禁

最终真实运行目录：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-36OaIJ`；日志 `.tmp-abs-final-seven-complete.log`。**success=true、errors=[]、exit 0；7/7 库、21/21 正例全部接受且字段语义通过，7/7 保存重开一致，7/7 库源码哈希未变**。R4 缺失状态反例拒绝且镜像不变。五库的后两轮共 10 次批量 edit，每次同时修改 2–3 处调用；不是逐块导入。

ai-vox、HM3301、R4、SPA06、PID、SerialTransfer、FFT 的 Agent 执行耗时分别为 127052、86715、67492、50764、73826、47939、47083 ms。已查看 R4 和 SerialTransfer 的实际页面截图；完整图案与 Unicode 文本正常加载。原工程 ABI SHA256 再次核对仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。

提交前回归：

| 门禁 | 结果 | 日志 |
| --- | --- | --- |
| Blockly ABS 全量 | 820/820，156.243 s | `.tmp-abs-final-blockly.log` |
| 抽样固定性、候选打包、编译预处理、证据脚本 | 14/14 | `.tmp-abs-final-node.log` |
| 暂存源码独立快照架构 | 169 files、0 baseline violations、0 cycles | `.tmp-abs-final-staged-architecture.log` |
| 暂存源码原生类型检查 | 通过 | `.tmp-abs-final-staged-types.log` |
| 暂存源码工程加载 | 9/9 | `.tmp-abs-final-staged-load.log` |
| 暂存源码 development 构建 | 通过，60.279 s | `.tmp-abs-final-staged-build.log` |
| lex 构建与类型声明 | 通过 | `packages/aily-agent/.tmp-abs-final-release-build.log` |
| lex ABS / 项目文件发布 | 114/114，66.271 s | `packages/aily-agent/.tmp-abs-final-release-tests.log` |

暂存快照只从 Git index 导出，不混入未暂存业务文件；共享已安装 node_modules。应用构建通过命令行使用本机依赖解析所需的 `--preserve-symlinks=false`，不提交工作区原有的两个同名配置修改。构建前后 native-candidate.js 的 SHA256 相同，确认资产进入应用输出。最终门禁全部通过，允许提交和正常推送。

复现抽样：在 Node 22 下设置 `AILY_ABS_ACCEPTANCE_SET=final`、`AILY_ABS_RANDOM_LIBRARIES_ONLY=1`、`AILY_ABS_LIBRARY_ROOT`、`AILY_AGENT_ROOT`，运行 `scripts/project-data-electron-smoke.cjs <只读工程路径>`。浏览器套件、应用构建与 Electron 串行，避免重建候选 bundle 干扰正在执行的版本证明。

## 4. 提交边界

只提交 Blockly 原生候选、ABS/Project Data 必要实现、对应回归/构建入口/文档，及 lex 的语法发现、批量编辑溯源与私有缓存。库仓库、原工程、登录配置、日志、生成 bundle、无关 Auth/积分业务和 `preserveSymlinks` 本地调整不随本次提交。提交前检查暂存内容与依赖闭包；使用原分支正常推送，不强推。

交付分支为 `aily-blockly / i3w-sim` 与 `aily-lex-pro / i3w-pi`；暂存清单分别为 175 和 20 个文件，包含此前尚未提交的必要 ABS 实现。两个多余 fixture 文件尾空行已清理，`git diff --cached --check` 通过。无关工作区修改保留。

收口结论限于当前同步原生能力、稳定身份与完整保存链；不承诺任意库全覆盖，且不把范围外异步或原库缺陷重新列为本次发布前置条件。
