# 工具箱拖出串口块的卡顿修复（2026-10-09）

问题来自真实块创建后的库回调，与插入连接处的预览克隆是两条路径。工程安装的旧 core-serial 会在 create 事件及 50 ms 初始化回调中遍历串口字段，并逐块调用 `BlockSvg.render()`。Blockly 13 的该方法每次立即清空渲染队列、更新连接和视口；200 个关联块因此触发 400 次重复同步刷新。软串口、ESP32 SPI 具有同类路径。IIC 工具箱默认拖出未触发大范围刷新，但引脚改变后的刷新也有相同写法。

主程序在当前 Blockly 工作区中，把拖拽期间已绘制且未被拖动的块的原生 `render()` 调用合并到原生帧队列。新块、正在拖动的块、插入标记、自定义 render 方法及普通编辑保持同步行为。代码在工作区销毁时解除；不改生成器模型、不延迟字段/事件、不修改工程依赖。已经安装的旧库也受益。

库仓库 `aily-blockly-libraries` 的 `aily_iic/generator.js` 和 `esp32_spi/generator.js` 同时移除了批量刷新中的同步 render，复用一次生成的选项，只在当前选中标签变化时使字段尺寸失效。重复刷新不触发布局。core-serial 源码已有同类按需刷新，工程安装的旧脚本与该源码不同，本轮保留旧安装脚本验证主程序兼容路径。

## 实测

macOS、Electron 35.7.5 开发版。临时工程及独立用户目录，使用真实鼠标从原生 flyout 连续拖动 60 步。601 块夹具包含各 200 个串口、IIC、SPI 消费块。软串口在 ESP32 夹具中只为回归加入工具箱，不表示支持在 ESP32 编译 SoftwareSerial。

| 场景 | 修复前关联刷新 | 修复后关联刷新 | 同步 render 次数 |
| --- | ---: | ---: | ---: |
| 自定义硬串口，旧安装库 | 1605.7 ms | 3.7 ms | 401 → 1 |
| 软串口，旧安装库 | 1644.0 ms | 3.0 ms | 401 → 1 |
| ESP32 SPI，自定义初始化 | 743.9 ms | 0.4 ms | 201 → 1 |

串口对照在相同主程序、开发板、安装脚本及夹具下仅关闭/启用本次合并层；SPI 对照为库修改前后的记录。上述为单轮诊断耗时，不是跨机器性能保证。修复后两种渲染器的四类拖拽均未观察到超过 50 ms 的主线程任务。

Thrasos / Zelos 均通过落下后状态、撤销/重做、IIC/SPI 引脚标签更新、无变化刷新不重绘、保存重开与全块数据一致性校验。8,265 块真实工程扩展副本还通过自定义串口和普通串口输出的工具箱拖出及相同持久化校验；自定义串口关联刷新合计 17.6 ms。该大工程起拖仍有最高 92 ms 的单次主线程任务，不能据此宣称所有大工程操作恒定 60 FPS。

## 复现与证据

- 测试：`e2e/tests/blockly-toolbox-drag.spec.ts`，配置 `e2e/toolbox-drag.config.ts`。
- 设置 `AILY_E2E_DEV_URL`、`AILY_E2E_PROJECT`、`AILY_E2E_LIBRARIES`，可用 `AILY_E2E_SERIAL_LIBRARY` 指定旧安装库目录。测试只复制输入目录。
- `pnpm exec playwright test -c e2e/toolbox-drag.config.ts`；`AILY_E2E_TOOLBOX_REAL=1` 使用完整工程；`AILY_E2E_DRAG_BASELINE=1` 在隔离工作区撤销本次合并层以做对照。
- 汇总：`e2e/.artifacts/toolbox-drag-summary.json`。详细 CPU、计时及截图位于 `toolbox-drag-controlled-baseline`、`toolbox-drag-verified`、`toolbox-drag-real-verified`。
- 4 项渲染批处理单测通过，覆盖帧合并、连接位置、首次渲染、拖拽块、普通编辑、销毁/释放及自定义 render；原有插入预览回归覆盖两种渲染器、四类块，每类经过 24 个连接位置，校验连接、撤销、零克隆、零监听器增长及配置保全。TypeScript 检查通过。

这是 macOS 开发版编辑交互验证，不包含 Windows 安装包及硬件编译上传验收。
