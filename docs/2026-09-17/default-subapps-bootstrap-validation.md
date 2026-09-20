# 默认子应用后台安装与串口提示精简验证

日期：2026-09-17。

## 需求及入口

用户截图要求移除串口调试器顶部正常状态的“日志持久记录中”，并后台下载安装默认子应用。最新规则为：自动安装每次启动检查，默认置顶只在首次安装成功时处理一次，后续保留手动布局。覆盖 Aily Chat、串口调试器及仅限 Coder 产品的 Aily Coder Editor。本次不改变日志持久化能力。

- 宿主入口：`MainWindowComponent.ngOnInit()` 在 renderer-ready 通知后以 `void this.ensureDefaultSubapps()` 发起后台工作，不等待下载安装才显示主界面。
- 安装链：`bootstrapDefaultSubapps` → `RequiredSubappService.ensureInstalled(catalogId)` → `SubappManagerService.install(catalogId)` → 已有 Electron 子应用安装 IPC / 版本存储。与 Coder 必需编辑器入口共用在途安装任务。
- 置顶链：产品配置和启动目录就绪 → `AppStoreService.initializeSubappToolbarDefaults()` → 监听后续目录中的安装完成 → 统一保存一次处理记录与工具栏布局。手动安装和自动安装共用此路径。
- 串口完整及紧凑入口：`packages/serial-debugger/ui/src/app/app.html` 与 `compact-surface.component.html`；以当前正式 Angular 构建产物接入真实 `startSerialDebuggerServer` 验证。

## 行为

- 初始化策略来自 `subapp-index.json[目录ID].app`，没有硬编码默认安装名单。`autoInstall`、`defaultToolbar` 均为可选布尔值，缺省 `false`，类型错误由目录校验器拒绝。
- 源码声明为 `package.json#ailySubapp.app`。Aily Chat 设置 `autoInstall: true, defaultToolbar: true`，串口和 Coder Editor 设置 `autoInstall: true, defaultToolbar: false`；Coder Editor 根级设置 `only: "aily coder"`。生成器保留完整 app 扩展字段。
- 启动在后台等待已存在的目录刷新请求，避免重复请求与缓存缺项；网络失败继续使用可用缓存。
- 每次启动顺序执行配置中的缺失安装，单个失败继续处理其余条目；已安装正式/开发版本直接复用，禁用、卸载中、`only` 不匹配的应用跳过。产品配置就绪后才进行 `only` 匹配。
- 自动安装依据当前安装状态判断，旧首次安装标记不参与。置顶单独在 `subappToolbarDefaults[目录ID]` 记录处理结果，`toolbarAppIds` 保存实际布局；手动取消、排序后，重启、更新和重装不再应用默认置顶。
- 旧用户已有布局但没有新记录时，保留当前产品已有应用的布局；之后新安装的应用处理一次默认置顶。移除默认布局直接追加子应用的旧旁路。
- 工具栏上限为 8（包含锁定入口）；已满时记录 `skipped-full`，不超限、不挤掉已有图标，以后也不自动补位。默认置顶本身不会触发下载安装，且只对可运行、允许置顶并匹配 `only` 的应用生效。
- 正常日志记录标记在两个串口视图都不显示，异常警告仍显示。日志、搜索、导出及 Runtime 未修改。
- 详细字段和使用示例见 `/Users/downey/Projects/ZCK/aily-subapp/docs/subapp-initialization-policy.md`。

## 首次安装置顶与用户布局验证

- Node 22.21.1 / ChromeHeadless 152：50/50 目标测试通过，覆盖安装启动策略、RequiredSubapp、目录就绪、Coder 安装提示、AppStore 布局及菜单。首次置顶专项 17 项通过；调整测试导入到 public-api 后再次运行 17/17 通过。
- 专项使用真实 `SubappManagerService`、`AppStoreService` 和启动编排，外部 IPC/配置存储使用隔离替身。覆盖新安装（自动/手动）、保存后重建服务、取消置顶/排序、升级迁移、更新/重装、only、别名、禁用/扩展/不完整包、满位、最后一个空位竞争、重复目录事件、保存失败与手动修改竞争。
- `tsc -p tsconfig.app.json --noEmit` 通过；修改仓库 `git diff --check` 通过。架构检查仍仅报告下方两个未修改测试文件中的 6 项既有问题。
- 当前 Aily Coder 开发实例通过热更新加载新服务，`subappToolbarDefaultsReady: true`；真实用户配置回读 `toolbarAppIds` 仍为原三个入口，已有 Coder/串口应用记录为 `preserved`，没有恢复用户取消的置顶。
- 在该 Electron 内使用真实已编译 `AppStoreService` 和隔离内存配置验证：首次 `defaultToolbar: true` 得到 `applied`；手动取消后重建服务仍未置顶且为 `manual`；8 个位置占满后保持 8 个且为 `skipped-full`。此项不代表远端目录已更新或执行过真实下载。

## 先前每次启动置顶方案验证（已被上述规则替代）

- Node 22.21.1 / ChromeHeadless 152：34/34 目标测试通过（启动策略 21 项、RequiredSubapp 7 项、Coder 安装提示 3 项、目录初始化 3 项）。
- 覆盖卸载后下次启动补装、取消置顶后恢复、连续启动不重复安装或置顶、启动间修改配置、每次重新检查 `only`、安装期间目录变化、工具栏满后重试，以及失败不阻塞其他应用。
- 已移除源码中 `subappInitialization`、旧 Chat/串口安装时间戳的读写依赖；历史配置无需清理即可使用当前状态判断。
- `tsc -p tsconfig.app.json --noEmit`、两个修改仓库的 `git diff --check` 通过。未重启 Electron 或执行远端下载；下述 UI、Electron 临时包和生成器结果为先前验证记录。

## 先前配置化与串口 UI 验证记录

- 配置化宿主 Angular 目标测试（Node 22.21.1 / ChromeHeadless 152）：26/26 通过，覆盖任意目录配置、缺省/false、旧标记兼容、独立安装/置顶、用户卸载/取消置顶、目录刷新复用、离线缓存、产品范围、别名和工具栏容量。
- Electron 安装/版本管理测试：23/23 通过，含配置从目录校验、真实临时包解压安装到 Runtime config 的投影测试；验证 Chat 无隐式置顶且 `false` 生效。
- Chat 目录生成器测试：2/2 通过，验证 true/false 与未来 app 扩展字段保留。
- 本轮配置化相关测试合计 51 项通过。
- 宿主 `tsc -p tsconfig.app.json --noEmit` 通过。
- `guard-aily-chat-mainline.js` 通过，唯一 Chat UI 入口仍为 React 子应用。
- 串口 `node scripts/build-ui.mjs` 生产构建通过；紧凑 SCSS 4.92 kB 超过现有 4 kB 警告阈值，未达到构建错误阈值。
- 串口现有 Angular UI 测试 13/13 通过。测试环境既有 bootstrap 尝试连接 localhost:3000，产生两组 ECONNREFUSED 控制台输出，测试仍全部通过；实际浏览器页面没有这些错误。
- 浏览器运行生产 UI，使用独立临时日志目录；真实 Runtime 回读 `journalEnabled: true`，无串口设备连接或发送。完整/紧凑页面均无正常日志记录提示，更多设置开关、波特率选择 115200 → 9600、紧凑串口刷新操作通过。两个页面浏览器 error/warn 列表均为空。
- 截图均为 1280×720：
  - [完整界面](/Users/downey/.codex/visualizations/2026/09/17/01a0ae4d-e134-7241-97fc-0440ffe762c3/serial-full.png)
  - [紧凑界面](/Users/downey/.codex/visualizations/2026/09/17/01a0ae4d-e134-7241-97fc-0440ffe762c3/serial-compact.png)
- 两个仓库 `git diff --check` 通过。

## 现有问题及验证范围

架构检查因未修改文件中的 6 项现有违规返回失败：`extension-ui-boundary.spec.ts` 中 2 项跨域深导入及 1 项 UI 导入；`blockly-performance.spec.ts` 中 3 项深导入。本次未修改这些文件或重写基线。

安装验证覆盖编排、缓存、失败恢复及 Electron 临时包安装测试，未使用全新 Electron 用户目录执行远端完整下载安装。本轮未发布远端 subapp-index.json；运行中的 Electron 主进程也未重启加载新的解析逻辑。浏览器视觉验证为正式子应用 Runtime 的独立入口，不等同于宿主 Electron 内嵌窗口验收；未发布 npm 包或替换用户安装目录中的版本。
