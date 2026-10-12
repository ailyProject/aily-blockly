# 大项目加载速度与卡顿优化（2026-10-10）

在当前主软件开发实例的 Angular 服务上，用独立 Electron 用户目录和真实“岩石测量装置”项目副本完成验证。保留已安装的 `aily-project-blockly@1.0.5`、原有库、Aily Thrasos 渲染器、视口渲染和小地图。本轮没有替换 Blockly 包或修改项目内的旧库。

## 同配置性能对照

7765 块、3 个根块；Electron 35.7.5，GPU compositing enabled。基线为主软件 `ad8a6fd4d`，优化后为该提交上的本轮工作区修改。每组连续打开三次，第一轮均采集 CPU profile；性能对照期间没有并行运行构建或其他测试。

| 指标 | 基线 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| 完整就绪中位数 | 11.002 s | 7.292 s | 33.7% |
| 各次打开的最长主线程任务，中位数 | 6.086 s | 0.760 s | 87.5% |
| 加载期间总阻塞时间，中位数 | 9.978 s | 1.806 s | 81.9% |
| 完整就绪三轮 | 11.577 / 10.987 / 11.002 s | 7.587 / 7.194 / 7.292 s | — |

完整就绪从打开项目路由开始，到生成器运行时 ready 再等两帧，包含库加载、模型构建、读回校验和显示；不是仅计时某个反序列化函数。总阻塞时间为 Long Tasks API 中各任务超过 50 ms 的部分之和。分片加载后，旧的同步 `workspaces.load` 计时只覆盖空工作区/变量初始化，不能继续用它代表完整模型加载。

证据：`e2e/.artifacts/blockly-loading-2026-10-10/{baseline,optimized}/result.json` 及 `load.cpuprofile`。

## 修改与原因

- 大于等于 1000 块的项目打开使用原生分片创建，在约 16 ms 的软预算检查点让出主线程。复用既有 ABS 装载器，保留原生连接、字段顺序、默认 shadow、动态下拉依赖和最终完整读回。普通编辑、页切换及事务回滚保留同步入口。
- 分片期间暂时移出积木 canvas，完成后在原位置恢复，再测量文字和统一渲染。避免每次让出线程时浏览器重新布局尚未完成的 SVG；模型始终完整创建，未裁掉屏外模型。加载运行在 Angular zone 外，完成后由原流程发布成功状态。
- 页面引用采集复用同步读边界中的声明检查。仍检查调用前后的完整状态及声明变化，避免逐字段重复扫描所有已使用类型。基线 CPU profile 中 `intact` 自身耗时约 2.37 秒，其中约 1.6 秒来自引用采集。
- 加载期间及 `FINISHED_LOADING` 监听器派生的旧库定时回调，在每个回调结束时统一刷新渲染。基线旧串口库反复 `block.render()` 带来三次约 1 秒停顿；合并后保留其选项和字段更新，并保留普通定时回调的即时渲染语义。
- 整个加载过程持有既有编辑租约；在 window 捕获阶段使用显式非 passive 键盘监听，确保 Electron 中同时取消默认键盘动作和事件传播。导航取消、成功或失败都释放本次加载资源。

## 功能验证

- 相关 Angular 回归：288 项通过，涵盖 ABS 分片、默认子块、字段恢复、项目模型和加载失败恢复。后续新增声明变更/定时器检查的 72 项、最终键盘与加载检查的 47 项也通过（含原生构建失败后的 canvas/撤销设置恢复）；这些集合有重叠，不累加为独立测试总数。
- 开发构建通过：`node scripts/run-angular.cjs build --configuration development`。
- 7765 块 Electron：三轮均在分片未挂载及最终挂载两个阶段注入拖动与 Delete 键；操作被取消，根块未变。通过真实数值输入框修改深层字段、撤销、重做和保存；后两次重开保留修改，生成代码哈希一致。原项目 ABI 哈希未变，页面错误为空。证据：`e2e/.artifacts/blockly-loading-2026-10-10/verified-final/`。
- 实际导航取消：部分模型已创建时返回首页，随后重新打开成功，未发布旧加载结果。就绪后继续观察 2 秒，剩余长任务为 152 / 151 / 65 ms，没有把多秒刷新工作延后隐藏。证据：`e2e/.artifacts/blockly-loading-2026-10-10/cancel-and-settle/result.json`。
- 8265 块 Electron：六组滚动/缩放位置无漏块、无坐标偏差；虚拟渲染与完整渲染像素一致；小地图保留 8265 块。深层字段编辑、撤销重做、中间块拖动/撤销、实际指针断开重连、折叠和序列化重载通过，状态及生成代码一致。证据：`e2e/.artifacts/blockly-causal-2026-10-09/loading-2026-10-10/host-virtual.json` 及同目录 PNG/trace。

性能对照复现（仓库根目录，复用已运行的 4200 服务）：

```sh
AILY_E2E_DEV_URL=http://127.0.0.1:4200 \
AILY_E2E_PROJECT="$PWD/e2e/.artifacts/blockly-initialization-2026-10-09/project-live" \
BLOCKLY_INIT_OUTPUT=e2e/.artifacts/blockly-loading-2026-10-10 \
BLOCKLY_INIT_LABEL=recheck BLOCKLY_INIT_ROUNDS=3 \
npx playwright test -c e2e/real-performance.config.ts real-initialization.spec.ts
```

增加 `BLOCKLY_INIT_RACE=1 BLOCKLY_INIT_INTERACTIONS=1` 验证输入干扰、编辑和保存重开；增加 `BLOCKLY_INIT_CANCEL=1 BLOCKLY_INIT_SETTLE=1` 验证取消加载和就绪后的任务。功能测试数据不用于上表的同配置性能比较。

仍有约 0.75–0.79 秒的最终布局任务，以及就绪后的短暂后台任务，不能宣称已经完全无卡顿。本轮验证层级为 macOS Electron 开发运行链和开发构建；未生成或验收新的 macOS/Windows 安装包。独立测试目录缺少 builder/linter/connector 的启动提示与退出清理日志不作为加载功能失败，也不构成编译/硬件验收证据。

## 加载时先放大再缩小的补充修复

真实 Electron 逐帧采样复现：7765 块项目保存比例为 0.861，画布首次挂载时却先显示 `translate(0, 0) scale(1)`，随后才恢复 `translate(257, -205) scale(0.861)`。分片加载结束后的主动让帧发生在恢复视口之前，因此既有缩放闪动，也有位置跳动。

现在在完整模型和字段恢复后、第一次主动让帧前恢复保存的缩放及滚动位置；保留原有分片预算、最终发布和取消检查。

- 原比例 86.1% 连续打开三轮：从第一帧到就绪后 1 秒，始终是保存的缩放和位置；完整就绪为 7.415 / 6.722 / 6.452 秒。仍为 7765 块、3 个根块，生成代码一致，原项目文件未变。
- 50% 和 150% 各一轮：首帧直接使用目标比例，滚动位置与保存值一致。包含分片中途取消后重开、真实深层字段编辑、撤销重做及保存重开。150% 下原生滚动计算有约 `4e-12 px` 浮点尾差，断言以 `0.000005 px` 容差核对位置，缩放值仍要求严格一致。
- 项目打开单元测试 6 项通过，新增检查加载过程所有可见帧的缩放和位置，而不只检查最终值。补充修改后的开发构建通过（6.820 秒），`git diff --check` 通过。

证据目录均在 `e2e/.artifacts/blockly-loading-2026-10-10/`：`zoom-before/result.json` 记录复现，`zoom-fixed/result.json` 与 `loaded-*.png` 记录三轮重开，`zoom-limits-final/` 记录缩放边界及编辑恢复。中间 `zoom-limits/` 因将浮点坐标字符串要求完全相等而失败，修正数值断言后最终组通过；未据此修改运行时坐标。

复现首帧检查，在前面的命令上增加 `BLOCKLY_INIT_VIEW=stable`；增加 `BLOCKLY_INIT_SCALES=0.5,1.5 BLOCKLY_INIT_ROUNDS=2 BLOCKLY_INIT_CANCEL=1 BLOCKLY_INIT_INTERACTIONS=1` 可验证边界比例、取消和保存重开。比例覆盖只写入测试副本。
