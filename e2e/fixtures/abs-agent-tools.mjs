import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const absolute = (value, name) => {
  assert.ok(typeof value === 'string' && path.isAbsolute(value), `${name} must be an explicit absolute test path`)
  return path.resolve(value)
}
const textOf = result => (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const structuredOf = result => {
  if (result.details?.result && typeof result.details.result === 'object') return result.details.result
  try { return JSON.parse(textOf(result)) } catch { return undefined }
}

/** Real built Agent tools and SDK-installed PI hooks, without an LLM turn.
 * No direct project-file IO is available here. Default permissions come from
 * the real permission-system extension; roots come only from WorkspaceBinding.
 * Create this before recovery and call project_recover through this harness.
 * guardProjects must include every already-protected fixture project so normal
 * session_start restoration cannot accidentally discard a prior protection.
 */
export async function createRecoveredAgentHarness(options) {
  const stage = name => options.onStage?.(name)
  stage('imports')
  const agentRoot = absolute(options.agentRoot, 'agentRoot')
  const sourceProject = absolute(options.sourceProject, 'sourceProject')
  const globalRoot = absolute(options.globalRoot, 'globalRoot')
  const profileRoot = absolute(options.profileRoot, 'profileRoot')
  assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR ?? ''), profileRoot,
    'Set PI_CODING_AGENT_DIR to this private profile before importing the built Agent')
  const load = relative => import(pathToFileURL(path.join(agentRoot, relative)).href)
  const mod = relative => load(`dist/${relative}.js`)
  const sdk = await load('node_modules/@earendil-works/pi-coding-agent/dist/index.js')
  const { validateToolArguments } = await load('node_modules/@earendil-works/pi-ai/dist/index.js')
  const { AuthStorage } = await load('node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js')
  const { ModelRuntime } = await load('node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js')
  const { SettingsRepository } = await mod('settings/repository')
  const { PermissionModeRuntime } = await mod('extensions/pi-permission-mode/runtime')
  const { WorkspaceHistoryRuntime } = await mod('extensions/pi-workspace-history/runtime')
  const { WorkspaceBinding } = await mod('workspace-binding')
  const { AbsWorkflowGuard } = await mod('blockly/abs-workflow-guard')
  const { createBlocklyToolRegistry } = await mod('blockly/tools/registry')
  const { createBlocklyTools } = await mod('blockly/tools/definitions')
  const { createTools } = await mod('tools/create-tools')
  const { createAilyBlocklyExtension, ABS_WORKFLOW_ENTRY_TYPE } = await mod('extensions/pi-aily-blockly/extension')
  const { createPermissionModeExtension } = await mod('extensions/pi-permission-mode/extension')
  const { createWorkspaceHistoryExtension } = await mod('extensions/pi-workspace-history/extension')
  const { default: permissionSystem } = await mod('extensions/pi-permission-system/index')
  const { ContextCacheRuntime } = await mod('extensions/pi-context-cache/runtime')
  const { SESSION_PROJECT_ASSOCIATION_ENTRY_TYPE } = await mod('session-project-association')
  const settings = new SettingsRepository(profileRoot)
  assert.equal(settings.permissionMode(), 'default', 'A non-default profile must not silently weaken acceptance')
  const permissionMode = new PermissionModeRuntime(settings)
  const ownHistory = !options.history
  const history = options.history ?? new WorkspaceHistoryRuntime(sourceProject)
  if (!history.hasActiveTurn && !options.restoreHistory) await history.begin(undefined)
  const binding = options.binding ?? new WorkspaceBinding(sourceProject, globalRoot, history, permissionMode)
  const guard = options.guard ?? new AbsWorkflowGuard()
  assert.equal(binding.root, sourceProject, 'The original session remains bound to its source')
  const registry = options.registry ?? createBlocklyToolRegistry(binding, history, 'blockly')
  const registrarContext = { registry, workspace: binding, workspaceHistory: history, absWorkflow: guard, developmentMode: 'blockly' }
  if (!options.registry) {
    for (const [file, exported] of [
      ['blockly/tools/registrars/abs/index', 'registerAbsTools'],
      ['blockly/tools/registrars/project/project-recover', 'registerProjectRecover'],
      ['blockly/tools/registrars/project/project-build', 'registerProjectBuild'],
      ['blockly/tools/registrars/project/blocks-set-state', 'registerBlocksSetState'],
      ['blockly/tools/registrars/library/project-status', 'registerProjectStatus'],
      ['blockly/tools/registrars/app-window/app-info', 'registerAppInfo'],
      ['blockly/tools/registrars/app-window/app-status', 'registerAppStatus'],
      ['blockly/tools/registrars/app-window/app-open', 'registerAppOpen'],
      ['blockly/tools/registrars/app-window/app-close', 'registerAppClose'],
      ['blockly/tools/registrars/app-window/app-reload', 'registerAppReload']
    ]) (await mod(file))[exported](registrarContext)
  }
  await options.configureRegistry?.(registrarContext)
  const blocklyTools = createBlocklyTools(binding, history, registry.definitions())
  const coreTools = createTools(binding, history, permissionMode, blocklyTools)
  stage('tools-created')
  const services = { cwd: sourceProject, agentDir: profileRoot, workspaceBinding: binding, absWorkflow: guard, workspaceHistory: history,
    permissionMode, blocklyTools, contextCache: new ContextCacheRuntime(), assets: {
      observeReadOnlyPaths(listener) { listener([]); return () => {} },
      async promoteImagesTo() { throw new Error('This acceptance has no image assets to promote') }
    } }
  assert.ok(!options.sessionSnapshot || !options.initialEntries?.length,
    'Resume the actual session snapshot or seed entries, never merge unrelated sessions')
  assert.ok(!options.createStreaming || !options.sessionSnapshot,
    'A streaming acceptance starts its own native persistent session, never a patched in-memory session')
  const persistentManager = options.createStreaming
    ? (await mod('session-manager/windowed-session-manager')).WindowedSessionManager : undefined
  const sessionManager = persistentManager
    ? persistentManager.create(sourceProject, path.join(profileRoot, 'sessions'))
    : sdk.SessionManager.inMemory(sourceProject, undefined, options.sessionSnapshot)
  // Optional product-provider session for transport/Agent-loop acceptance. The
  // normal direct-tool harness still has no provider and never starts a turn.
  const streaming = await options.createStreaming?.({ sdk, load, mod, services, sessionManager })
  for (const entry of options.initialEntries ?? []) {
    assert.equal(entry.type, 'custom', 'Only existing extension state is seeded; never inject a user message')
    sessionManager.appendCustomEntry(entry.customType, entry.data)
  }
  const projects = new Set([sourceProject, ...binding.associatedProjectRoots, ...(options.guardProjects ?? [])])
  const concurrent = guard.concurrentEdit()
  if (concurrent) projects.add(concurrent.project)
  const existingGuards = [...projects].map(project => guard.snapshot(project)).filter(Boolean)
  for (const snapshot of existingGuards) sessionManager.appendCustomEntry(ABS_WORKFLOW_ENTRY_TYPE, snapshot)
  const existingAssociation = [...binding.associatedProjectRoots]
  if (existingAssociation.length > 1) sessionManager.appendCustomEntry(SESSION_PROJECT_ASSOCIATION_ENTRY_TYPE, {
    version: 1, workspaceId: `session:${binding.sessionRoot}`, root: binding.sessionRoot,
    projects: existingAssociation, updatedAt: Date.now()
  })
  let permissionService, toolEvents = 0, resultEvents = 0, permissionPrompts = 0, session
  let activeCall, currentPrompt
  let streamingActive = false, promptRuns = 0
  const errors = [], calls = [], permissionDecisions = []
  // Normal RPC approval seam, not a permission-service or policy override.
  // The caller must explicitly authorize an exact scoped request; default No.
  const permissionUi = new Proxy({
    async select(title, choices) {
      const request = { toolName: activeCall?.name, input: activeCall?.input, prompt: currentPrompt,
        title, choices, sourceProject, bindingRoot: binding.root,
        associatedProjects: [...binding.associatedProjectRoots], permissionMode: permissionMode.current }
      const approved = !!activeCall && !!currentPrompt && choices.includes('Yes')
        && await options.permissionApproval?.(request) === true
      permissionDecisions.push({ toolName: activeCall?.name, path: activeCall?.input?.path,
        surface: currentPrompt?.surface, value: currentPrompt?.value, approved, sessionGrant: false })
      currentPrompt = undefined
      return approved ? 'Yes' : 'No'
    },
    async confirm() { return false },
    async input() { return undefined },
    async custom() { return undefined },
    notify() {}
  }, { get(target, key) { return key in target ? target[key] : () => {} } })
  try {
    stage('offline-model-runtime')
    const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false })
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: streaming
      ? { enabled: true, maxRetries: 2, baseDelayMs: 1 } : { enabled: false } })
    const loader = new sdk.DefaultResourceLoader({ cwd: sourceProject, agentDir: profileRoot, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      ...(streaming?.systemPrompt ? { systemPrompt: streaming.systemPrompt } : {}),
      extensionFactories: [
        ...(streaming ? [{ name: 'isolated-streaming-call-boundary', factory(pi) {
          // Registered before the real permission gate so its normal UI seam
          // approves exactly the SDK call currently being reviewed, not a path
          // guessed from a later tool. This fixture emits one tool per step.
          pi.on('tool_call', event => {
            if (!streamingActive) return
            assert.equal(activeCall, undefined, 'Streaming fixture requires sequential actual tools')
            activeCall = { name: event.toolName, input: event.input, id: event.toolCallId }
            currentPrompt = undefined
          })
        } }, ...(streaming.extensionFactories ?? [])] : []),
        createPermissionModeExtension(services),
        { name: 'pi-permission-system', factory: permissionSystem }, createAilyBlocklyExtension(services),
        createWorkspaceHistoryExtension(services),
        { name: 'isolated-agent-tool-observer', factory(pi) {
          pi.events.on('permissions:ready', event => { permissionService = event.service })
          pi.events.on('permissions:ui_prompt', prompt => { permissionPrompts++; currentPrompt = prompt })
          pi.on('tool_call', () => { toolEvents++ })
          pi.on('tool_result', async event => {
            resultEvents++
            if (!streamingActive) return
            assert.equal(activeCall?.name, event.toolName)
            calls.push({ name: event.toolName, isError: event.isError === true,
              ...(typeof event.input?.path === 'string' ? { path: event.input.path } : {}) })
            try { await streaming.onToolResult?.(event) }
            finally { activeCall = undefined; currentPrompt = undefined }
          })
        } }]
    })
    stage('resources')
    await loader.reload()
    stage('sdk-session')
    const createSession = streaming?.createSession ?? sdk.createAgentSession
    const created = await createSession({ cwd: sourceProject, agentDir: profileRoot, resourceLoader: loader,
      settingsManager, modelRuntime, sessionManager, noTools: 'builtin', customTools: coreTools,
      model: streaming?.model ?? { id: 'isolated-no-llm', name: 'isolated-no-llm', api: 'openai-responses', provider: 'fixture',
        baseUrl: 'https://unused.invalid', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 } })
    session = created.session
    stage('extensions')
    await session.bindExtensions({ mode: 'rpc', uiContext: permissionUi, onError: error => errors.push(error) })
    assert.deepEqual(errors, [], 'Actual extension startup must be clean')
    assert.ok(permissionService, 'Actual permission-system service must initialize')
    assert.equal(permissionMode.current, 'default')
    assert.equal(permissionService.getRuntimeState().mode, 'default')
    for (const snapshot of existingGuards) assert.deepEqual(guard.snapshot(snapshot.project), snapshot, 'session_start must preserve existing guards')
    assert.deepEqual(binding.associatedProjectRoots, options.expectedAssociation ?? existingAssociation,
      'session_start must preserve or restore exact associations')
    if (!history.hasActiveTurn) await history.begin(undefined)
    assert.equal(typeof session.agent.beforeToolCall, 'function')
    assert.equal(typeof session.agent.afterToolCall, 'function')
    stage('ready')
    let disposed = false
    const call = async (name, input, { expectError = false, allowError = false, signal } = {}) => {
      assert.equal(disposed, false, 'Harness is disposed')
      assert.equal(permissionMode.current, 'default')
      signal?.throwIfAborted()
      const tool = session.agent.state.tools.find(value => value.name === name)
      assert.ok(tool, `Actual registered Agent tool missing: ${name}`)
      const toolCall = { type: 'toolCall', id: randomUUID(), name, arguments: input }
      if (options.persistToolTranscript) sessionManager.appendMessage({ role: 'assistant', content: [toolCall],
        api: 'openai-responses', provider: 'fixture', model: 'isolated-no-llm', stopReason: 'toolUse', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
      let args, result, isError = false
      assert.equal(activeCall, undefined, 'Use sequential Agent calls so an approval cannot authorize a different request')
      activeCall = { name, input }
      currentPrompt = undefined
      try {
        const prepared = tool.prepareArguments ? tool.prepareArguments(input) : input
        args = validateToolArguments(tool, { ...toolCall, arguments: prepared })
        const blocked = await session.agent.beforeToolCall({ toolCall, args, context: session.agent.state }, signal)
        if (blocked?.block) throw new Error(blocked.reason || 'Actual Agent tool gate blocked execution')
        result = await tool.execute(toolCall.id, args, signal)
        isError = result.isError === true || structuredOf(result)?.ok === false
      } catch (error) {
        result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        isError = true
      } finally {
        activeCall = undefined
        currentPrompt = undefined
      }
      const patch = await session.agent.afterToolCall({ toolCall, args, result, isError, context: session.agent.state }, signal)
      if (patch) for (const key of ['content', 'details', 'usage', 'terminate']) if (patch[key] !== undefined) result[key] = patch[key]
      isError = patch?.isError ?? isError
      const outcome = { ...result, isError, text: textOf(result), structured: structuredOf(result) }
      if (options.persistToolTranscript) sessionManager.appendMessage({ role: 'toolResult', toolCallId: toolCall.id,
        toolName: name, content: result.content, ...(result.details === undefined ? {} : { details: result.details }),
        isError, timestamp: Date.now() })
      calls.push({ name, isError, ...(typeof input.path === 'string' ? { path: input.path } : {}) })
      assert.deepEqual(errors, [], 'Actual PI extension execution must not fail silently')
      if (expectError) assert.equal(isError, true, `${name} unexpectedly succeeded`)
      else if (isError && !allowError) throw Object.assign(new Error(`${name} failed through actual Agent tools: ${outcome.text}`), { outcome })
      return outcome
    }
    return { call, binding, history, guard, registry, permissionMode,
      async prompt(text) {
        assert.ok(streaming, 'A real provider fixture is required to run the Agent loop')
        assert.equal(disposed, false)
        assert.equal(activeCall, undefined)
        assert.equal(streamingActive, false)
        // Manual fixture preparation (e.g. the real abs_export) owns a history
        // turn too. Complete it through its real extension lifecycle before the
        // SDK's before_agent_start begins the actual user turn.
        if (history.hasActiveTurn) await session.extensionRunner.emit({ type: 'agent_settled', messages: [] })
        assert.equal(history.hasActiveTurn, false)
        streamingActive = true
        promptRuns++
        try {
          await session.prompt(text)
          await session.waitForIdle?.()
          assert.deepEqual(errors, [], 'Actual provider and tool hooks must remain clean')
          assert.equal(activeCall, undefined, 'Every streaming call must have its real result')
        } finally { streamingActive = false }
      },
      messages: () => structuredClone(session.agent.state.messages),
      historyEntries: () => structuredClone(sessionManager.getEntries().filter(entry => entry.type === 'custom')),
      sessionSnapshot: () => structuredClone([sessionManager.getHeader(), ...sessionManager.getEntries()]),
      async beginTurn(prompt) {
        assert.equal(disposed, false)
        assert.equal(streamingActive, false, 'Direct-tool lifecycle must not overlap a provider prompt')
        assert.equal(activeCall, undefined)
        assert.equal(history.hasActiveTurn, false, 'Settle the preceding real turn first')
        assert.equal(typeof prompt, 'string')
        // Use the SDK's actual dedicated turn-start dispatcher. A direct
        // history.begin() would bypass per-turn extension state (including the
        // cached settlement promise and the normal host ABS preflight).
        await session.extensionRunner.emitInput(prompt, undefined, 'rpc')
        const started = await session.extensionRunner.emitBeforeAgentStart(prompt, undefined, {
          cwd: sourceProject, customPrompt: session.systemPrompt, selectedTools: session.agent.state.tools.map(tool => tool.name),
          contextFiles: [], skills: []
        })
        assert.deepEqual(errors, [], 'Actual turn-start hooks must complete cleanly')
        assert.equal(history.hasActiveTurn, true)
        return { actualSdkBeforeAgentStart: true, actualProviderPrompt: false, messages: structuredClone(started.messages),
          projectControl: structuredClone(services.contextCache.currentControl('blockly-abi-check')) }
      },
      async settle() {
        // Exercise the real extension lifecycle, not a script replacement for
        // history publication or the SDK's successful-turn boundary.
        await session.extensionRunner.emit({ type: 'agent_settled', messages: [] })
        assert.deepEqual(errors, [], 'Actual settlement hooks must complete cleanly')
        assert.equal(history.hasActiveTurn, false)
      },
      async readText(file, options = {}) {
        const result = await call('read', { path: file, ...options })
        assert.ok(!result.details?.truncation?.truncated, 'Do not treat a truncated core-tool read as a complete candidate')
        return result.text
      },
      write: (file, content) => call('write', { path: file, content }),
      edit: (file, oldText, newText) => call('edit', { path: file, edits: [{ oldText, newText }] }),
      proof: () => ({ actualSdkSession: true, actualCoreTools: true, actualPiToolCallHooks: true, actualWorkspaceHistoryLifecycle: true,
        actualPermissionSystem: true, permissionMode: permissionMode.current,
        permissionScope: permissionService.getRuntimeState(), associatedProjects: binding.associatedProjectRoots,
        toolEvents, resultEvents, permissionPrompts, permissionDecisions: [...permissionDecisions], calls: [...calls], llmInvoked: false,
        ...(streaming ? { actualProviderSession: true, promptRuns } : {}),
        sessionUserMessages: sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user').length }),
      async dispose() {
        if (disposed) return
        disposed = true
        // SDK dispose invalidates contexts but does not emit extension shutdown;
        // the real permission forwarder owns a timer that needs its lifecycle.
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
        session.dispose()
        if (ownHistory) await history.dispose()
      }
    }
  } catch (error) {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }
    if (ownHistory) await history.dispose()
    throw error
  }
}
