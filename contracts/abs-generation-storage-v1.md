# ABS Generation Storage v1

状态：磁盘协议 v1；宿主桥接 API v2。实际编辑器已有显式 generation 协调器，尚未自动切换生产 Agent/legacy 入口。不得据此移除 legacy 导入的 v2 拒绝保护。

## 1. 分工

- `AbsBaselineStore` 决定不可变基线、prepared/committed 指针及 ABI → ABS → map 的恢复协议；不读写原生文件、不持有 Blockly 实例。
- `openAbsHostStorage` 检查宿主版本，取得绑定工程物理身份和同步上下文检查的能力。不回退到普通 `writeFile`。
- preload `fs.projectSyncStorageVersion = 2`、`fs.openProjectSyncStorage(projectPath, assertCurrent)` 实际执行文件访问；旧版宿主拒绝接入，不静默降级。
- `project-file-access.js` 是单文件保存和 generation 存储共用的路径/所有权/工程锁实现；跨仓库 Agent 共享磁盘协议，不导入主程序实现。

## 2. 能力与生命周期

内核消费的进程内能力保持不变：

```ts
interface Storage {
  read(key: string): Promise<string | null>;
  withLock<T>(operation: (locked: {
    read(key: string): Promise<string | null>;
    replace(key: string, expectedByteHash: string | null, content: string | null): Promise<boolean>;
  }) => Promise<T>): Promise<T>;
}
```

跨 `contextBridge` 的回调不能返回 renderer 的 Promise：Angular `ZoneAwarePromise` 不会被当作原生 Promise 桥接，可能复制为普通对象并提前释放锁。因此 API v2 使用同步返回 void 的回调和显式完成回执：

```ts
type Settlement<T> = { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } };
// locked 与上述内核的持锁能力相同。
withLock<T>(operation: (locked: StorageAccess, settle: (result: Settlement<T>) => void) => void): Promise<T>;
```

`openAbsHostStorage` 将 renderer Promise 留在 renderer 内，只通过 `settle` 返回可桥接结果或错误字段；宿主用原生 Promise 等待完成，之后才撤销能力并释放锁。直接返回非 void 的桥接回调会拒绝。磁盘记录、共同锁和内核接口不因此增加第二套事务协议。v1 仅在不含 Zone 的测试页面通过，不能视为实际 Angular 页面可用的证明。

`read` 不创建目录。外层没有 `replace`；所有写入必须使用回调传入的能力。不维护全局“当前锁”、不跨 IPC 返回可复用锁 token，也不允许 ABI 提交重新获取同一把锁。`AbsBaselineStore.commit` 将同一能力作为第三个参数传给 ABI 提交回调；此回调只消费已经准备好的持久化文本，不重新生成代码/捕获工作区。

进程内异步回调完成（跨桥接时为完成回执到达）后撤销能力；未 await 的写入先完成或在最终保护处失败，全部排空后才能释放锁。保存逃逸的函数不能在后续事务里继续写入。守卫必须同步返回 void，每次异步文件准备之后、最终 CAS/rename 之前检查；工程根/内部目录替换、链接、锁所有权改变均拒绝。上下文失效与无法判断的提交结果不能通过自动重试/回滚“修复”。

## 3. 文件白名单

| key | 物理位置 | 写入限制 |
| --- | --- | --- |
| `project.abi` / `project.abs` / `project.abs.map.json` | 工程根同名文件 | 精确 UTF-8 字节 CAS，不允许删除 |
| `baselines/<generation>.json` | `.aily/abs-sync/baselines/` | generation 为 1–96 位字母、数字、下划线或连字符；仅首次创建，不覆盖、不删除 |
| `prepared.json` | `.aily/abs-sync/prepared.json` | CAS 发布/删除，恢复中的持久化写屏障 |
| `committed.json` | `.aily/abs-sync/committed.json` | CAS 发布，不允许删除 |

拒绝绝对 key、路径穿越、反斜杠/NTFS stream、额外文件。缺失与空文本不同；哈希为 `sha256:<64 位小写十六进制>`。单个记录/镜像上限 128 MiB；旧文件必须是普通单链接文件，读取文本要求 UTF-8 可逐字节还原，不能用替换字符掩盖损坏。临时文件在目标目录内，以 `.abs-sync-<UUID>.tmp` 独占创建，写入/fsync 后再 rename。

## 4. 共同锁与持久化屏障

同一物理工程的三个镜像和上述日志共用 `.aily/project-files.write.lock`。锁覆盖整个异步 generation 回调，不是多个单文件 CAS 各自加锁。遵循 [Project File Lock v1](project-file-lock-v1.md)。

`prepared.json` 存在时，即便锁已释放，普通 Blockly 保存/导出以及 Agent 镜像历史事务仍返回 `ABS_TRANSACTION_PENDING`；内容损坏、空文件也不能视为“没有事务”。普通写入者不解析或修复该日志，不自动删除它。只有 generation 协调器的显式 `recover` / `abandon` 路径可以核对实际字节后推进或解除屏障。新端口只提供机制，不新增后台自动恢复任务。

另存为仅过滤上述明确临时命名空间和活跃锁，保留 prepared、committed、全部基线、资源及未知用户文件。此过滤不是一致性快照；复制后的 scope 重绑定仍由后续项目协调器处理。

## 5. 结果与限制

- `replace=false` 是确定的 CAS 冲突；可确认已发布的精确字节返回 true，即使 rename 的调用端随后报错。
- 无法读回、第三方字节介入或锁清理/所有权不确定时返回错误，保留日志；不能把它宣称为已回滚。
- 内核 `COMMITTED` 只有在 ABI/ABS/map 与指针符合该 generation 时成立；`MIRROR_PENDING` 允许重启后只补镜像，绝不重放 ABS 导入或 ABI 保存。
- 这不是任意外部写入者的操作系统级隔离，也不是断电下多文件原子 fsync 保证。突发进程退出可留下锁，仍需显式核验所有权，绝不按年龄/PID 抢锁。
- `AbsWorkspaceSyncService` 已连接 FIFO/租约、运行时配置版本、Project Data、原生/分片装载、完整读回与已准备 ABI；已有只读 pending 诊断及显式 recover/abandon API。恢复只处理磁盘，不重新装载、生成或保存 ABI，也不解除编辑器隔离。
- 新块已支持具有实际注册来源证明的声明式形状：先确定字段及默认值，再执行完整读回，不能任意接纳运行时新增默认值。生产 Agent 工具已通过 [generation tools v2](abs-generation-tools-v2.md) 连接同一协调器。显式复制/切页/公开 map 重绑定复用 export：只读跨 scope 校验不放宽 load/commit/recover，stage 可固定 expectedCommitted，新增可选 inputMap 保留精确旧镜像并校验原哈希。含未知 extension/mutator、自定义字段工厂及变形块的准备态 serializer 合同、资源 pin 与完整用户恢复 UI 仍需后续实现；无法验证的新形状在装载前拒绝。其他页面/工程外壳必须保持原样；代码/头文件/package 元数据是提交后的派生产物，不在本协议的共同提交范围内。

## 6. 验证

主程序执行：

```powershell
node --test --test-concurrency=1 --test-reporter=tap electron/project-file-writer.test.cjs electron/project-file-copy.test.cjs electron/project-file-writer-bridge.test.cjs electron/project-sync-storage.test.cjs electron/project-sync-storage-bridge.test.cjs electron/project-agent-publication.test.cjs
```

Electron 桥接用例加载实际完整 preload、Zone.js 和当前 v2 内核源码构建的测试 bundle，创建临时工程；断言 Zone Promise 异步回调完成后才返回结果，以原 ID/保护属性/休眠 shadow 生成基线、编辑、合并，模拟 ABI 已提交后中断，销毁并重建 renderer，再按磁盘记录恢复并核对字节。该组是内核桥接测试；实际 Angular 页面与用户工程副本的协调器验证见执行方案第 33–34 节，实际 Agent 工具注册表、文件编辑及 history 事务接入验收见第 35 节，复制/切页/公开 map 修复及修复后应用验收见第 36 节。C++ 编译不在这些测试范围内。
