# Git交付记录：Simulator Host 经典 G0 配对改动

> P19更新：C3/C6/H2选定产品矩阵已完成；见文末P19节。以下P18未通过状态保留为当时记录。

2026-10-30。本记录随独立分支提交，供配对review与后续合并使用。

Host保留原owner/presentation/binding与实际Agent/Builder工作责任，按真实终态结算同步及退出。经典G0配对验收通过；当前C3/C6/H2新包的首次同步和显示模型仍待补验。

## 配对代码与合并范围

| 仓库 | 当前独立分支及已推送代码提交 | 目标基线 |
| --- | --- | --- |
| Simulator | `i3w-esp32-s2-integration` · `ef14817de8bafb07f4ff6f179d9b2915bc39d158` | `i3w-core-native-browser` · `c5e158558fbc6ade0bc51b5767c3f0be0907c11b` |
| Blockly | `i3w-esp32-s2-integration` · `b033197d85b03582ee4f8b3c8493482ca7fb6160` | `i3w-unified-browser-host` · `63514bab8257ac3cf28c59fb80fb329a97826926` |

上表固定本次受验代码提交；本记录通过单独文档提交追加。Simulator 的经典改动拆为 `d951ca0f`（native SPI方向/高阻/IOMUX与UART帧格式，16文件）、`57dcda57`（同步状态及生命周期，28文件）、`ef14817d`（5份验收/复现文档）。Blockly 的经典配对改动为 `b033197d`（32文件）。

完整集成分支在追加本记录之前分别包含347/42个差异文件，继承已有C3/C6/H2及暂停C5工作；本记录各新增1份文档。因此review应覆盖配对完整分支，不能把经典49/32文件当成整分支。未创建PR或执行合并。

## 经典 ESP32 G0 验收

经典P17受验代码已整理提交并推送。111项定向回归、9项受控工作槽检查通过；真实正常产品链路包括同一owner编译失败、保存后重试、同步、初始运行、复位、停止重启与释放，共57项检查、9次唯一写入、18次双向解码。229份原始HTTP响应及10个Capture关闭/null ACK已独立复验。Chat关闭50个实际快照未出现重复beforeClose误报；正常Quit后80个已观察进程实例及5个辅助实例退出。

本次重新核对P17两个最终入口、35份声明材料及5份正式文档，SHA均一致，0差异。旧文档描述的“尚未提交”是其冻结时状态，本记录补充此次Git交付，保留旧报告和失败记录。

这组经典增量保留公共Core/Session/Peripheral协议、公共端口registry及器件模型；整分支的更早RISC-V UART帧格式/流控扩展仍须共同review。对应WASM/Runtime/Core身份、源码恢复与GNU材料按已冻结记录交付。conformance仍为T0；工作槽受控检查、释放回执、进程观察不代表全部硬件覆盖或堆/Worker内存认证。

## C3/C6/H2 当前状态

历史验收保留：C3/C6的P5各15阶段46项有界检查；H2的P9包含基础Session、I²C0/1、UART/SPI代表组合及三个正常Blockly/Subapp工程。历史包与当前公共代码存在差异，不能直接给当前合并版本签收。

本次从已提交Simulator代码 `ef14817d` 隔离构建同一C3/C6/H2安装包：6715源输入、222个声明文件加manifest共223文件，SHA及7类来源图/24个输出核对通过；gdb=false，公共Core端口与器件模型共用。sourceTree SHA：`f42050846c86a600abbbf843c3f32472e0f58faad5f7744e3bb233063d75ce20`。

**当前完整补验未通过，C6/H2本轮尚未运行，不标记三目标已完成验收。** C3三次独立尝试原记录均保留：

1. 首次经正常Subapp同步、官方Chat和Builder，真实生成12成员Artifact `480020248656609bea454cc4bd61986d2c6e9d4e81e425aed42911fbf0a21c62`（Build `490921b7-f944-481b-9596-99baeb61a949`）。ID、成员bytes/SHA、graph、inputs、delivery、sourceCapture及保存工程来源核对通过，但UI持续同步、初始runtimeAttachment未形成；15分钟门超时，未启动MCU。现有日志不能确定具体等待点，不归因为native故障。
2. 用该真实Artifact发起独立正常准入，UI显示“固件已同步 / 会话：就绪”并启动。测试脚本因GPIO返回顺序规范化误判失败，未更改产品代码；原失败保留。
3. 新a04测试脚本修正GPIO集合/排序断言，35项离线控制通过。真实固件初始UART回包、I²C ACK/NACK、SPI完整帧数据解码通过；运行画布显示TMP105为25.0°C、ST7789画面版本1，但所观察LCD仍呈白色，未确认预期3×2彩色像素。Root未释放模型验收门，超时记失败，尚未执行本轮复位/停止重启矩阵。

三次尝试所有者释放均确认；有MCU的两次按原Capture关闭/null ACK、停止到stopped、Session released及owner最终ACK清理，无保留工具。Main正常Quit后775个采样中55个已观察进程实例全部退出；5个本次辅助进程按精确身份SIGTERM退出，独占profile锁正常撤销，原有三个开发服务不变。这只证明本次已观察资源与回执范围。

## 后续与暂停项

- 先定位首次detached Scene正常构建完成至attachment之间的等待，并核实C3 LCD实际模型输出；不能用重新打开后的独立准入通过回填首轮成功。
- 外置测试脚本后续需保留Capture初始电平历史再按时间视口解码。H2 SPI离线重放已证明旧脚本丢首bit；该修正尚未投入真实验收，不能当作产品修复。
- 完成C3正常同步、物理UART与复位/停止重启后，复用同一套公共接口和器件模型验收C6、H2，再更新三目标交付状态。
- C6早期restart停在CONFIG_R、running无crash的问题仍未定因；后续有界通过不等于长时稳定性。旧C3 UART-routing三份AX与历史摘要SHA不符，该批证据降级，后继证据单列。
- C2/C5/C61、其他芯片及P4/S31继续暂停。已有C5 snapshot保留；`ESP32_P4_S31_ADAPTATION_PLAN_20261030.md`保留为原未提交文件，本次不纳入。

## 验收记录与保留数据

经典最终验收：`/Volumes/data/aily-work/test-results/aily-simulator/classic-g0-p17/final-g0-acceptance-a01.json`，SHA `004c62719cc1df9290d0dc17676fe634da99ad840422004fcf5b78da521e3b17`。

经典独立终审：同目录`final-independent-review-a01.json`，SHA `61702007d8367b53b27bfe90c4c3b27058ed2b03c0b3ba9a792a7778dc019a14`。

本次交付与补验台账：`/Volumes/data/aily-work/test-results/aily-simulator/git-delivery-p18/final-delivery-ledger-a01.json`，SHA `62b8d8d7b7bc85bfbe9343dbc72e59bea5fa9d6672aac44cfb5d12cbc7402b77`；包括三次失败报告、独立Artifact合同、只读诊断、实际AX/截图、清理与原工作树保留证明的文件身份。

原Simulator/Blockly工作树296/17个已记录修改文件及Git状态逐项复核未变，原分支/HEAD保留。所有备份、构建包、测试项目、脚本、原始报告、日志、图片与本机运行数据继续留在`/Volumes/data/aily-work/`，不纳入源码仓库。登录信息复用原位置；未复制或提交凭据、私钥、本机收据或ROM。未覆盖历史验收，未执行reset/clean、强制推送或合并。

## P19后继：C3/C6/H2选定产品矩阵已验收（2026-10-30）

本段更新P18之后的状态；上文原失败结论按当时记录保留。当前冻结集成版八工程、24阶段全部通过，含正常Blockly/主Agent/Builder/12成员Artifact、实际Subapp器件/物理UART、复位、停止重启和公开资源释放。独立审查462项、810原始响应，16次Capture null ACK及8份Session/owner释放确认。最终三个Main批次共366个已观察身份全部退休，资源服务/共享锁和四个辅助进程完成收尾。

本轮产品提交为Simulator `0a618a1d5e42ecddaf0defd5efedf9a0053e73a4` 与Blockly `29dbd461b40ba7e51ef03d96780d7790f4938b6b`。Simulator只更新共享显示fixture的INVON及独立24×16视觉命令，保留原tcns3×2协议，正式测试3/3；Blockly只增有界构建诊断及测试，定向61/61和scoped类型检查通过。Core/Session/端口registry及器件模型/View算法未改，未证明P18首次同步根因已修复。

受验sourceTree为 `159701576617997f88dddbf421bb9d28cffcf56f9787799009c701d4711c4cb9`。最终八项目账本SHA为 `69f205ee1aa910d72a13c098f5d39be0e1629c74087764f286df40b90d236cff`，退出账本SHA为 `d1de134d6399350ad99433483950bd82314fd75ae74c49defaeca68d969cf799`，位于 `/Volumes/data/aily-work/test-results/aily-simulator/risc-acceptance-p19/final-eight-a01/`。

本轮限选定产品矩阵；gdb=false、C0/T0、baseline unverified与历史长时/全组合未验边界保留，其他芯片继续暂停。原296/17项工作树改动和原P4/S31未提交方案保持。精确推送HEAD另存同任务根 `final-git-delivery-a01.json`。

完整记录见配对Simulator仓库 `docs/ESP32_RISCV_P19_ACCEPTANCE_20261030.md`。
