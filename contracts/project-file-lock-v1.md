# Project File Lock v1：跨应用工程文件写入协议

适用双方：Blockly `electron/project-file-access.js`（单文件 writer 与 generation storage 共用）与独立 Aily Chat Agent 的
`aily-lex-pro/packages/aily-agent/src/operations/project-file-lock.ts`。
共享的是以下磁盘协议，不是跨仓库相对引用或运行时依赖；双方各自正常构建/打包。

## 1. 身份与所有权

- 管理文件：工程根的 `project.abi`、`project.abs`、`project.abs.map.json`。Windows 文件名大小写等价。
- 互斥范围：同一物理工程目录，不按文件分锁；工程目录别名先解析为物理路径。
- 锁文件：`<工程根>/.aily/project-files.write.lock`，`wx` 独占创建，UTF-8 JSON 内容为 `{ "pid": number, "token": string }`，token 每次获取都唯一。
- `.aily` 不允许为符号链接。持锁期间检查工程根、锁目录及锁的身份/所有权；只释放本次拥有的锁，失败时保留并报告。
- 任何既有锁都视为忙，包括旧 PID、无法解析内容和空文件。不得按时间/PID 猜测自动删除或抢占。

## 2. 写入边界

1. 候选生成可在锁外；提交时必须再次核对之前读到的精确字节。不存在与空文件不同。
2. 取得锁后校验整批候选的预期状态；Agent 历史事务还校验已有文件模式。
3. 锁覆盖写入、提交校验及本次失败恢复。多个工程按规范物理路径排序获取，失败释放已取得的锁。
4. Blockly 可异步短间隔等锁并检查项目会话；Agent 的同步历史提交立即返回 `PROJECT_FILE_BUSY`，不阻塞事件循环等待。调用者应重新核对上下文后重试。
5. 临时文件必须独占创建，写入/flush 后再 rename。工程镜像约定名称为 `.<文件名>.<UUID>.tmp`；迁移原文临时文件为 `.project-data-backup.<UUID>.tmp`。仅清理自己的临时文件。
   generation 临时文件为目标目录内 `.abs-sync-<UUID>.tmp`，仅位于工程根、`.aily/abs-sync/` 或其 `baselines/`；保留该目录中的正式基线与恢复指针。
6. 成功由提交后读回校验及持久化事务状态确定。日志/锁清理失败不能触发已确认提交的旧内容回滚。
7. 只读依赖（例如生成 ABS 的 ABI）也参与共同锁及提交前/后校验；无变化输出不改写目标，但仍持锁验证源和目标。事务回滚只恢复输出，不回滚外部修改的源文件。

## 3. 恢复与复制

- 恢复前检查整个恢复计划：当前文件必须等于该事务记录的 before 或 after（含不存在状态），否则保留外部内容及恢复记录并明确失败；写前再次验证。
- 精确锁名及上述 UUID 临时名不进入可复制的工程活跃状态或 Agent 内容快照。不要因此排除整个资源目录、普通 `*.tmp` 或备份材料。
- 本协议不等于 ABS/map generation 事务、资源引用 pin 或电源故障下的跨文件原子持久化，也不能阻止不遵守协议的外部程序。
- 当前 Agent 离线 ABS 初始化/导出、普通 read/edit/write 和 Code Mode 工程镜像写入已复用 history transaction；外部命令、直接追加/删除/补丁仍须逐入口接入，不能把现有接入理解成所有写入者均已覆盖。
- Agent 直接发布使用 `.aily/file-publications` 保存既有事务格式及 before/after blobs，与会话 timeline 分开。共同锁内发现未完成记录即拒绝新发布，保留内容并要求显式恢复；不根据日志年龄自动恢复或清理。
- `.aily/abs-sync/prepared.json` 是 generation 的持久化写屏障；即使锁已释放或日志无法解析，普通 Blockly/Agent 镜像发布也须拒绝，等待宿主显式恢复/放弃。只有 [ABS Generation Storage v1](abs-generation-storage-v1.md) 内部恢复路径可以持锁核对并处理它。
- 加锁不证明转换语义无损。当前 headless 导入仅可初始化空工程；无法表达或验证 Project Data 的转换必须保留原镜像并返回能力错误，由主程序后续权威投影协议解决。

## 4. 互操作验收

Blockly 仓库执行 `node --test electron/project-agent-publication.test.cjs`；默认使用同级
`aily-lex-pro/packages/aily-agent` 的最新 dist，也可用 `AILY_AGENT_ROOT` 指定。
测试两个方向：Blockly 持锁时独立 Agent 拒绝；Agent 历史事务持锁时 Blockly 等待并在释放后完成。
`scripts/project-data-electron-smoke.cjs` 设置同一环境变量后还验证真实可见 Electron/full preload 链路。
页面专项还通过 `electron/test/project-agent-prepared.cjs` 加载当前 Agent 的真实动态 read/write 工具：读取版本后由页面保存更新 ABI，旧版本替换必须被拒绝。此测试不发送模型请求，也不代表已安装子应用分发包自动更新。
