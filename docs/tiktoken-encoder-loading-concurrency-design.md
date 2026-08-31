# Tiktoken 编码器加载、切换与异步竞态治理方案

> 状态：核心方案已实施并完成定向验收  
> 适用仓库：`aily--blockly`  
> 适用模块：Angular 宿主中的 Aily Chat 兼容层 `TiktokenService`  
> 更新时间：2026-08-20  
> 目标：消除启动重复 fetch，保证 `o200k_base` / `cl100k_base` 真正切换，并使主线程与 Worker 在快速模型切换下保持一致

## 0. 决策摘要

本方案不采用“在现有代码上补一个 early return”的局部修补，而是把编码器的**加载状态**与**当前活动状态**拆开管理：

1. 以编码器名称为 key 缓存加载 Promise，同一编码器任意数量的并发请求只执行一次资源加载、JSON 解析和实例构造。
2. `loadEncoder(encoding)` 必须使用显式参数，加载过程中不得读取或修改可变的当前模型状态。
3. 以单调递增的 `switchRevision` 标识模型选择版本；加载完成可以进入缓存，但只有仍匹配最新 revision 的结果才能激活。
4. `desiredEncoding` 与 `activeEncoding` 分离。目标编码器未就绪时使用现有启发式 fallback，不允许继续用旧模型的编码器冒充新模型的精确结果。
5. Worker 保持单实例，在 Worker 内按编码器名称维护编码器 Map；每个计数请求显式携带编码器名称，不依赖 Worker 内的隐式“当前编码器”。
6. 精确 token 缓存按编码器隔离；fallback 结果不进入精确缓存，避免编码器加载完成后继续命中旧估算值。
7. 失败状态按编码器隔离，并带短暂冷却时间；一次本地加载失败与一次 CDN 回退属于同一个共享加载任务。
8. 移除 `TiktokenService` 构造函数中的无条件默认预加载，改为在启动模型恢复完成后请求目标编码器；并发去重仍作为必须保留的安全边界。
9. 所有 Worker 请求使用完整传输信封，并且在成功、结构化失败、同步 `postMessage` 失败、超时、`messageerror`、Worker 崩溃和服务销毁时都必须进入唯一终态。

实施结果（2026-08-20）：启动运行态只观察到 1 次 `o200k_base.json` GET/200，且仅创建 1 个 Tiktoken Dedicated Worker；跨编码器切换、缓存热切换、同编码并发去重、乱序完成和降级路径的 12 个定向用例全部通过。Angular 类型检查与 development build 通过。

完成后应满足以下关键不变量：

- 同一编码器同一时刻最多有一个加载任务。
- `activeEncoding` 对应的实例一定来自同名编码器。
- 过期加载结果可以缓存，但不能覆盖最新选择。
- Worker 计数一定显式指定编码器，不能因模型切换使用错误实例。
- 任意时刻最多存在一个由该服务管理的 Worker。

## 目录

- [1. 背景与范围](#1-背景与范围)
- [2. 当前问题与根因](#2-当前问题与根因)
- [3. 目标与非目标](#3-目标与非目标)
- [4. 必须保持的状态不变量](#4-必须保持的状态不变量)
- [5. 建议状态模型](#5-建议状态模型)
- [6. 编码器加载去重设计](#6-编码器加载去重设计)
- [7. 真正的编码器切换设计](#7-真正的编码器切换设计)
- [8. 启动加载优化](#8-启动加载优化)
- [9. 精确计数缓存隔离](#9-精确计数缓存隔离)
- [10. Worker 并发与生命周期设计](#10-worker-并发与生命周期设计)
- [11. 失败与重试策略](#11-失败与重试策略)
- [12. 公共 API 兼容性](#12-公共-api-兼容性)
- [13. 文件级改造范围](#13-文件级改造范围)
- [14. 测试方案](#14-测试方案)
- [15. 可观测性](#15-可观测性)
- [16. 实施步骤](#16-实施步骤)
- [17. 建议验证命令](#17-建议验证命令)
- [18. 风险与缓解](#18-风险与缓解)
- [19. 未采用方案](#19-未采用方案)
- [20. 验收标准](#20-验收标准)
- [21. 最终结论](#21-最终结论)

## 1. 背景与范围

主软件当前虽然以 React Aily Chat 子应用作为可见默认入口，Angular 宿主仍会在应用级运行时初始化链中构造旧 Aily Chat 的共享服务。`ChatService`、`ContextBudgetService` 和 `TiktokenService` 因此会在主软件启动期间进入依赖注入链，触发本地 BPE rank 数据加载。

当前资源大小：

| 编码器 | 本地资源 | 文件大小 |
|---|---|---:|
| `o200k_base` | `src/app/tools/aily-chat/assets/tiktoken/o200k_base.json` | 2,325,547 bytes |
| `cl100k_base` | `src/app/tools/aily-chat/assets/tiktoken/cl100k_base.json` | 1,090,792 bytes |

本方案只改造 Angular 宿主中的 token 估算兼容服务，不改变以下边界：

- 不修改 React Aily Chat 子应用自身的 Agent、上下文压缩或服务端 token 计算逻辑。
- 不修改模型到编码器的现有映射规则；映射准确性应作为独立议题验证。
- 不修改两份 BPE rank 数据文件及其 Angular assets 输出路径。
- 不把客户端本地估算升级为服务端上下文预算的权威来源。
- 不要求调用方在编码器加载期间阻塞 UI；未就绪时继续允许 fallback。

## 2. 当前问题与根因

### 2.1 启动时连续 fetch 两次

当前启动时序如下：

```text
Angular 创建 TiktokenService
  -> constructor()
  -> ensureLoaded()
  -> loadEncoder()
  -> 等待动态 import / fetch o200k_base.json

ChatService 同步恢复已保存模型
  -> loadChatModel()
  -> saveChatModel()
  -> ContextBudgetService.updateModelContextSize()
  -> TiktokenService.switchEncoderForModel()
  -> targetEncoding 仍为 o200k_base
  -> encoder 尚未生成，未提前返回
  -> loadingPromise = null
  -> ensureLoaded()
  -> 第二次 fetch o200k_base.json
```

`ensureLoaded()` 本来具备共享 `loadingPromise` 的意图，但 `switchEncoderForModel()` 在第一次请求仍未完成时主动将它清空，因此幂等保护被绕过。

重复行为不仅产生第二次网络记录，还会带来：

- 重复读取约 2.3 MB 的本地资源。
- 重复解析大型 JSON。
- 重复构造 `Tiktoken` 实例。
- 两条完成链分别调用 `initWorker()`，可能创建两个 Worker。
- 较早任务的 `finally` 可能把较晚任务的 `loadingPromise` 再次清空。

### 2.2 编码器可能没有真正切换

当前 `ensureLoaded()` 只判断 `this.encoder` 是否存在，不判断该实例属于哪个编码器：

```ts
if (this.encoder) return Promise.resolve();
```

当 `o200k_base` 已经加载，首次切换到尚未缓存的 `cl100k_base` 时：

1. `currentEncoding` 被修改为 `cl100k_base`。
2. 旧的 `this.encoder` 仍然是 `o200k_base` 实例。
3. `ensureLoaded()` 因 `this.encoder` 非空直接返回。
4. 日志可以显示“切换成功”，实际计数仍可能使用旧编码器。

这是功能正确性问题，而不仅是性能问题。

### 2.3 异步任务读取可变字段

当前 `loadEncoder()` 在多个 `await` 之后反复读取 `this.currentEncoding`：

```ts
const config = ENCODING_CONFIGS[this.currentEncoding];
this.encoderCache.set(this.currentEncoding, encoder);
```

如果加载期间模型发生变化，同一个任务开始时、请求时、缓存时和打印日志时可能看到不同编码器名称，导致：

- 资源 A 被错误缓存到 key B。
- 晚到结果覆盖新模型选择。
- 日志名称与实际加载资源不一致。
- Worker 收到与当前活动模型不一致的数据。

### 2.4 单个全局失败状态不适合双编码器

`loadFailed` 是一个全局布尔值。某个编码器失败后，它无法表达：

- 哪个编码器失败。
- 另一个编码器是否仍可加载。
- 失败发生时间。
- 何时允许重试。
- 当前失败是否已经被新的成功结果取代。

并发路径中对 `loadFailed = false` 的直接重置还会让多个调用重复触发本地加载与 CDN 回退。

### 2.5 Worker 使用隐式单编码器状态

当前 Worker 只有一个模块级 `encoder`。主线程每次加载成功都会创建新 Worker 并发送 `init`，缺少以下约束：

- 没有保证 Worker 只创建一次。
- 没有记录 Worker 当前持有哪个编码器。
- 计数请求不携带编码器名称。
- 旧 Worker 的晚到消息可能访问共享 `pendingRequests`。
- 切换时没有终止或复用旧 Worker。
- Worker 初始化未完成时只能依赖一个全局 `workerReady` 布尔值，无法表达“哪个编码器已就绪”。

### 2.6 token 缓存可能跨编码器或跨 fallback 污染

当前 token cache 只以文本作为 key，并且 fallback 结果也会写入缓存。虽然切换和加载完成时尝试 `clear()`，但并发完成顺序不稳定，仍存在：

- 同一文本在不同编码器之间复用错误计数。
- fallback 估算在精确编码器可用后继续被命中。
- 过期加载任务清空新编码器刚生成的缓存。

## 3. 目标与非目标

### 3.1 目标

1. 冷启动恢复到默认编码器时，`o200k_base.json` 只 fetch 一次。
2. 多个调用在缓存产生前同时请求同一编码器时，共享同一个加载条目；缓存写入后的调用可直接返回缓存，但不会产生第二次 fetch。
3. 从 `o200k_base` 切换到首次使用的 `cl100k_base` 时，必须真实加载并激活新实例。
4. 切回已经加载过的编码器时，从缓存热切换，不再 fetch。
5. 快速执行 `o200k -> cl100k -> o200k` 时，最后目标加载成功则最终活动编码器必须是 `o200k_base`；加载失败则 active 为空并使用 fallback，绝不能回到旧的 cl 实例。
6. 过期加载可以完成并进入缓存，但不能改变当前活动状态。
7. Worker 不得使用与请求不一致的编码器，不得因重复加载泄漏实例。
8. 本地资源失败时，同一任务只回退 CDN 一次；失败不会阻塞另一编码器。
9. 编码器未就绪、加载失败或 Worker 不可用时，功能继续通过主线程精确计数或启发式 fallback 降级。
10. 保持 `countTokens()`、`countTokensAsync()`、`countBatchAsync()`、`waitForReady()` 和 `switchEncoderForModel()` 的调用兼容性。

### 3.2 非目标

1. 不在本轮验证或调整所有模型名称的编码器映射准确性。
2. 不增加第三种编码器。
3. 不把 BPE 数据移动到服务端。
4. 不要求取消所有过期 fetch。两种编码器总量有限，让已开始的任务完成并缓存比共享取消更简单可靠。
5. 不保证 Worker 崩溃后立即恢复异步性能；Worker 不可用时主线程精确计数仍是正确降级路径。
6. 不改变客户端预算快照与 Lex 服务端权威预算之间的职责边界。

## 4. 必须保持的状态不变量

实现和测试必须共同保护以下不变量：

| 编号 | 不变量 |
|---|---|
| I1 | `loadingByEncoding` 中每个编码器最多对应一个未完成加载条目，条目拥有唯一 Promise 和 AbortController。 |
| I2 | `encoderCache.get(E)` 返回的实例一定由 E 的 rank 数据构造。 |
| I3 | `activeEncoder !== null` 时，必须满足 `activeEncoding === desiredEncoding`。 |
| I4 | 加载任务不得直接写入 `activeEncoder`、`activeEncoding` 或 `desiredEncoding`。 |
| I5 | 只有持有当前 `desiredEncoding` 和最新 `switchRevision` 的统一激活路径可以激活编码器。 |
| I6 | fallback 结果不进入精确 token cache。 |
| I7 | Worker 计数请求必须携带明确的 encoding。 |
| I8 | Worker 返回值必须匹配请求 id、type、Worker epoch 和 encoding；revision 只在主线程消费计数结果时校验。 |
| I9 | 一个服务实例最多管理一个活动 Worker。 |
| I10 | 编码器 E 的失败状态不得阻止编码器 F 的加载。 |
| I11 | 每个 Worker pending Promise 必须在响应、结构化错误、协议错误、超时、崩溃或销毁之一发生时清理并结束。 |
| I12 | Worker 层失败不得写入主线程编码器的 `failureByEncoding`。 |

## 5. 建议状态模型

### 5.1 主线程状态

```ts
type TiktokenEncoding = 'o200k_base' | 'cl100k_base';

interface EncodingFailure {
  failedAt: number;
}

interface LoadedEncodingArtifact {
  encoding: TiktokenEncoding;
  encoder: TiktokenInstance;
  rankData: TiktokenBPE;
  source: 'local' | 'cdn';
}

interface EncodingLoadEntry {
  promise: Promise<TiktokenInstance | null>;
  abortController: AbortController;
  timeoutId: ReturnType<typeof setTimeout>;
}

private desiredEncoding: TiktokenEncoding = DEFAULT_ENCODING;
private activeEncoding: TiktokenEncoding | null = null;
private activeEncoder: TiktokenInstance | null = null;
private switchRevision = 0;
private modelSelectionInitialized = false;
private destroyed = false;

private readonly encoderCache = new Map<
  TiktokenEncoding,
  TiktokenInstance
>();

private readonly loadingByEncoding = new Map<
  TiktokenEncoding,
  EncodingLoadEntry
>();

private readonly failureByEncoding = new Map<
  TiktokenEncoding,
  EncodingFailure
>();
```

字段职责必须清晰区分：

- `desiredEncoding`：最新模型选择需要的编码器。
- `activeEncoding`：当前允许参与精确计数的编码器。
- `activeEncoder`：必须与 `activeEncoding` 同名；切换过渡期间为空。
- `encoderCache`：已成功构造的实例，不代表当前正在使用。
- `loadingByEncoding`：按编码器名称共享的进行中任务。
- `failureByEncoding`：按编码器隔离的失败与重试冷却信息。
- `switchRevision`：每次有效模型选择递增，用于阻止晚到结果激活。
- `modelSelectionInitialized`：启动模型已经解析完成；在此之前不预加载默认编码器。
- `destroyed`：服务已销毁，禁止晚到任务缓存、激活或创建 Worker。

### 5.2 状态转换

```text
模型选择 E
  -> desiredEncoding = E
  -> 若不是已活动的 no-op，则 switchRevision + 1
  -> activeEncoding 若不是 E，则进入 transition，精确计数暂不可用
  -> 命中 encoderCache(E)：立即激活
  -> 命中 loadingByEncoding(E)：等待共享任务
  -> 否则启动 load(E)
       -> 本地资源成功：构造并缓存
       -> 本地失败：同一任务内回退 CDN
       -> 全部失败：记录 failureByEncoding(E)
  -> 完成时检查 revision
       -> 仍为最新选择：激活 E
       -> 已过期：只保留缓存，不激活
```

加载与激活的边界是本方案最重要的约束：

> `loadEncoding()` 只负责生成可缓存结果；只有统一的 `activateIfCurrent(target, revision, encoder)` 才有权根据当前 target/revision 激活结果，`switchEncoderForModel()` 与 `waitForReady()` 都必须通过该入口。

## 6. 编码器加载去重设计

### 6.1 显式编码器参数

`loadEncoder()` 改为：

```ts
private async loadEncodingArtifact(
  encoding: TiktokenEncoding,
  signal: AbortSignal,
): Promise<LoadedEncodingArtifact>;
```

函数进入时立即由参数确定配置，后续任何 `await` 之后都不再读取 `desiredEncoding` 或 `activeEncoding`：

```ts
const config = ENCODING_CONFIGS[encoding];
```

日志、缓存 key 和 Worker 注册也全部使用这个不可变的局部 `encoding`。

### 6.2 按编码器共享 Promise

建议实现骨架：

```ts
private ensureEncodingLoaded(
  encoding: TiktokenEncoding,
): Promise<TiktokenInstance | null> {
  if (this.destroyed) {
    return Promise.resolve(null);
  }

  const cached = this.encoderCache.get(encoding);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = this.loadingByEncoding.get(encoding);
  if (pending) {
    this.stats.loadDedupHits++;
    return pending.promise;
  }

  const failure = this.failureByEncoding.get(encoding);
  if (failure && Date.now() - failure.failedAt < LOAD_RETRY_COOLDOWN_MS) {
    return Promise.resolve(null);
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort('timeout'),
    LOAD_TASK_TIMEOUT_MS,
  );
  let entry: EncodingLoadEntry;

  const task = this.raceWithAbortSignal(
    this.loadEncodingArtifact(
      encoding,
      abortController.signal,
    ),
    abortController.signal,
  )
    .then((artifact) => {
      if (this.destroyed) {
        return null;
      }

      if (artifact.encoding !== encoding) {
        throw new Error(
          `Loaded encoding mismatch: expected=${encoding}, actual=${artifact.encoding}`,
        );
      }

      this.encoderCache.set(encoding, artifact.encoder);
      this.failureByEncoding.delete(encoding);

      // Worker 注册不阻塞主线程激活，并使用完全独立的错误边界。
      void Promise.resolve()
        .then(() => this.registerWorkerEncoding(
          encoding,
          artifact.rankData,
        ))
        .catch((error) => {
          // handler 必须 no-throw，只记录并让 Worker 路径降级。
          this.handleWorkerRegistrationFailure(encoding, error);
        });

      return artifact.encoder;
    })
    .catch((error) => {
      if (
        this.destroyed ||
        abortController.signal.reason === 'destroy'
      ) {
        return null;
      }
      this.failureByEncoding.set(encoding, {
        failedAt: Date.now(),
      });
      return null;
    })
    .finally(() => {
      clearTimeout(timeoutId);
      // 身份判断防止较旧任务的 finally 删除新的重试任务。
      if (this.loadingByEncoding.get(encoding) === entry) {
        this.loadingByEncoding.delete(encoding);
      }
    });

  entry = { promise: task, abortController, timeoutId };
  this.loadingByEncoding.set(encoding, entry);
  this.stats.loadsStarted[encoding]++;
  return task;
}
```

禁止再出现以下行为：

```ts
this.loadingPromise = null;
```

切换调用无权清除另一个调用拥有的加载任务。加载条目只能由创建它的任务在带身份判断的 `finally` 中移除。

加载条目设置一个共享的整体超时，例如 60 秒。超时以 reason=`timeout` abort 该编码器的共享任务，并记录 `failureByEncoding`，因此后续调用仍遵守 30 秒冷却；服务销毁以 reason=`destroy` abort，不记录失败。模型选择过期本身不取消任务。这样既避免永久占用 `loadingByEncoding`，也不会因为某个调用方放弃等待而取消其他调用方共享的资源。

### 6.3 本地资源与 CDN 回退

本地加载和 CDN 回退必须封装在同一个 `loadEncodingArtifact(encoding, signal)` Promise 内：

```text
load(E)
  -> fetch local(E)
  -> local 成功：返回
  -> local 失败：fetch CDN(E)
  -> CDN 成功：返回
  -> CDN 失败：抛出包含两次失败上下文的错误
```

这样十个并发调用也只会产生：

- 最多一次本地 fetch。
- 本地失败后最多一次 CDN fetch。
- 一次 JSON 解析与编码器构造。

建议失败冷却初始使用 30 秒。冷却只防止配置事件抖动造成请求风暴，不影响另一个编码器加载。后续如果需要用户主动重试，可增加显式 `retryEncodingForModel()`，不要让普通状态读取隐式清空失败记录。

共享加载任务设置整体超时并向两次 fetch 传递同一个 AbortSignal。resource loader seam 必须让所有可取消的异步 I/O 响应 signal；外层 `raceWithAbortSignal()` 还要保证即使某个依赖忽略 signal，服务拥有的加载 Promise 仍立即 reject 并进入 `finally`。底层迟到结果只能被丢弃，不得再缓存、激活或注册 Worker。返回的 `LoadedEncodingArtifact.encoding` 必须与请求参数做运行时一致性检查，不能只依赖 TypeScript 类型声明来证明实例来源。

## 7. 真正的编码器切换设计

### 7.1 revision 控制激活权

建议保留 `switchEncoderForModel(modelName): Promise<void>` 的公共签名，以减少调用方改动：

```ts
async switchEncoderForModel(modelName: string | null): Promise<void> {
  const target = this.resolveEncoding(modelName);
  this.modelSelectionInitialized = true;

  if (
    this.desiredEncoding === target &&
    this.activeEncoding === target &&
    this.activeEncoder
  ) {
    return;
  }

  const revision = ++this.switchRevision;
  this.desiredEncoding = target;

  // 不能继续使用旧模型的编码器产生“精确但错误”的结果。
  if (this.activeEncoding !== target) {
    this.activeEncoding = null;
    this.activeEncoder = null;
  }

  const encoder = await this.ensureEncodingLoaded(target);

  this.activateIfCurrent(target, revision, encoder);
}
```

`activateIfCurrent()` 是服务内唯一激活入口。它在 encoder 非空、服务未销毁、target 等于 `desiredEncoding` 且 revision 等于 `switchRevision` 时，原子设置 `activeEncoding` 与 `activeEncoder`；否则只记录 stale/failed 状态。已经处于目标编码器的 no-op 调用可以提前返回而不增加 revision，因此这里的 revision 表示“需要加载、重试或改变活动状态的有效选择版本”，不是所有 UI 选择事件的计数器。

### 7.2 过渡期语义

当目标编码器尚未加载完成时，有两个可能策略：

| 策略 | 结果 | 结论 |
|---|---|---|
| 继续使用旧编码器 | 返回精确数值，但属于错误编码规则 | 不采用 |
| 暂时使用启发式 fallback | 精度降低，但不会伪装成目标编码器精确值 | 采用 |

因此 `countTokens()` 只在以下条件成立时使用精确编码器：

```ts
this.activeEncoder !== null &&
this.activeEncoding === this.desiredEncoding
```

### 7.3 快速切换示例

```text
revision 1: 选择 o200k，开始 load(o200k)
revision 2: 选择 cl100k，开始 load(cl100k)
revision 3: 再次选择 o200k，复用 revision 1 已开始的 Promise

cl100k 先完成：
  -> 缓存 cl100k
  -> revision 2 已过期，不激活

o200k 后完成且成功：
  -> 缓存 o200k
  -> revision 1 不激活
  -> revision 3 仍为最新，激活 o200k
```

不建议为了避免过期任务而立即 abort fetch。加载任务被多个调用共享，取消会扩大协调复杂度；两种编码器都可进入缓存，后续热切换还能复用。

如果最后一次选择的编码器加载失败，最终状态不是错误地回到旧编码器，而是：`desiredEncoding` 保持最后选择、`activeEncoding` / `activeEncoder` 为空、计数走 fallback。只有目标编码器已缓存或加载成功时，验收才要求它成为 active。

### 7.4 `waitForReady()` 语义

`waitForReady()` 应等待“调用完成时仍然是当前目标”的编码器，而不是等待一个已经过期的快照。建议循环确认：

```ts
async waitForReady(): Promise<boolean> {
  if (!this.modelSelectionInitialized || this.destroyed) {
    return false;
  }

  while (true) {
    const target = this.desiredEncoding;
    const revision = this.switchRevision;
    const encoder = await this.ensureEncodingLoaded(target);

    if (
      target !== this.desiredEncoding ||
      revision !== this.switchRevision
    ) {
      continue;
    }

    return this.activateIfCurrent(target, revision, encoder);
  }
}
```

冷却期内 `ensureEncodingLoaded()` 返回 `null`，因此 `waitForReady()` 立即返回 `false`，不等待冷却结束。`waitForReady()` 与 `switchEncoderForModel()` 必须共同使用 `activateIfCurrent(target, revision, encoder)`，对应不变量是“只有持有当前 target/revision 的路径可以激活”，而不是限定某个公共方法名。

## 8. 启动加载优化

### 8.1 移除构造函数网络副作用

建议删除：

```ts
constructor() {
  this.ensureLoaded();
}
```

原因：服务构造时保存模型尚未恢复，无条件加载默认 `o200k_base` 可能造成：

- 随后选择同一编码器时产生当前观察到的重复加载。
- 保存模型实际需要 `cl100k_base` 时，先加载一次不需要的 `o200k_base`。
- 单元测试和依赖注入仅构造服务时就产生大型资源 I/O。

### 8.2 在模型恢复后统一选择编码器

`ContextBudgetService.updateModelContextSize()` 应在解析 `modelName` 后统一调用一次：

```ts
void this.tiktokenService
  .switchEncoderForModel(modelName)
  .catch((error) => {
    console.warn('[TikToken] Unexpected model switch failure:', error);
  });
```

`null` 和 `auto` 继续由 `resolveEncoding()` 映射到默认编码器。后续上下文窗口大小判断不应重复触发切换。

这里的“统一、仅调用一次”指**每次 `updateModelContextSize()` 调用只触发一次选择**，不是整个应用生命周期只允许调用一次。模型目录刷新、会话恢复和服务端模型更新仍可重复调用，底层加载条目负责去重。

启动期的唯一主动加载所有者是“保存模型解析完成后的 `updateModelContextSize()`”。在 `modelSelectionInitialized === false` 时：

- `countTokens()` 只返回 fallback。
- `waitForReady()` 立即返回 `false`，不加载默认编码器。
- 其他服务不得把 `waitForReady()` 当成启动预热入口。

这保证保存模型需要 `cl100k_base` 时，不会在恢复完成前先加载默认 `o200k_base`。`auto` 或无保存模型也必须走一次 `updateModelContextSize(null | 'auto')`，明确初始化默认编码器。

该调用保持非阻塞；编码器加载期间 `countTokens()` 使用 fallback，不阻塞启动页面。预期的资源加载失败在服务内部转为 `null`/fallback；调用点的 `.catch()` 只处理意外编程或运行时错误。单独写 `void promise` 不能吸收 rejection。

即使移除了构造预加载，`loadingByEncoding` 仍必须实现。配置初始化、模型目录刷新、会话恢复和流式返回模型都可能连续请求同一个编码器，不能依赖“正常情况下只调用一次”。

## 9. 精确计数缓存隔离

### 9.1 缓存 key 包含编码器

精确缓存 key 改为：

```ts
`${activeEncoding}\u0000${text}`
```

或者将缓存结构改为：

```ts
Map<TiktokenEncoding, TokenCountCache>
```

两者均可，推荐每编码器一个 LRU，类型更清楚。

### 9.2 fallback 不写入精确缓存

建议行为：

```ts
countTokens(text: string): number {
  const encoding = this.activeEncoding;
  const encoder = this.activeEncoder;

  if (
    !encoding ||
    !encoder ||
    encoding !== this.desiredEncoding
  ) {
    this.stats.fallbackCount++;
    return estimateTokensFallback(text);
  }

  const cache = this.getExactCache(encoding);
  // 查询并写入当前编码器自己的精确缓存
}
```

fallback 计算成本较低，不缓存可以直接消除“加载完成后仍命中估算值”的状态同步问题。

## 10. Worker 并发与生命周期设计

### 10.1 单 Worker、多编码器 Map

Worker 改为只创建一个实例，并在 Worker 内维护：

```ts
const encoders = new Map<TiktokenEncoding, TiktokenInstance>();
```

协议使用完整且可校验的请求/响应信封。`epoch` 属于传输层，由主线程创建 Worker 时生成并由 Worker原样回传；`revision` 属于主线程业务层，不发送给 Worker：

```ts
type WorkerOperation =
  | 'registerEncoding'
  | 'countTokens'
  | 'countBatch';

interface WorkerEnvelope {
  id: number;
  epoch: number;
  type: WorkerOperation;
  encoding: TiktokenEncoding;
}

type WorkerRequest =
  | (WorkerEnvelope & {
      type: 'registerEncoding';
      rankData: TiktokenBPE;
    })
  | (WorkerEnvelope & {
      type: 'countTokens';
      text: string;
    })
  | (WorkerEnvelope & {
      type: 'countBatch';
      items: Array<{ id: string; text: string }>;
    });

type WorkerResponse =
  | (WorkerEnvelope & {
      type: 'registerEncoding';
      ok: true;
      result: true;
    })
  | (WorkerEnvelope & {
      type: 'countTokens';
      ok: true;
      result: number;
    })
  | (WorkerEnvelope & {
      type: 'countBatch';
      ok: true;
      result: Record<string, number>;
    })
  | (WorkerEnvelope & {
      ok: false;
      error: {
        code: 'INVALID_REQUEST'
          | 'ENCODING_NOT_REGISTERED'
          | 'ENCODER_INIT_FAILED'
          | 'ENCODE_FAILED';
        message: string;
      };
    });
```

Worker 不再维护隐式 `activeEncoding`。每个请求显式指定编码器：

```ts
case 'registerEncoding': {
  if (!encoders.has(request.encoding)) {
    encoders.set(
      request.encoding,
      new Tiktoken(request.rankData),
    );
  }
  respond(true);
  break;
}

case 'countTokens': {
  const encoder = encoders.get(request.encoding);
  if (!encoder) {
    throw new WorkerRequestError(
      'ENCODING_NOT_REGISTERED',
      `Encoding not registered: ${request.encoding}`,
    );
  }
  respond(encodeCount(encoder, request.text));
  break;
}
```

Worker 的每条 `message` 必须在独立 `try/catch` 中处理。业务异常转换为 `ok: false` 的结构化响应，只结束当前请求，不触发全局 Worker error，也不影响其他 pending 请求。`respond()` 必须回传原请求的 id、epoch、type 和 encoding。这样模型切换不需要修改 Worker 的全局“当前”状态，也不存在 `activate` 消息与计数消息乱序的问题。

### 10.2 主线程 Worker 管理状态

```ts
// 以下类型声明位于 class 外。
interface PendingWorkerRequest {
  id: number;
  worker: Worker;
  epoch: number;
  type: WorkerOperation;
  encoding: TiktokenEncoding;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

// 以下字段位于 TiktokenService class 内。
private worker: Worker | null = null;
private workerEpoch = 0;
private workerRequestId = 0;

private readonly workerRegisteredEncodings =
  new Set<TiktokenEncoding>();

private readonly workerRegistrationByEncoding = new Map<
  TiktokenEncoding,
  {
    worker: Worker;
    epoch: number;
    promise: Promise<void>;
  }
>();

private readonly pendingWorkerRequests =
  new Map<number, PendingWorkerRequest>();
```

约束：

- `ensureWorker()` 只有在 `worker === null` 时创建实例。
- 创建 Worker 时递增 `workerEpoch`，所有请求记录当前 epoch。
- 消息返回时必须匹配 request id、worker identity、epoch、type 和 encoding；成功 payload 也必须与 type 匹配：register 只能是 `true`，单计数必须是有限非负 number，batch 必须是符合约定的数值 Record。
- `revision` 不进入 Worker 协议；异步计数调用在消费结果时用闭包中的 revision 与当前状态比较。注册即使来自已经过期的模型选择，也可以完成并保留热切换缓存。
- `message`、`messageerror` 和 `error` 监听器都通过创建时闭包绑定 worker identity/epoch；旧实例的事件不得清理新 Worker 状态。
- 当前 Worker 失败时，先同步摘除该 epoch 的 registered/registration 状态，再 reject pending、清除 timeout、`terminate()` 并设为 `null`。
- 后续新编码器加载可重建 Worker；在此之前异步计数回退到主线程。
- Worker 结构化业务错误只 reject 单个请求；传输协议字段不匹配、`messageerror`、全局 error 或请求超时则重置整个当前 epoch。

### 10.3 Worker 注册去重

每个编码器的 rank 数据只向同一个 Worker 注册一次：

```ts
private registerWorkerEncoding(
  encoding: TiktokenEncoding,
  rankData: TiktokenBPE,
): Promise<void> {
  // 对 new Worker() 的同步异常做 Promise 化，保证本方法绝不同步 throw。
  return Promise.resolve().then(() => {
    if (this.destroyed) {
      return;
    }

    const worker = this.ensureWorker();
    const epoch = this.workerEpoch;

    if (this.workerRegisteredEncodings.has(encoding)) {
      return;
    }

    const pending = this.workerRegistrationByEncoding.get(encoding);
    if (
      pending &&
      pending.worker === worker &&
      pending.epoch === epoch
    ) {
      return pending.promise;
    }

    let registration: {
      worker: Worker;
      epoch: number;
      promise: Promise<void>;
    };

    const promise = this.sendWorkerRequest(worker, epoch, {
      type: 'registerEncoding',
      encoding,
      rankData,
    })
      .then(() => {
        if (epoch === this.workerEpoch && worker === this.worker) {
          this.workerRegisteredEncodings.add(encoding);
        }
      })
      .finally(() => {
        if (
          this.workerRegistrationByEncoding.get(encoding) === registration
        ) {
          this.workerRegistrationByEncoding.delete(encoding);
        }
      });

    registration = { worker, epoch, promise };
    this.workerRegistrationByEncoding.set(encoding, registration);
    return promise;
  });
}
```

`ensureWorker()` 自身也必须先检查 `destroyed`，销毁后不得创建 Worker。入口与创建函数双重检查，用来覆盖“Worker 注册微任务已经排队、随后服务被销毁”的窗口。

`rankData` 只需在首次加载后立即通过 `postMessage` 注册，不需要为了正常热切换永久保留在主线程。首版明确接受：Worker 崩溃且两个编码器都只有主线程缓存时，异步接口持续降级到主线程，直到服务重建或未来显式重读 rank 数据；不把它描述为自动恢复。

### 10.4 Worker Promise 的唯一终态

`sendWorkerRequest()` 必须集中拥有 pending 项和 timeout，任何终态都执行同一个 `settleWorkerRequest()`：

```text
成功响应
结构化失败响应
postMessage 同步抛错（例如 DataCloneError）
当前 epoch 的 messageerror / error
请求超时
协议字段不匹配
服务销毁
  -> delete pending id
  -> clearTimeout
  -> resolve 或 reject 一次
```

建议首版 Worker 请求超时为 30 秒。请求超时说明当前 Worker 可能被长任务阻塞，应 reject 当前 epoch 全部 pending 并重置 Worker，而不是让后续请求继续排队超时。`postMessage()` 同步抛错至少结束当前请求；如果属于数据克隆问题，可以只降级该请求。未知 id 的旧 epoch/重复响应记录 warning 后忽略；已匹配当前 pending id 但 type、encoding、epoch 或成功 payload 类型不一致属于协议错误，需要 reject 并重置当前 Worker。

### 10.5 异步计数的 revision 检查

`countTokensAsync()` 发请求时捕获：

- `encoding`
- `switchRevision`
- `workerEpoch`

Worker 返回后，如果 revision 或活动编码器已经变化，不直接返回旧结果，而是用当前主线程状态重新计算：

```ts
const result = await this.sendWorkerCount(...);

if (
  revision !== this.switchRevision ||
  encoding !== this.activeEncoding
) {
  return this.countTokens(text);
}

return result;
```

Worker 未注册该编码器、初始化中、发生异常或请求被拒绝时，也回退到 `countTokens()`。批量接口使用同样规则。

### 10.6 服务销毁

`TiktokenService` 实现 `OnDestroy` 或等价 `dispose()`：

1. 先设置 `destroyed = true`，阻止晚到加载缓存、激活或创建 Worker。
2. 对所有 `loadingByEncoding` 条目的 AbortController 调用 `abort('destroy')`。
3. reject 并清理当前 Worker epoch 的全部 pending/timeout。
4. 清空 `workerRegistrationByEncoding` 与 registered 状态。
5. 终止 Worker 并设为 `null`。
6. `waitForReady()` 检测 destroyed 后返回 `false`，不能继续循环。
7. 如果未来 `TiktokenInstance` 提供显式释放 API，再对缓存实例调用释放；当前接口没有时由 GC 回收。

销毁测试必须覆盖：加载已经成功、Worker 注册微任务已经排队、但微任务执行前调用 `ngOnDestroy()`；预期不会创建新 Worker。

## 11. 失败与重试策略

### 11.1 每编码器失败隔离

```text
o200k 加载失败
  -> failureByEncoding[o200k] = failure
  -> o200k 使用 fallback
  -> 不影响 cl100k 的加载、缓存或使用
```

失败状态不能再用单个 `loadFailed` 表示。

### 11.2 重试规则

首版建议：

1. 每次加载任务先尝试本地，再尝试 CDN。
2. 两者都失败后记录失败时间。
3. 30 秒冷却期内相同编码器请求直接返回 `null`，不重复访问网络。
4. 冷却后下一次模型选择或 `waitForReady()` 允许自动重试。
5. 成功后清除该编码器失败状态。
6. 另一个编码器不受冷却影响。

不要在普通 getter、`countTokens()` 或每次 UI 渲染中强制重试，否则离线环境会产生持续请求。

### 11.3 Worker 失败降级

Worker 失败不应把主线程编码器标记为失败：

| 层级 | 失败后的行为 |
|---|---|
| rank 数据本地与 CDN 都失败 | 使用启发式 fallback |
| 主线程 `Tiktoken` 构造失败 | 使用启发式 fallback |
| Worker 创建或注册失败 | 主线程继续精确计数 |
| Worker 计数请求失败 | 当前调用回退主线程精确计数 |

## 12. 公共 API 兼容性

建议保留现有方法签名：

```ts
countTokens(text: string): number;
encode(text: string): number[];
decode(tokens: number[]): string;
countTokensAsync(text: string): Promise<number>;
countBatchAsync(items: ...): Promise<Map<string, number>>;
waitForReady(): Promise<boolean>;
switchEncoderForModel(modelName: string | null): Promise<void>;
```

过渡期和失败期的公共降级语义固定如下：

| API | 目标编码器 ready | 未初始化、切换中或加载失败 |
|---|---|---|
| `countTokens(text)` | 当前目标编码器精确计数 | 启发式 fallback |
| `encode(text)` | 当前目标编码器 token 数组 | 返回 `[]` |
| `decode(tokens)` | 当前目标编码器解码 | 返回 `''` |
| `countTokensAsync(text)` | Worker 同编码器计数，或主线程精确计数 | 主线程精确计数仍可用则使用，否则 fallback |
| `countBatchAsync(items)` | Worker 同编码器批量计数，或主线程逐项精确计数 | 主线程逐项重算/fallback |
| `waitForReady()` | 返回 `true` | 未完成启动模型选择、服务销毁或冷却期失败时返回 `false` |

`encode()` / `decode()` 不允许在过渡期继续使用旧 `activeEncoder`。保留空数组/空字符串是与当前未就绪行为兼容的降级，不在本轮引入抛错式 API。

`countBatchAsync()` 固定保留现有 Map/Object 兼容语义：输入出现重复 id 时，后项覆盖前项，不 reject。主线程与 Worker 必须使用相同规则并添加确定性测试。Worker 任一结构化错误、超时或 revision 变化时，整个批次使用调用完成时的主线程当前状态重新计算，不返回部分旧结果。

getter 语义建议明确为：

```ts
get encodingName(): TiktokenEncoding {
  return this.desiredEncoding;
}

get activeEncodingName(): TiktokenEncoding | null {
  return this.activeEncoding;
}

get isReady(): boolean {
  return !!this.activeEncoder &&
    this.activeEncoding === this.desiredEncoding;
}

get isLoading(): boolean {
  return this.loadingByEncoding.has(this.desiredEncoding);
}
```

`encodingName` 保留原有非空返回类型，但明确表示模型当前需要的编码器；新增 `activeEncodingName` 用于诊断真实活动实例。

调用方对 Promise 应显式标明 fire-and-forget：

```ts
void this.tiktokenService
  .switchEncoderForModel(modelName)
  .catch((error) => this.reportUnexpectedSwitchFailure(error));
```

服务内部必须吸收预期加载失败并降级；调用方仍需处理意外 rejection。`void` 只丢弃返回值，本身不能避免 unhandled rejection。所有 no-throw 错误处理函数也必须保证自身不抛异常。

## 13. 文件级改造范围

### 13.1 `tiktoken.service.ts`

主要改动：

- 删除构造函数无条件预加载。
- 把 `currentEncoding` 拆为 `desiredEncoding` 与 `activeEncoding`。
- 把 `encoder` 改为语义明确的 `activeEncoder`。
- 删除单个 `loadingPromise` 与 `loadFailed`。
- 增加按编码器的 loading/failure/cache 状态。
- `loadEncoder()` 改为显式接收 encoding 并返回加载产物。
- 增加 `switchRevision` 与过期激活保护。
- 精确 token cache 按编码器隔离；fallback 不缓存。
- 收敛单 Worker 生命周期与注册状态。
- 实现服务销毁时的 load abort、Worker terminate 和 pending Promise 清理。
- 增加不包含 rank 数据内容的诊断统计。

### 13.2 `tiktoken.worker.ts`

主要改动：

- 单个 `encoder` 改为 `Map<TiktokenEncoding, TiktokenInstance>`。
- `init` 改为幂等 `registerEncoding`。
- `countTokens` / `countBatch` 请求必须携带 encoding。
- 返回消息携带 request id、epoch、type、encoding 和 `ok` 判别字段。
- 未注册编码器时返回明确错误，由主线程降级。

如果请求/响应类型需要主线程与 Worker 共享，建议新增：

```text
src/app/tools/aily-chat/workers/tiktoken-worker-protocol.ts
```

避免两端复制协议后产生字段漂移。

### 13.3 `context-budget.service.ts`

主要改动：

- 在 `updateModelContextSize()` 内统一、仅调用一次 `switchEncoderForModel()`。
- `null` / `auto` 同样请求默认编码器。
- 使用 `void` 显式声明非阻塞调用。
- 上下文窗口大小计算与编码器异步加载继续解耦。

### 13.4 测试文件

建议新增：

```text
src/app/tools/aily-chat/services/tiktoken.service.spec.ts
src/app/tools/aily-chat/workers/tiktoken-worker-protocol.spec.ts
```

如果 Worker 测试环境不适合直接启动模块 Worker，可把 Worker 的消息分发核心提取为纯函数，例如 `tiktoken-worker-handler.ts`，在单测中使用 fake encoder factory 验证协议；真实 Worker 启动由浏览器/Electron 集成测试覆盖。

## 14. 测试方案

### 14.1 主线程单元测试

使用可控 deferred Promise，并至少注入 fake clock、resource loader（能分别观察 local/CDN）、encoder factory 和 Worker factory/adapter，避免单测真正解析 2.3 MB 资源。不能只 fake 整个 artifact loader，否则无法验证 local/CDN 回退次数、构造来源和超时冷却。

| 编号 | 场景 | 断言 |
|---|---|---|
| T1 | 同时三次请求 `o200k_base` | loader 只调用一次，三次共享完成结果 |
| T2 | 启动模型恢复重复选择 `o200k_base` | 本地 fetch 只调用一次 |
| T3 | `o200k` 已活动，首次切换 `cl100k` | cl loader 被调用，最终 active 为 cl 实例 |
| T4 | 切回已缓存 `o200k` | 不 fetch，立即激活缓存实例 |
| T5 | `o -> cl -> o`，cl 先完成 | cl 只缓存不激活，最终 active 为 o |
| T6 | `o -> cl -> o`，o 先完成 | 只有最新 revision 能激活 o |
| T7 | o 本地失败后 CDN 成功 | 两条资源路径各一次，最终 ready |
| T8 | o 本地和 CDN 都失败 | 冷却内重复调用不再 fetch，使用 fallback |
| T9 | o 失败后请求 cl | cl 正常加载，不受 o failure 影响 |
| T10 | 切换过渡期调用 `countTokens` | 不使用旧 encoder，返回 fallback |
| T11 | 同一文本在 o 与 cl 下计数 | 精确缓存相互隔离 |
| T12 | fallback 后编码器就绪 | 不命中旧 fallback，重新精确计数 |
| T13 | 旧加载任务 finally 晚到 | 不删除相同 encoding 的新重试 Promise |
| T14 | `waitForReady` 等待期间发生切换 | 最终等待并确认最新 desired encoding |
| T15 | 未初始化/过渡期调用 `encode` / `decode` | 返回 `[]` / `''`，不访问旧 encoder |
| T16 | `new Worker()` 同步抛错 | 主线程 encoder 仍 ready，不写入 encoding failure |
| T17 | 30 秒冷却边界 | fake clock 前不重试，到期后只启动一个新任务 |
| T18 | 加载超时或服务销毁 | abort 共享任务，晚到结果不缓存、不激活、不建 Worker |
| T19 | fire-and-forget 调用失败 | 调用方 catch 生效，无 unhandled rejection |
| T20 | batch 输入包含重复 id | 主线程和 Worker 都采用后项覆盖前项 |
| T21 | 超时 abort 后立即重试 | 写入失败时间并遵守冷却；destroy abort 不写失败 |

### 14.2 Worker 单元测试

| 编号 | 场景 | 断言 |
|---|---|---|
| W1 | 重复注册同一 encoding | 只构造一个 Worker encoder |
| W2 | 注册 o 和 cl | Map 同时保存两者 |
| W3 | 明确用 o / cl 计数相同文本 | 分别调用对应 encoder |
| W4 | 请求未注册 encoding | 返回结构化错误，不崩溃 Worker |
| W5 | Worker error | 所有当前 epoch pending request 被 reject |
| W6 | 旧 Worker 晚到消息 | 不解析为新 Worker 请求结果 |
| W7 | 服务连续加载两个 encoding | 全程只创建一个 Worker |
| W8 | Worker 注册未完成时计数 | 主线程精确计数降级可用 |
| W9 | `postMessage` 同步抛错 | pending/timeout 被清理，Promise reject 一次 |
| W10 | Worker 无响应超时 | 当前 epoch 全部 pending 收敛并重置 Worker |
| W11 | `messageerror` 或全局 error | 原子清理当前 epoch，不影响随后新 Worker |
| W12 | 响应 id 命中但 epoch/type/encoding 错误 | 判为协议错误，不留下 pending |
| W13 | 结构化单请求错误 | 仅该请求失败，其他 pending 可继续完成 |
| W14 | 注册 ack 前崩溃并立即重建 | 不复用旧 epoch registration Promise |
| W15 | 服务销毁 | Worker terminate，全部 pending/timeout 清空 |
| W16 | `countTokens` 成功信封却返回 boolean 等错误 payload | 判为协议错误并重置当前 epoch |
| W17 | Worker 注册微任务排队后服务销毁 | 微任务不得重新创建 Worker |

### 14.3 ContextBudget 集成测试

| 编号 | 场景 | 断言 |
|---|---|---|
| C1 | 恢复具体模型 | `switchEncoderForModel` 只调用一次 |
| C2 | 恢复 `auto` | 请求默认编码器 |
| C3 | 无保存模型 | 请求默认编码器且不阻塞上下文窗口初始化 |
| C4 | 模型目录连续刷新同一模型 | 底层共享加载，无重复 fetch |
| C5 | 每个早退分支 | 每次 `updateModelContextSize()` 最多选择一次编码器 |

### 14.4 Electron 运行时验收

开发环境启动主软件，在 DevTools Network 中过滤 `tiktoken`：

1. 冷启动并恢复默认模型：`o200k_base.json` 只有一个本地请求。
2. 本地资源成功时不请求 `tiktoken.pages.dev`。
3. 切换到映射为 `cl100k_base` 的模型：`cl100k_base.json` 首次只请求一次。
4. 再切回默认模型：两份 JSON 均不产生新请求。
5. 连续快速切换两个模型；最终目标加载成功时，`activeEncodingName` 与界面最后选择一致，目标加载失败时 active 为空且走 fallback。
6. 长文本异步计数在切换期间不返回旧编码器结果。
7. DevTools 中只存在一个 tiktoken Worker；重复切换不增加 Worker 数。
8. 模拟 Worker 创建失败，短文本与长文本仍能通过主线程/fallback 返回结果。

源代码单测和 TypeScript 通过不能替代 Electron Network/Worker 验收；反之，单次运行时观察也不能替代乱序完成的确定性测试。

## 15. 可观测性

建议扩展 `getStats()`，至少包含：

```ts
{
  exactCount,
  fallbackCount,
  cacheHits,
  loadsStarted: {
    o200k_base,
    cl100k_base,
  },
  loadDedupHits,
  staleActivationsSkipped,
  activations: {
    o200k_base,
    cl100k_base,
  },
  workerInstancesCreated,
  workerFallbackCount,
}
```

日志应包含：

- encoding
- revision
- local/CDN source
- cache hit / pending hit / new load
- activation / stale activation skipped
- Worker epoch 与注册结果

日志不得输出 rank 数据、完整待计数文本或用户消息。

建议日志示例：

```text
[TikToken] load.start encoding=o200k_base revision=3 source=local
[TikToken] load.dedup encoding=o200k_base revision=4
[TikToken] load.ready encoding=o200k_base source=local
[TikToken] activate encoding=o200k_base revision=4
[TikToken] activate.skip-stale encoding=cl100k_base revision=3 currentRevision=4
[TikToken Worker] register.ready encoding=o200k_base epoch=1
```

## 16. 实施步骤

### 阶段 0：冻结契约与测试 seam

1. 固定 `encode/decode`、batch、冷却期和 `waitForReady` 降级语义。
2. 固定 Worker 请求/响应判别联合、epoch 所属层次和超时策略。
3. 引入 fake clock、resource loader、encoder factory 与 Worker adapter seam。
4. 确认启动模型选择是唯一主动预热入口。

### 阶段 1：先建立回归测试

1. 添加可控 loader/Worker 测试 seam。
2. 写出启动重复加载、真实跨编码器切换和乱序完成测试。
3. 确认测试在当前实现下能稳定失败。

### 阶段 2：主线程状态模型

1. 引入 `desiredEncoding`、`activeEncoding`、`switchRevision`。
2. 实现 `loadingByEncoding` 和按编码器失败状态。
3. 将加载改为显式 encoding 参数。
4. 将加载与激活分离。
5. 隔离精确 token cache，停止缓存 fallback。

完成标准：T1-T21 通过；其中涉及 Worker adapter 的用例可先使用 fake，主线程加载、切换、超时、销毁和降级契约全部确定。

### 阶段 3：Worker 协议与生命周期

1. Worker 内改为编码器 Map。
2. 主线程改为单 Worker 与按编码器注册。
3. 请求信封增加 encoding/epoch；revision 仅保存在主线程 count pending，并在消费结果时校验。
4. 完成 Worker 失败降级与 pending request 清理。

主线程管理器与 Worker 协议必须在同一变更中原子升级，不能提交一端已发送新信封、另一端仍解析旧 `init` 协议的中间状态。

完成标准：W1-W17 通过，重复切换不创建多 Worker，所有协议与生命周期终态都能收敛。

### 阶段 4：启动加载收敛

1. 删除 `TiktokenService` 构造函数预加载。
2. `ContextBudgetService` 在模型解析后统一请求编码器。
3. 覆盖 `auto`、无保存模型和模型目录刷新。

完成标准：C1-C5 通过，冷启动只加载真实目标编码器一次。

### 阶段 5：运行时验收

1. 执行定向单测和 TypeScript 检查。
2. 使用现有 `ng serve` 热更新，不额外启动重复服务。
3. 在 Electron 中完成 Network、模型切换、Worker 数量和失败降级验收。
4. 记录源代码验证与 Electron 验收边界。

## 17. 建议验证命令

```bash
cd /Users/downey/Projects/OutSource/aily--blockly

# 专项 Karma 单测已按仓库清理策略移除；当前使用 production build 与根 e2e 验证。

npx tsc -p tsconfig.app.json --noEmit
```

定向命令使用独立 tsconfig，避免无关 spec 的编译状态影响本模块验证。完成定向测试后，再根据改动影响范围执行 Aily Chat 主线测试与构建。

## 18. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 移除构造预加载后，首次计数短暂使用 fallback | UI 初始估算精度短暂下降 | 模型恢复后立即非阻塞加载；这是现有已支持的降级路径 |
| 两个主线程编码器同时缓存增加内存 | 热切换以空间换时间 | 当前仅两种编码器；保留既有双编码器缓存设计，后续用实际内存数据决定是否淘汰 |
| Worker 同时持有两个编码器增加 Worker 内存 | 长文本计数性能更稳定但占用增加 | 保持单 Worker；必要时后续增加 LRU/disposeEncoding，不在首版提前复杂化 |
| 过期任务继续完成产生额外一次加载 | 快速切换时可能加载最终未使用编码器 | 结果进入缓存供后续使用；避免共享取消带来的竞态 |
| Worker 晚到结果污染当前模型 | token 预算错误 | encoding + worker epoch + switch revision 三重校验 |
| 重试策略过于积极导致离线请求风暴 | 网络与日志噪声 | 每编码器失败冷却，普通计数不触发强制重试 |
| 调用方忽略 Promise rejection | unhandled rejection | 服务内部将预期加载失败转为 null/fallback；fire-and-forget 调用仍追加 `.catch(report)` |
| 当前脏工作区存在无关改动 | 误覆盖用户工作 | 仅修改方案列出的目标文件，实施前后核对 `git diff` |

## 19. 未采用方案

### 19.1 只增加同编码器 early return

例如：

```ts
if (target === currentEncoding && loadingPromise) {
  return loadingPromise;
}
```

它能缓解启动双 fetch，但无法解决：

- 已有旧 encoder 时新编码器不加载。
- `loadEncoder()` 读取可变 `currentEncoding`。
- 晚到结果覆盖新选择。
- Worker 多实例和隐式编码器状态。
- 全局失败状态与跨编码器缓存污染。

因此不作为最终方案。

### 19.2 仅移除构造函数预加载

它可以隐藏当前启动复现，但配置刷新、会话恢复和流式模型更新仍可能并发请求，真实切换错误也仍然存在。只能作为完整方案中的启动优化步骤。

### 19.3 每种编码器创建一个独立 Worker

实现较直接，但会让 Worker 数、监听器和错误处理成倍增加，也更容易保留孤儿 Worker。当前只有两种编码器，更适合一个 Worker 内维护编码器 Map。

### 19.4 切换期间继续使用旧编码器

旧编码器结果看似“精确”，但不属于目标模型的编码规则，会掩盖错误。明确 fallback 更符合现有服务契约。

## 20. 验收标准

全部满足后才可认为方案实施完成：

1. 冷启动默认模型时，`o200k_base.json` 只 fetch 一次。
2. 同一编码器并发请求只执行一个加载 Promise。
3. 首次跨编码器切换真实加载目标资源和目标实例。
4. 切回缓存编码器不产生新 fetch。
5. 快速乱序切换时，最后目标加载成功则成为活动编码器；加载失败则 active 为空并使用 fallback，旧编码器不得重新激活。
6. 过渡期不使用旧编码器伪装精确结果。
7. 精确 cache 不跨编码器，fallback 不污染精确 cache。
8. 本地失败与 CDN 回退按编码器去重，另一编码器不受影响。
9. Worker 单实例、按 encoding 计数，旧 epoch 消息不可污染新实例。
10. Worker 异常时主线程精确计数或 fallback 仍可用。
11. 定向单测、TypeScript 检查通过。
12. Electron Network、快速模型切换和 Worker 数量验收通过。
13. `encode/decode`、batch、冷却期和 `waitForReady` 的降级语义有确定性测试。
14. Worker 协议字段、超时、`messageerror`、同步 `postMessage` 异常和服务销毁都能让 Promise 收敛。
15. Worker 创建/注册失败不会污染主线程 `failureByEncoding`。
16. 启动模型恢复是唯一主动预热入口，恢复前不会提前加载默认编码器。

## 21. 最终结论

当前问题的根因不是单纯“启动时调用了两次”，而是服务把以下四种不同状态压在了同一组可变字段中：

- 模型想要哪个编码器。
- 当前实际使用哪个编码器。
- 哪个编码器正在加载。
- Worker 当前能处理哪个编码器。

正确修复必须建立清晰的所有权边界：

- **按 encoding 去重加载。**
- **按 revision 决定激活。**
- **按 encoding 隔离缓存与失败。**
- **按 encoding 向单 Worker 发起显式请求。**

这套状态模型既能消除当前 `o200k_base.json` 连续 fetch 两次，也能保证编码器真正切换，并覆盖模型快速切换、加载乱序、Worker 晚到消息和离线失败重试等异步边界。
