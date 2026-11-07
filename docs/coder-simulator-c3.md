# Coder C3 Simulator 接入

Coder 工程可以保存真实多文件 C++，通过现有 Builder 生成统一固件交付，再由正常 HTTPS Simulator Subapp 加载和运行。源码入口与 Blockly 不同；Artifact、场景、Session、公共 Core 和器件模型共用。

## 使用条件和流程

首轮产品验收使用 ESP32-C3、Arduino ESP32 3.3.10、4 MB Flash，以及 `src/main.cpp`、其他 `.cpp` 和 `.h` 文件组成的普通 Coder 工程。需要已安装 Coder Editor、Simulator、匹配的 SDK 和正常仿真准入。

1. 打开 `type=coder` 的工程，编辑并保存 `sketch` 下的源码。入口按工程配置选择，例如 `entry: "src/main.cpp"`。
2. 在 Simulator 中打开或确认工程自己的电路场景。首轮使用 GPIO4、电阻和公共 LED 模型。
3. 点击 Simulator 面板的“同步场景并编译”或“重新编译当前代码”。Main 先等待 Coder `save-all` 成功，再编译当前磁盘快照。
4. 固件加载后开始仿真，通过 UART 和电路器件交互。复位、停止和重启使用原公共 Session 流程。

服务器仍通过 HTTPS 分发 WASM，目标固件由浏览器 Worker 执行。本轮由桌面 Main 提供本地文件和 Builder；纯浏览器文件存储、远端编译 provider 及其他芯片组合需要分别验收。

## 数据和生命周期契约

| 输入或操作 | 约束 |
| --- | --- |
| 源码 | Coder 使用自己的保存桥和磁盘输入，不读取 Blockly 工作区缓存，不自动生成或覆盖用户 C++。 |
| SourceCapture | 分别记录入口原始 SHA、多文件输入摘要和项目配置语义摘要。仅头文件变化也会使旧固件失效；公共入口 SHA 的含义保持不变。 |
| 生成文件 | 根目录 `.aily/coder-embed-hints.json` 属于编辑器展示/LSP 元数据，精确排除于真实编译输入；其他源码、配置和同名嵌套文件仍受输入检查。 |
| 场景 | 使用用户已确认的场景语义版本。任意 C++ 不能唯一确定实际连线，不自动据此改写场景或源码。 |
| 构建和取消 | 请求绑定原工程、请求标识、场景和物理编译流。取消必须等待原进程实际结束；停止观察或发出终止意图不能提前释放工作位或发布完成终态。 |
| 交付 | 保存失败、编译失败、取消或原工程失效后不装载候选。迟到成功结果仍须通过原作用域和源码新鲜度检查。 |
| 工程切换 | 已加载的 Coder A/B 使用不同真实路径。切换先撤销旧 Provider/View，等待原 owner 释放确认，再为 B 重新准入；B 不继承 A 已加载固件的运行入口。 |

Coder 适配集中在 Main 的 `integrations/simulator/simulator-coder-*`、`CoderProjectRuntimeService` 和领域 Builder/Compile 服务；工作区重新准入复用 `SubappWorkspaceHostProviderService`。本接入没有新增 Core、总线或器件接口。

## 定向检查

使用 Node 22 及正常 stage 流程准备的同一组 SDK 包。共享回调测试按已安装 SDK 的 public exports 加载，避免误读相邻仓库的不同 SDK 源码。少数未发包的 application 测试夹具仍使用 Simulator 源目录；目录不在默认相邻位置时，通过 `AILY_SIMULATOR_SOURCE_ROOT` 显式指定。

```sh
node --test electron/simulator-host-provider-callback-authorities.test.js
node --test electron/coder-simulator-build-adapter.test.js src/app/integrations/simulator/simulator-coder-build.test.cjs
node --test electron/subapp-workspace-host-provider-readiness.test.mjs electron/browser-surface-project-identity-d14.test.js
node --test electron/simulator-active-build-cancellation.test.js electron/build-workspace-supervisor.test.js
node --test child/scripts/build-source-capture.test.js child/scripts/compile-delivery.test.js
```

真实产品验收覆盖多文件保存编译、UART/GPIO、共享 LED、按原请求取消与重试、保存失败恢复、普通编译冲突、在途 A/B 切换、同面板复位、停止重启和关窗释放。测试输出和本机候选、运行日志、租约与 profile 应放在操作产物目录，不纳入源码提交。
