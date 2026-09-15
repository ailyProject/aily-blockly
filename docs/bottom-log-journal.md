# 底部日志文件化改造

主软件底部日志仍由 `LogService.update()` 接收，编译、上传、依赖安装和子窗口调用方无需更换入口。渲染进程保留最多 500 条短预览，用于同步订阅者和无 Electron 的开发场景；完整日志以 JSONL 写入主进程的 `<AILY_APPDATA_PATH>/logs/bottom-panel/<会话>/`。每个应用启动会话有独立目录，Coder 工程日志使用独立流，主界面切换工程时切换读取流。

写入链路是：`update()` 立即通知业务订阅者，将日志积累到 64 KiB 或 50 ms 后通过单次 IPC 发送；主进程按流串行追加文件。底部面板按字节游标异步读取最近 500 条、滚动向上读取更早页面，并在新日志到达时增量读取。每次 IPC 页面请求最多返回 1000 条、约 256 KiB；界面最多保留 5000 条可见记录。超长单条日志先显示短预览，复制或发送给 AI 时再读取完整条目。搜索和错误筛选在文件读取阶段执行，导出从当前日志文件流式生成文本，不受界面窗口大小限制。

双击底部日志与右下角通知的“AI 处理”都通过 `UiService.openAndSendToChat()` 传递 `type: 'log'`。Aily Chat 沿用长文本粘贴的 450 字阈值：短日志进入输入框，超过阈值的完整 `log:\n...` 内容成为可编辑的文本文件块，并保留原有的输入框覆盖或追加语义。其他来源的外部输入不受此规则影响。

“清空”会切换到新文件段，旧段仍保留在该会话目录供诊断；面板、反馈和导出只读取当前段。启动时异步清理超过 7 天或使旧会话总量超过 512 MiB 的目录。文件写入错误会反馈到读取或导出操作，避免把内存缓存误报为已落盘。

验证入口：`node --test electron/bottom-log-journal.test.js`、`ng test --watch=false --browsers=ChromeHeadless --include=src/app/integrations/coder/coder-project-runtime.service.spec.ts`、`playwright test e2e/tests/bottom-log-journal.spec.ts`。最后一项使用隔离应用数据目录，从现有跨窗口日志入口产生一条日志，核对面板显示、JSONL 文件、搜索和清空。
