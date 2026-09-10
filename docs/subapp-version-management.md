# 子应用预下载与版本切换方案

> 状态：已按方案实施；macOS 自动化、真实 npm 包和 `store` 实际运行验证完成，Windows 实机占用场景待验收。

## 1. 结论

采用“版本目录 + 活跃版本清单 + 启动绝对路径”的方式，默认不把旧 npm 安装目录改成软链接。

- A 是新版本的独立安装目录。例如：
  `/Users/downey/Library/aily-project/npm-global/app/store/subapp-aily-chat/0.1.33/source`
- B 是旧版 npm 安装目录：
  `/Users/downey/Library/aily-project/npm-global/app/node_modules/@aily-project/subapp-aily-chat`
- B 保持原样，继续兼容旧版 `npm install`、旧主程序和现有开发链接。
- 新主程序通过 `active.json` 选择 A，启动子应用时把 A 的绝对路径写入运行配置，并通过进程环境变量传给子应用。
- 已经运行的进程固定使用启动时的目录。切换清单只影响下一次启动，不移动、覆盖或删除正在使用的版本。

不推荐让 B 直接指向 A。即 `B -> A` 在 macOS 上使用目录软链接、Windows 上使用 junction，技术上可以实现，但会让 B 同时承担“npm 管理目录”和“版本指针”两种职责，旧 npm 更新、卸载、锁文件以及多进程切换容易互相破坏。

## 2. 设计目标

1. 发现新版本后自动完成下载、完整性校验和解压；符合 portable 规范的包不再运行 npm，用户下次打开子应用时无需等待。
2. 新旧版本同时保留，切换失败时仍可启动上一个完整版本。
3. 兼容 B 中已有的普通 npm 安装，以及现有 `dev:link` 创建的开发软链接或 Windows junction。
4. macOS 与 Windows 使用同一状态模型，不依赖 Windows 的符号链接权限。
5. 多个主程序窗口或进程并行运行时，不改动其他进程已经打开的目录。
6. 不让子应用版本切换修改主安装根目录的 `package.json`、`package-lock.json` 或其他子应用依赖。
7. 下载失败、依赖安装失败、包内容损坏和清单写入失败均不改变当前可运行版本。

## 3. 目录定义

安装根目录记作 R：

```text
R = ${AILY_NPM_PREFIX}/app
```

未设置 `AILY_NPM_PREFIX` 时：

- macOS：`~/Library/aily-project/npm-global/app`
- Windows：`%LOCALAPPDATA%\aily-project\npm-global\app`

以 Aily Chat 0.1.33 为例：

```text
R/
├── package.json
├── package-lock.json
├── node_modules/
│   └── @aily-project/
│       └── subapp-aily-chat/             # B：旧 npm 安装或开发链接
└── store/
    ├── .locks/                         # 多进程安装、选择和卸载互斥 token
    ├── .uninstalling/                  # 仅失败恢复期间存在的卸载事务标记
    └── subapp-aily-chat/
        ├── active.json                    # 新主程序的持久版本选择
        ├── download-cache/                # 可清理的下载缓存
        ├── 0.1.32/
        │   ├── ready.json
        │   └── source/                    # 上一个完整版本
        └── 0.1.33/
            ├── package.tgz                # 可选保留的原始包
            ├── ready.json                 # 完整性与运行环境记录
            └── source/                    # A：实际 package root
                ├── package.json
                ├── package-lock.json      # 仅 legacy npm prepare 需要
                ├── node_modules/          # portable 内置或 legacy 准备的依赖
                ├── server/
                ├── runtime/
                └── ui/
```

`subapp-aily-chat` 是由目录中的正式存储键生成的稳定名称。`ready.json` 必须同时保存完整 npm 包名 `@aily-project/subapp-aily-chat`，防止不同 scope 或目录名碰撞。

旧的 `app/migration` 目录已直接替换为 `app/store`，主程序与 Agent 均不再读取、写入或恢复 `migration`。它不是长期兼容入口；已有试运行数据只允许在确认无进程占用时原位改名，无法验证的数据则删除并重新下载。

`store/.locks` 只保存多进程互斥 token：同一子应用只能由一个进程准备，激活/启动握手与卸载也不能交叉。锁目录按 storeKey 命名，不带版本号，不属于任何已安装版本。它不保存安装包或源码，死亡进程的 token 会被判定为无效；这个目录是并发正确性所需的运行元数据，因此保留。

A 的 `source` 是可直接运行的 package root。推荐的子应用发布物必须是 self-contained portable 包：运行依赖已打进包内、没有必须在用户机器执行的 install/postinstall、入口指向预构建文件。当前机器上的 `subapp-aily-chat@0.1.33` 已声明 portable，且 `dependencies` 为空，符合直接解压方案。

不符合 portable 规范的旧包不能假装成可直接运行的 A。它们进入独立的 legacy npm prepare 分支，在 A 内准备依赖，不触碰 R/B；需要执行安装脚本时，还必须经过可信目录和包策略校验。

版本目录完成后视为不可变。相同版本需要修复或重装时，先在同级临时目录准备；只有确认没有进程使用损坏目录时才替换。若仍被使用，则推迟到所有持有者退出，不能原地覆盖。

## 4. 为什么不建议让 B 指向 A

这里的“将 A 软连接到 B”按实际文件系统语义解释为：B 是链接入口，目标为 A，即 `B -> A`。

| 方案 | 旧路径透明 | 旧 npm 兼容 | Windows 行为 | 运行中切换 | 回滚 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| B 软链接/junction 指向 A | 最好 | 较差 | 需要 junction，替换受目录占用影响 | 风险较高 | 需要额外备份 B | 不作为默认方案 |
| 把 A 复制或移动到 B | 最好 | 一般 | 容易遇到 EPERM/EBUSY | 会改动运行目录 | 成本高 | 不采用 |
| B 保留，`active.json` 选择 A | 新代码需使用 resolver | 最好 | 不依赖链接权限 | 安全 | 原子改清单 | 推荐 |
| `store/.../current` 链接到 A，B 保留 | 需要新稳定路径 | 好 | 仍有 junction 限制 | 一般 | 较简单 | 可选辅助，不作真相源 |

直接修改 B 的主要问题：

1. B 当前属于 R 下的 npm 依赖树。旧版 `npm install`、`npm uninstall`、`npm dedupe` 会根据根 `package.json` 和 `package-lock.json` 整理 B，可能删除或替换链接。
2. B 目前是普通目录。第一次改为链接必须先移动或删除原目录；macOS 上运行进程可能继续持有旧文件，Windows 更容易因 cwd、Node 模块或杀毒软件占用而返回 `EPERM`/`EBUSY`。
3. Windows 应使用目录 junction，目标必须是绝对路径；junction 只能指向目录，并且不适合网络共享目录。Node 的链接 API也明确区分 Windows junction 与普通目录链接。
4. npm 的 bin shim、锁文件和实际 B 内容会出现不同来源。旧代码通过 `npm ls` 得到的版本可能与 B 最终指向的版本不一致。
5. 多个主程序实例同时切换 B 时，一个实例可能在另一个实例启动期间替换链接，使入口路径的含义发生变化。

如果以后确认所有旧 npm 写入已经停止，可以增加一次性的冷迁移：主程序完全退出后把 B 归档，再创建 `B -> A`。这只能作为后续兼容模式，不能作为当前默认更新机制。

### 4.1 如果坚持使用 B -> A

该方案只有在以下条件同时满足时才可用：

1. 所有主程序实例和子应用进程已经退出。
2. 没有旧版 npm 安装、卸载或 dedupe 可能写入 R。
3. 先把普通目录 B 原子归档为可回滚目录，再创建临时链接并提升为 B。
4. macOS 使用 directory symlink；Windows 使用本地 NTFS directory junction，目标为绝对路径。
5. 根 `package.json`、锁文件和 `.bin` 不能再作为实际版本依据。
6. 切换失败时恢复归档的普通 B，而不是留下断链。

这些条件实际上取消了“旧 npm i 继续兼容”，所以本方案只适合未来完成旧机制退役后的冷迁移。

## 5. 推荐的版本选择模型

`active.json` 是新主程序的持久真相源，环境变量不是持久状态。

示例：

```json
{
  "schemaVersion": 2,
  "packageName": "@aily-project/subapp-aily-chat",
  "storeKey": "subapp-aily-chat",
  "disabled": false,
  "mode": "auto",
  "selected": {
    "version": "0.1.33",
    "path": "0.1.33/source",
    "integrity": "sha512-..."
  },
  "previous": {
    "version": "0.1.32",
    "path": "0.1.32/source"
  }
}
```

清单只保存相对于 `store/subapp-aily-chat` 的路径，不能保存 `/Users/...` 或盘符绝对路径。这样整个 R 可以随用户目录、安装盘或 `AILY_NPM_PREFIX` 一起移动。

解析顺序如下：

1. 如果 B 是受管理的开发软链接或 junction，使用 B。开发态必须明确优先，避免正式更新覆盖本地调试。
2. 如果 `active.json.mode` 是显式回滚或固定版本，验证 selected 后使用 A。
3. 自动模式下，同时检查 selected、previous 和普通目录 B。选择其中完整且版本最高的候选，防止旧主程序刚通过 npm 把 B 更新到更高版本后，新主程序仍启动较旧的 A。
4. selected 损坏时，依次验证 previous 和 B；校验失败的目录不能启动。
5. 没有 `active.json` 时直接使用 B，保持现有用户无迁移启动。
6. 若存在“卸载中”事务标记，立即视为未安装，不解析 A、B 或 previous。该标记只用于崩溃恢复；成功卸载后连同所有版本一起清除。

候选目录至少校验：包名、精确版本、portable 契约、平台与架构、Node ABI、主入口、UI 入口、声明的 Agent manifest，以及 `ready.json` 中的完整性记录。

## 6. 环境变量和运行配置

主进程解析出最终目录后，运行配置保存绝对 `packagePath`。子进程至少接收：

```text
AILY_SUBAPP_INSTALL_ROOT=<R>
AILY_SUBAPP_PACKAGE_PATH=<本次解析出的 A 或 B>
AILY_SUBAPP_VERSION=<本次实际版本>
AILY_SUBAPP_SOURCE=version-store|legacy-npm|development
```

环境变量只描述本次进程的运行上下文：

- 子应用不能依靠环境变量决定下一次启动版本。
- 主程序不修改系统环境变量或用户环境变量。
- 子进程的入口、cwd、UI、i18n、技能和 Agent 工具均从同一个 `packagePath` 解析。
- 已启动的进程保留自己的绝对路径；之后修改 `active.json` 不影响它。

对主程序内部代码，建议只暴露一个解析接口：

```ts
resolveInstalledSubapp(packageName, catalogId): {
  packagePath: string
  version: string
  source: 'version-store' | 'legacy-npm' | 'development'
}
```

Header、App Store、child-tool host、模拟器、i18n 和 Agent 发现均使用这个结果，禁止各自拼接 `R/node_modules/...`。

## 7. 预下载与切换流程

### 7.1 预下载

1. 从当前区域的 `subapp-index.json` 取得明确的包名和目标版本，不能把 npm `latest` 当成目录目标。
2. 解析该精确版本的 tarball URL 与 SRI；下载到 `download-cache` 的临时文件。
3. 在 Worker Thread 中校验 SRI，并解压到同一文件系统内的 `.staging-<UUID>/source`；主进程只接收进度消息，不能用同步大文件 I/O 阻塞 Electron 事件循环。
4. 解压时拒绝绝对路径、`..`、盘符、反斜杠绕过、符号/硬链接、Windows 保留名、重复路径和大小超限。
5. 验证包名、版本、portable 契约、入口、UI、平台、架构、Node ABI 和 Agent 声明。
6. portable 包直接写入 `ready.json`，不运行 npm，也不执行生命周期脚本。
7. 非 portable 旧包进入隔离 npm prepare：只在 A 内安装 production dependencies，保留版本自己的锁文件；不得在 R 根目录执行 npm reify。
8. 把 staging 原子提升为 `0.1.33`。任何失败只清理本次 staging。

npm 官方说明，普通安装会同时安装 dependencies，并可能执行生命周期脚本。因此后台预下载不能把任意 npm 包直接当作被动数据处理。正式子应用应优先使用 portable 发布契约；legacy npm prepare 只是旧包兼容路径，并受目录信任策略约束。

### 7.2 激活

1. 预下载完成后直接校验并解压到独立版本目录，但不修改运行中旧进程的目录或版本选择。
2. 如果用户在后台检查、下载或解压期间打开子应用，本次启动固定使用点击时已经存在的 B 或已选旧版 A；下载流程不得延迟启动，也不得用进度遮罩占用子应用内容区。
3. 旧进程运行期间只在 Header 显示下载/解压进度；准备完成后 Header 与 App Store 显示“重启”。只有用户手动确认重启后才原子切换版本选择、停止旧进程并启动已准备版本。
4. 如果新版在用户打开之前已经准备完成，且子应用处于关闭状态，下一次打开会自动激活并启动最新版，不额外要求点击“重启”，也不在后台自行弹出子应用窗口。
5. 激活时获取短时选择锁，重新读取 B 与 `active.json`，避免慢下载把已激活的更高版本降级。
6. 把旧 selected 写入 previous，再以“临时文件 + flush + rename”更新 `active.json`；清单替换失败时保留旧清单。
7. 释放选择锁，以选中的绝对路径启动子应用。

### 7.3 回滚

- 新版本尚未启动成功：保持 selected 不变，记录准备失败。
- 新版本入口启动失败：把 previous 恢复为 selected，下一次启动使用旧版。
- 新版本运行后崩溃：是否自动回滚应由连续启动失败计数决定，普通业务错误不能自动降级。
- 回滚只修改选择清单，不复制、移动或删除 A/B。

## 8. 与旧 npm 安装的兼容边界

### 必须兼容

- B 是普通 npm 目录时，新主程序可以直接读取和启动。
- B 是现有 `dev:link` 时，开发版本优先。
- 旧主程序继续通过 R 根目录的 `npm install` 更新 B，不受 A 的目录结构影响。
- 新预下载流程不能修改 R 根 `package.json` 和 `package-lock.json`。
- 新主程序发现 B 的版本高于自动选择的 A 时，优先 B，并在后台把该版本准备到 A；不能发生版本倒退。
- 旧包原有的 npm 依赖与脚本行为只能在隔离 prepare 或 B 中运行，不能污染其他版本。

### 8.1 完整卸载

卸载一个子应用必须清除该子应用的全部版本和兼容入口，而不是只切换选择状态：

1. 先停止当前主程序持有的该子应用进程，并检查其他主程序或子进程是否仍持有 B 或版本目录；Windows 通过进程命令行枚举，macOS/Linux 通过 `ps` 命令行枚举并取得 PID。占用检查未通过时保持现有安装可见，不得提前伪装成“未安装”，用户确认后才能终止这些进程并重试。
2. 确认可以开始破坏性清理后，在 `store/.uninstalling/<storeKey>.json` 写入临时事务标记。解析器看到标记后立即停止返回 A/B，防止半删除目录重新生效。
3. 删除 B、`store/<storeKey>` 下的 `active.json`、所有版本、staging 和该包专用下载缓存；标记存在期间禁止安装或默认保底逻辑重新拉起同一子应用，只允许继续卸载清理。
4. 删除临时更新缓存中的该子应用目录。
5. 只从 R 根 `package.json`、`package-lock.json` 和属于该包的 `.bin` shim 中移除该包记录；不得修改其他子应用记录或共享依赖。
6. 删除后必须再次核验 B、`store/<storeKey>` 全目录、该子应用下载缓存以及 R 根依赖记录均不存在，才允许删除“卸载中”标记并报告成功。任一旧版或兼容入口残留都视为卸载未完成；App Store 将该状态显示为待继续卸载，点击卡片只会重试清理，不会误走安装。

### 无法完全兼容的情况

- 成功卸载后 A、B 与该子应用缓存均不存在；旧主程序也不能从 B 再发现该应用。崩溃恢复期间，旧主程序不理解“卸载中”标记，因此卸载前仍需停止所有已知持有进程。
- 旧外部脚本若硬编码 B，只会访问 B，不会自动访问 active A。需要使用统一 resolver、主程序 IPC 或新的 CLI wrapper。
- A 与 B 各自拥有依赖树，会增加磁盘占用；这是换取运行隔离和可靠回滚的成本。

当前机器的 B 是 `@aily-project/subapp-aily-chat@0.1.33` 普通目录，包已预构建、`dependencies` 为空，适合 portable 直接解压。R 根依赖记录仍引用一次性 `.subapp-download-.../package.tgz`，说明旧下载目录曾泄漏到 npm 持久元数据。新方案不能复制这种写法；以后若需要修复旧 B，只能在受控的旧 npm 兼容操作中把依赖记录改为精确版本，不能由 A 的预下载流程顺手改写。

## 9. macOS 与 Windows 约束

### macOS

- 使用 `path.join`/`path.resolve`，并在调用 npm 前统一 `realpath`，避免 `/var` 与 `/private/var` 别名导致锁文件路径不一致。
- 新版本目录与 staging 必须位于同一文件系统，保证目录 rename 可以作为发布步骤。
- 更新和回滚不删除仍可能被运行进程延迟读取的旧 source；显式卸载则先停止并核对持有进程，再删除该子应用全部 source。

### Windows

- 默认方案不创建 symlink 或 junction，因此不依赖开发者模式、符号链接权限或 NTFS reparse point 切换。
- 路径必须支持空格、中文和较长的 `node_modules` 路径。
- npm 应以 `node.exe + npm-cli.js` 和参数数组启动，避免 `cmd.exe` 对 `%`、`&`、括号和引号再次解释。
- 写 `active.json` 时允许短暂重试 `EPERM`、`EACCES`、`EBUSY`，失败后继续使用原清单。
- 锁的释放必须验证自身 token，死亡进程只能被判定为无效持有者，不能通过删除一个共享锁文件误删另一个进程刚创建的锁。
- 如果未来启用 `B -> A` 兼容模式，Windows 必须使用 directory junction 和绝对目标；网络共享目录不能作为 junction 目标。

## 10. 分阶段落地

### 阶段一：只读兼容

- 引入统一 resolver。
- 能读取 B、开发链接和 active 清单。
- 所有运行入口改用 resolver 返回的 `packagePath`。
- 不创建 A，不改变 B。

### 阶段二：预下载但不自动激活

- 按精确版本准备 A。
- App Store 展示“已下载，待启用”。
- 验证下载、依赖安装、完整性和跨平台路径。

### 阶段三：下一次启动自动激活

- 子应用启动握手中更新 `active.json`。
- 加入 previous、启动失败回滚、多进程降级保护。
- 更新、激活和回滚期间 B 保留；显式卸载时 B 与 A 的所有版本一起删除。

### 阶段四：清理与可选链接模式

- 只清理没有进程持有、不是 selected/previous、超过保留期的版本。
- 若确有旧外部程序必须通过 B 访问新版，再单独评估冷启动 `B -> A` 模式；不能和旧 npm 写入同时启用。

## 11. 验收条件

1. B 仅有旧 `npm install` 时，主程序无需迁移即可启动。
2. A 预下载完成前、下载失败或依赖安装失败时，B/旧 A 仍可启动。
3. portable A 预下载完成后，切换不执行 npm、不访问网络，启动路径为 A。
4. 旧进程使用 0.1.32 运行时，新进程可以使用 0.1.33；旧进程的延迟模块和资源读取仍成功。
5. 两个主程序同时下载、切换时只产生一个完整版本，慢任务不能覆盖更高版本。
6. active 清单损坏、A 缺入口或 UI 时，回退到经过验证的 previous/B。
7. 旧 npm 更新 B 到更高版本后，新主程序不会启动更低的自动版本。
8. 开发软链接或 Windows junction 始终优先，正式自动更新不覆盖开发目录。
9. macOS 真机覆盖空格、中文路径、`/var` realpath、旧新进程并存。
10. Windows 真机覆盖空格、中文路径、npm 参数、杀毒软件短时占用、多实例和异常退出恢复。
11. Header、App Store、模拟器、i18n、Agent 工具和技能读取的是同一个 resolved packagePath。
12. R 根 `package.json`、`package-lock.json` 和 B 在 A 的预下载、激活、回滚过程中逐字节不变。
13. 卸载成功后，该子应用的 B、`store/<storeKey>` 全部版本、staging、active 选择和下载缓存均不存在，R 根清单只移除该包记录，其他子应用逐字节不受影响。
14. Windows 文件占用导致卸载失败时保留“卸载中”标记，解析器不启动残留目录；释放占用后重试可完成全部清理。
15. 大包校验和解压期间 Electron 主事件循环持续响应，应用窗口、IPC 和子应用启动不被同步文件 I/O 阻塞。

## 12. 最终建议

优先实施清单/变量方案：B 保持旧 npm 兼容，A 保存完整的 portable 新版本，`active.json` 保存选择，`packagePath` 与环境变量把选择传入一次运行。

软链接适合 `dev:link`，不适合承担正式版本管理。若把 B 变成正式版本指针，就必须同时禁止旧 npm 对 R 的写入，并要求主程序完全退出后再切换；这与当前“老版本 npm i 逻辑需要兼容”的目标冲突。

参考资料：

- [npm install 官方说明](https://docs.npmjs.com/cli/v11/commands/npm-install/)
- [Node.js fs.symlink 与 Windows junction 说明](https://nodejs.org/api/fs.html#fssymlinktarget-path-type-callback)
- [Microsoft Windows junction 说明](https://learn.microsoft.com/en-us/sysinternals/downloads/junction)
