# 已登记临时源码验收

这组夹具从正常桌面 Blockly、配套 Chat 与真实在线 Agent 的三轮验收提取。它只准备参数化请求、读取实际文件和会话证据、验证结果；不会创建 ABS、候选、checkpoint、认证或安装配置。项目、测试拥有的父目录及审核清单路径均由调用者显式传入，不绑定某个项目、模型、服务器或用户目录。

包含三个顺序场景：

1. `registered-live-delete`：Agent 复制当前源码到独特的 `.aily/temp` 文件，经 `abs_export(outFile)` 正常登记，再用 Pi read/edit 添加头部注释，最后真实删除。
2. `registered-live-rename`：同一 Chat 创建另一份别名并正常登记、编辑，真实 Move 到未登记的新名，目的必须逐字等于编辑稿。
3. `registered-live-restart`：真正重启桌面后，仍在同一 Chat 聚合读取；两个旧名不存在，新名保持全部编辑字节，不重新登记或执行 Shell。

主项目的 ABI、ABS、map、发布指针和实际 Working 文档必须保持不变。原稿、编辑稿及其完整不可变对象闭包必须可读。此处不 apply、保存、编译或烧录，也不清理 History、草稿或备份。

## 接入实际驱动

`registered-live-source.mjs` 保留五个观察接口。现有安装态 Chat 的 `loadedChat.e2e('session.read', { sessionId })` 可提供实际 SDK snapshot；Host 的真实 `candidate_capture` 回包提供 Working facts。调用者仍负责已加载包指纹、正常桌面生命周期、实际输入框提交、默认权限模式、精确逐条命令审核，以及测试后的选择和配置恢复。

下面是驱动接线顺序，参数均来自实际运行，不能用生成的候选或模拟回执替代：

```js
const state = await prepareRegisteredLiveCase({
  name,
  project,
  ownedRoot,
  reviewManifestFile,
  sessionId,
  working,
  previous,
  snapshot,
  desktopInstance,
});
const prompt = fillRegisteredLivePrompt(promptTemplate, state);
// 用正常 Chat 输入框发送 prompt；新 Chat 的 sessionId 可在真实创建后绑定。

// 在允许每条原生命令之前，先获取同一个实际待审批调用与当前 snapshot：
await assertRegisteredLiveMutation(state, actualSnapshot, initialUsers, pendingCommand);
// 该函数仅对精确主命令核验登记证据；setup/只读辅助命令返回 undefined。
// 随后仍须由驱动审核完整 command，点击本次允许，不能自动扩大权限。
// 若 setup 附加了审核通过的只读检查，把完整审核记录记入
// state.setupApprovals；acceptanceRole 必须是 registered-live-setup。

const audit = await auditRegisteredLiveCase(state, {
  snapshot: actualFinalSnapshot,
  initialUsers,
  tools,
  approvals,
  workingAfter,
  fault,
  finalText,
  hostPid,
});
// 将 state 存为 result.boundaryPreparation，audit 存为 result.boundaryAudit。
// 下一轮传入这个实际 result；restart 前先真正重启桌面并保留同一 session。
```

`previous` 只接受上一个顺序场景已经完成且审计通过的实际结果，不包含开发时夹具失败的续接协议。首轮可使用空 sessionId；后续两轮必须使用前一轮的真实 sessionId。restart 同时比较进程身份与 PID，不能用重新读取同一桌面代替重启。

审核引用必须是准确的五字段对象：`file`、`entryHash`、`sessionId`、`toolCallId`、`commandHash`。文件必须等于传入的 `reviewManifestFile`，hash 和调用元组必须精确绑定整条实际命令。附加 setup 检查仅接受调用者明确审核并标注的记录，不做前缀匹配或命令用途猜测。

夹具只校验调用者提交的审核记录结构和绑定关系，不读取审核清单正文，也不充当权限系统。调用者必须事先核实清单原始条目及其 hash、真实待审批调用和页面显示的完整命令，并且只在实际点击本次允许后记录 `clicked`。不得把构造的审批对象当作真实授权。

现有 `createInstalledChatUiAgent` 有仅允许主源码写入和有限工具的约束，不支持这些 Shell/别名写入场景，不能直接绕过其断言调用。应在拥有逐条原生审核能力的正常桌面驱动中接入上述观察接口；这里没有提交另一个桌面启动器，也没有宣称仓库已有一键在线入口。`native-recovery-chat.acceptance.mjs` 的确定性本地模型路径也不能替代本组真实在线 Agent 验收。

## 证据边界

主命令获准前验证真实 `abs_export` 工具结果、SDK checkpoint 的精确引用、原稿/编辑稿不可变闭包、实际 Pi edit publication hash，以及 canonical 原文件前态。checkpoint 的 turnId 可能属于旧完成轮次，不能据此猜测活跃 view。

主命令完成后，私有源的物理事实以真实 `nativeProgramOutcome` 的 `execution.before/after` 验证：before 必须是编辑稿的准确 hash、字节数及非空身份，after 必须 missing，且已解除登记、普通捕获完成。canonical 的 before 还必须匹配获准前捕获的身份。两范围都需完整收尾；不能仅凭最终文字、文件消失或成功标记判断通过。新名再与不可变编辑稿逐字比较。

运行记录、原项目、截图、账号、认证及打包产物不随夹具提交。实际驱动应把结果保存到自己专用的 `e2e/test-results` 输出目录，保留包指纹和真实观察来源。这里的离线检查只验证证据适配器，不是再次运行桌面或在线 Agent。

```sh
node --test tests/electron/registered-live-source.test.mjs
```
