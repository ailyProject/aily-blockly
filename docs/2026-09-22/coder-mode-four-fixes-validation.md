# Coder 设置页、云公开、Credit 与库映射修复验证

日期：2026-09-22；宿主源码：`aily--blockly`；编辑器源码：`aily-coder`。
本轮开始两仓工作区均干净，未提交或发布 npm 包。

## 实机入口

- macOS ARM64，Electron 35.7.5，Coder 产品 0.1.2-cn。
- 启动：`node scripts/run-electron-dev.js --serve --coder`，Angular `localhost:4200`。
- 原编辑器运行于安装版 0.1.13；修复 bundle 通过 `npm run dev:link -- --skip-build` 激活为本机 0.1.13-dev。
- Electron 正常退出时原父启动器连带停止了 Angular；确认 `ERR_CONNECTION_REFUSED` 后使用宿主 `npm start` 恢复热更新服务。

## 设置页（按用户补充截图修正定位）

用户所指的是汉堡菜单进入的设置窗口，不是 macOS 原生菜单。
设置页此前无条件显示 Blockly 左导航和正文分区，Thrasos/Zelos、缩略图实际上只控制 Blockly。
现按 `ConfigService.isCoderProduct()` 的启动/构建产品身份，同时隐藏独立 Coder 中的 Blockly 左导航和正文。
不以共享默认开发偏好或 coder.enabled 判断，不删除、迁移或改写 Blockly 配置。
Coder 保留已有界面主题设置；编辑器深浅主题沿用原有宿主同步链路。

真实 Electron `#/settings` 已验证：Coder 左导航和正文不再含 Blockly 专属项，主题导航与滚动正常。
另以 `AILY_BUILD_PRODUCT=blockly`、临时 appdata/userData 启动隔离 Blockly 实例，
真实点击 Blockly 设置后原控件完整可见；改选 Zelos、关闭缩略图、点击应用，
回读临时 config.json 得到 `blockly: { renderer: "zelos", minimap: false }`。
验证实例已退出，用户 Coder 实例保持运行。

## 前一轮附带的原生菜单品牌修正

在启动/打包产品身份确定后刷新菜单，保留原有动作、快捷键和其他子菜单。
真实点击原生菜单已见 `About Aily Coder`、`Hide Aily Coder`、`Quit Aily Coder`。
开发环境 macOS 顶栏应用名仍由 Electron.app 显示为 Electron；未改应用包元数据。
Windows/Linux 菜单路径不变；Blockly 默认产品身份由单测覆盖。

## 云项目公开

修复前通过主界面编译真实项目 `linkbit-eink-guwen`，编译成功但 `codeHash != buildInfo.lastBuildCode`。
`sketch/target-compile.json` 是编译生成的上下文，其输入摘要包含 package.json；把它计入源码哈希会形成自我失效。
现从 Coder 哈希及归档排除该根级文件、崩溃可能遗留的 `compile-preprocess-*.json`；哈希同时忽略 `.DS_Store`。
子目录中同名用户输入仍参与哈希，Blockly 原有 ABI/ABS 资源检查和打包规则不变。

2026-09-22 21:08（Asia/Shanghai）实机重编译成功，用时 11.21 秒；之后保存、云同步仍保持两个哈希一致。
使用用户明确授权的当前登录账号，主界面点击公开后显示成功。
未登录回读 `/api/v1/cloud/projects/public?id=1865&category=coder` 返回 HTTP 200、total=1、`is_published=true`。
项目：墨水屏2.13寸-古文今译，ID 1865。本轮结束保持公开状态。

下载公开归档再次验证：主源文件字节与本地一致、本地库完整保留、编译哈希有效；
无 node_modules、preprocess.json、target-compile.json。
本机验证归档位于 `/private/tmp/aily-coder-published-1865.7z`，不是交付源码。

## Credit

真实账号证实旧 `/auth/me/quota-info` 返回 legacy quota_snapshots，新 `/credits/me` 返回直接账本对象且无 unit。
宿主改用正式 Credit 端点，兼容成功包络；金额仍严格校验非负安全整数 micros，账号隔离及登出清理保留。
重启后通过真实 AuthService 刷新，快照含 available_micros / reserved_micros / next_reset_at，
资源记录连续四次只请求 `/api/v1/credits/me`，控制台未再出现 `Invalid Credit quota snapshot`。
用户中心显示 09/23 08:00 重置；Pro 的无限符号是既有展示策略，本轮不改，内部账本仍为有限余额。

## 库映射与切板

库树改为跟随项目实际声明的库依赖图，孤立安装包不投影；相同物理路径不会重复遍历。
不同物理库根保持可见，不以包名/版本猜测内容相同；同名时显示包来源，必要时加路径。
package.json 变化会刷新库列表。

Coder 新建/切板自动引入的模板库记录于 `coderBoardTemplateDependencies`。
切板只清理来源记录的板卡与当前板一致、且版本范围未被用户修改的模板库。
历史项目无来源记录时保留依赖；新模板不能认领已有用户依赖，即使版本相同。
Blockly 切板实现不变，本地源码库不删除。
用户显式安装成功后（含 Aily/Arduino 官方入口及同版本快路），清除该库的模板归属；
后台 materialize、失败回滚及其他依赖记录不变。最终 runtime 已重建并重启宿主载入。

最终 UI bundle：`main.common-DErfrpiq.js`。真实 Coder 入口打开独立临时工程：

1. 顶层 active-a、active-b 及 active-b 嵌套的 active-a 均提供 OneButton，同包同版本的两个物理根刻意内容不同。
2. 三个实际有效根都显示，各有清楚的包名/路径；未声明的第四个旧包不显示。
3. 仅删除 fixture 的 active-b 依赖声明，保留全部磁盘包文件；界面立即只剩顶层 active-a。
4. 关闭临时工程、移除其最近项目入口，恢复用户的 linkbit-eink-guwen。

fixture 在 `/private/tmp/aily-coder-library-ui-check`，未公开或上传。

## 聚焦自动验证

- 设置页与产品身份 ChromeHeadless：22/22；包含两种产品与相反共享偏好的隔离断言。
- 原生菜单及产品身份 Node 测试：10/10。
- Credit 合同和用户中心渲染 ChromeHeadless：38/38；聚焦 TypeScript 检查通过。
- 编译哈希、云同步、Blockly 归档隔离 ChromeHeadless：41/41；聚焦 TypeScript 检查通过。
- `npm run architecture:services`：186 个服务文件，0 新增违规，0 循环。
- 全量宿主单测尚非验收证据：既有 `resource-lifecycle-adapter.spec.ts` 导入不存在的旧 services 路径。
- Coder 库映射回归：20/20；最终完整 lint/typecheck/build 通过。
- 宿主 Coder/Blockly 切板、创建入口及依赖来源保护 ChromeHeadless：18/18。
- Coder 服务端安装/来源接管回归：29/29，lint/typecheck 与 runtime 构建通过。

云发布聚焦命令：

```sh
NG_BUILD_MAX_WORKERS=2 node scripts/run-angular.cjs test --watch=false --browsers=ChromeHeadless --ts-config=tsconfig.coder-cloud.spec.json --include=src/app/services/domains/build/coder-build-info.service.spec.ts --include=src/app/tools/cloud-space/cloud-space.component.spec.ts --include=src/app/tools/cloud-space/services/cloud.service.spec.ts --progress=false
```

本轮不包含硬件烧录、Windows/Linux 实机或正式安装包发布验证。

设置页聚焦命令：

```sh
NG_BUILD_MAX_WORKERS=2 node scripts/run-angular.cjs test --watch=false --browsers=ChromeHeadless --ts-config=tsconfig.settings-mode.spec.json --include=src/app/windows/settings/settings.component.spec.ts --include=src/app/utils/application-branding.spec.ts --progress=false
```
