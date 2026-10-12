# Blockly 大项目性能优化与验收记录

日期：2026-09-16。主软件工作树：`aily-i3w1009`，基线 `77bbc521`。
核心源码：`/Users/downey/Projects/ZCK/aily-npm-blockly`，Blockly 13.3.0。

## 结论与验收边界

已实现并验证小地图脱离第二套 Blockly 模型，以及核心遍历、缓存和拖动图层优化。
**尚未达到“大项目加载与连续拖动流畅”的完整性能验收标准。**
7765 块项目加载仍有长任务；拖动包含 7005 个后代的整栈，连续真实指针压力测试仍超时。
这些失败没有通过关闭功能、放宽断言或跳过压力测试掩盖。

测试仅修改项目临时副本、使用隔离 Electron 用户目录。没有修改原项目，没有发布 npm 包或提交 Git。
用户原先的 `pnpm-lock.yaml` 修改保留；同步本地 tarball 时 pnpm 另有正常的 peer 解析变化。
没有切换或重启用户正在使用的旧工作树开发实例；生产构建已暂存到本工作树的 `renderer/` 供隔离测试。

## 小地图方案

普通同站 iframe 不能保证独立主线程，不把它作为性能隔离承诺。
参见 [Chromium OOPIF](https://www.chromium.org/developers/design-documents/oop-iframes/)。

- 最多 300 块：复制已渲染 SVG 的静态快照，保留字段图像及 Canvas 位图；删除重复 ID 和交互焦点。
- 超过 300 块：读取现成的路径、颜色、位置，主线程每批约 4ms；Worker + OffscreenCanvas 绘制概览。
- 大项目采用简化细节：显示积木轮廓、颜色及工作区注释位置，不逐字绘制字段文字和自定义字段细节。主工作区的字段功能不变。
- 不再序列化完整 XML、执行第二遍积木构造和字段渲染。真实 7765 块项目确认只有一份完整工作区。
- 内容变化合并；视口变化仅移动视口框。Worker 最多一帧在途，并保留最新待绘制帧。
- Worker 不可用时分批 Canvas 绘制；支持点击/拖动导航、方向键、Shift+方向键、页面切换和销毁清理。
- 极长竖向程序在等比全览中仍会显示成细长条。这不是主工作区虚拟化。

入口：`src/app/editors/blockly-editor/utils/workspace-minimap.ts`。

## Blockly 核心补丁

1. 同步渲染批次内复用文本宽度缓存，并隔离工作区批次；修复零宽文本缓存失效。
2. 渲染、父子调整和反序列化失败时释放缓存、恢复事件分组及撤销记录状态。
3. 后代和连接遍历改为保持顺序的迭代遍历，避免长链递归拼接；没有暴露连接时不扫描所有其他栈。
4. 拖动图层在支持的浏览器中使用状态保持移动，避免拆卸整个 SVG 子树后再次恢复焦点。旧浏览器、未连接节点回退原逻辑。

最后一项依据 [Chrome moveBefore 文档](https://developer.chrome.com/blog/movebefore-api)，保留无障碍焦点，不关闭键盘导航。

相同 7005 后代积木栈的诊断采样（macOS / Electron 35.7.5）：

| 同步方法 | 原路径 | 状态保持移动试验 |
| --- | ---: | ---: |
| startDrag | 13470ms | 66ms |
| moveToDragLayer | 13442ms | 29ms |
| endDrag | 7714ms | 39ms |

这是局部方法采样，不是 FPS 或整段拖动改善比例。试验随后落入核心源码，原子移动及回退的真实浏览器焦点测试通过。
连续拖动仍有浏览器层长停顿；不能据此宣称整个拖动只需 66ms。
加载采样中 `getTextWidth → getComputedStyle` 仍是明显热点，当前补丁没有消除所有唯一文本测量。
早期加载对照受到固定等待窗口、后台工具链初始化和采样开销影响，不给出稳定提速百分比。

## 验证结果

- 核心打包、TypeScript / Mocha 类型检查：通过；4045 项通过，5 项上游 pending。
- 核心修改文件 ESLint、Prettier、两个仓库 `git diff --check`：通过。
- 主软件 Angular 生产构建、应用和测试 TypeScript：通过。
- 主软件 ChromeHeadless 单元测试：402 项通过，含 Worker、降级、Canvas 自定义字段、变量改名以及原子移动/回退焦点测试。日志：`e2e/.artifacts/blockly-performance-2026-09-16/host-unit.log`。
- 9 项 Electron 常规契约：通过。覆盖 JSON/XML/代码一致性、注释、撤销重做、17 种自定义字段、原生编辑提交/取消、变量 ID、多选真实拖动/复制/粘贴/删除、折叠/禁用、两种渲染器、主题/缩放、路由切换和新 Electron 进程恢复。
- 小地图最终专测 2 项：通过。包含 7765 块真实项目的 Worker 出图、无第二完整模型、点击和键盘导航、生成代码不变、销毁，以及小项目内容更新。
- 7005 后代整栈连续指针拖动：**失败/超时**。保留原断言和失败轨迹，不列为通过。
- Electron Node 测试 90/91：另有缺失 `child/aily-coder-editor.json` 的既有打包夹具失败，未修改不相关子应用配置。
- 早期原生数字编辑撤销曾一次失败，单独复测及最终完整 9 项运行通过；保留日志，不据一次重试承诺绝无时序问题。
- 未验证硬件烧录、真实设备调试、Windows/macOS 安装包及线上账户。上述本地测试不替代这些验收。

## 复现

```sh
# 核心（源码仓库根目录）
npm run package
npm run test-mocha-node --workspace=blockly

# 主软件（本工作树）
pnpm install --frozen-lockfile
pnpm run test:unit:ci

# 使用已安装依赖的项目作为只读来源，夹具自动克隆
AILY_E2E_PROJECT=/absolute/path/to/installed-small-fixture \
  node scripts/run-e2e.mjs test blockly-v13-contracts.spec.ts blockly-v13-extended.spec.ts

# 包含尚未通过的巨型整栈压力项；不要把它从完整性能验收中排除
AILY_E2E_LARGE_PROJECT=/absolute/path/to/installed-large-project \
  node scripts/run-e2e.mjs test blockly-minimap-performance.spec.ts
```

`AILY_E2E_TRACE_PERF=1` 可额外启用浏览器拖动 trace，但采集本身会增加开销，不用于直接比较耗时。
pnpm 布局使用 `preserveSymlinks: false`，否则当前 Mermaid 的传递依赖解析导致构建失败。

## 产物与下一步

证据目录：`e2e/.artifacts/blockly-performance-2026-09-16/`（忽略目录，不提交测试项目数据）。
其中 `atomic-regression` 保留失败压力轨迹及常规功能截图，`final-overview` 保留最后的小地图画面。

下一轮仍需针对主 SVG 工作区的唯一字体测量、深层 SVG 树浏览器渲染/命中路径做受控采样。
若需要可见区虚拟化，应单独验证连接吸附、拖动预览、键盘焦点、注释气泡、搜索、多选、撤销及自定义字段；不能把 iframe 或当前小地图 Worker 当作主工作区虚拟化。
