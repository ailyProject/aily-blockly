import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const nativeNames = new Set(['read', 'write', 'edit'])
const deferredNames = new Set([
  'project_recover', 'abs_export', 'abs_validate', 'abs_apply',
  'app_reload', 'project_build', 'app_close', 'app_info'
])
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const absolute = (value, name) => {
  assert.ok(typeof value === 'string' && path.isAbsolute(value), `${name} must be absolute`)
  return path.resolve(value)
}

/** Runs the installed product's public composition and its normal provider,
 * permission/history hooks, progressive tool loading, and RetrySession. This
 * fixture never imports Agent dist or supplies a replacement tool executor.
 * The caller supplies deterministic localhost HTTP model output and configures
 * a dedicated process environment before loading this fixture.
 */
export async function createInstalledChatAgent(options) {
  const installedRoot = absolute(options.installedRoot, 'installedRoot')
  const isolationRoot = absolute(options.isolationRoot, 'isolationRoot')
  const project = absolute(options.project, 'project')
  const profileRoot = absolute(options.profileRoot, 'profileRoot')
  const authFile = absolute(options.authFile, 'authFile')
  assert.ok(inside(isolationRoot, project) && inside(isolationRoot, profileRoot))
  assert.ok(inside(isolationRoot, authFile))
  assert.ok(same(project, await fs.realpath(project)), 'Only a fresh physical project is allowed')
  assert.equal(process.env.AILY_API_SERVER, options.apiBase)
  assert.match(options.apiBase, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(same(process.env.AILY_AUTH_FILE ?? '', authFile))
  assert.ok(same(process.env.PI_CODING_AGENT_DIR ?? '', profileRoot))
  if (process.env.AILY_PORTABLE_ROOT) assert.ok(same(process.env.AILY_PORTABLE_ROOT, installedRoot))
  for (const key of ['HOME', 'USERPROFILE', 'AILY_APPDATA_PATH']) {
    assert.ok(process.env[key] && inside(isolationRoot, path.resolve(process.env[key])), `${key} must be isolated`)
  }
  assert.notEqual(process.env.AILY_CHILD_TOOL, '1', 'This independent harness must not claim the iframe process IPC lease')
  const auth = JSON.parse(await fs.readFile(authFile, 'utf8'))
  assert.ok(typeof auth.access_token === 'string' && auth.access_token.endsWith('.test-signature'),
    'Use the local protocol fixture identity, never a real account token')
  const manifest = JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@aily-project/subapp-aily-chat')
  assert.equal(manifest.ailyPortable?.format, 'js')
  const receipt = JSON.parse(await fs.readFile(path.join(installedRoot, 'runtime/build-evidence.json'), 'utf8'))
  if (options.expectedInputHash) assert.equal(receipt.inputHash, options.expectedInputHash)
  if (options.expectedOutputHash) assert.equal(receipt.outputHash, options.expectedOutputHash)
  const publicEntry = path.join(installedRoot, 'runtime/agent/index.js')
  const { createAilyHarness } = await import(pathToFileURL(publicEntry).href)
  assert.equal(typeof createAilyHarness, 'function')
  const tools = [], events = [], permissionPrompts = [], failures = []
  let promptRuns = 0, disposed = false, queue = Promise.resolve()
  const enqueue = work => {
    queue = queue.then(work).catch(error => { failures.push(error) })
  }
  const ui = new Proxy({
    async select(title, choices) {
      permissionPrompts.push({ title, choices: [...choices] })
      return choices.includes('No') ? 'No' : undefined
    },
    async confirm() { return false },
    async input() { return undefined },
    async custom() { return undefined },
    notify() {}
  }, { get: (target, key) => key in target ? target[key] : () => {} })
  const harness = createAilyHarness({ agentDir: profileRoot,
    resourceRoot: path.join(installedRoot, 'runtime/resources'), enableE2E: true })
  let session, unsubscribe
  const assertArguments = (name, args) => {
    assert.ok(args && typeof args === 'object' && !Array.isArray(args))
    if (name === 'tool_load') {
      assert.ok(Array.isArray(args.names) && args.names.length > 0)
      for (const target of args.names) assert.ok(deferredNames.has(target), `Do not load unrelated tool: ${target}`)
    } else if (name === 'tool_invoke') {
      assert.ok(deferredNames.has(args.name), `Do not invoke unrelated tool: ${args.name}`)
      assertArguments(args.name, args.arguments)
    } else if (nativeNames.has(name)) {
      assert.ok(typeof args.path === 'string' && path.isAbsolute(args.path))
      assert.ok(inside(project, path.resolve(args.path)), 'Native file calls stay in the fresh project')
      if (name !== 'read') assert.ok(same(args.path, path.join(project, 'project.abs')), 'Only ABS is edited')
    } else {
      assert.ok(deferredNames.has(name), `Unexpected executable tool: ${name}`)
      assert.ok(typeof args.project === 'string' && same(args.project, project), 'Host tools target only the fresh project')
    }
  }
  try {
    options.onStage?.('installed-public-harness-open')
    session = await harness.open({ cwd: project, developmentMode: 'blockly',
      model: { provider: 'aily-services', id: 'auto' }, permissionMode: 'default',
      projectTrustOverride: true, uiContext: ui }, { persistImmediately: true })
    assert.equal(session.getState().permissionMode, 'default')
    assert.equal(session.getState().activeTools.includes('code_run'), false)
    unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_execution_start') {
        try { assertArguments(event.toolName, event.args) } catch (error) { failures.push(error) }
      }
      if (event.type === 'tool_execution_end') {
        const tool = { ...event.result, type: event.type, toolName: event.toolName,
          toolCallId: event.toolCallId, isError: event.isError === true, result: event.result }
        tools.push(tool)
        enqueue(async () => options.onToolResult?.(tool))
      }
      if (['agent_start', 'agent_settled', 'tool_execution_start', 'tool_execution_end'].includes(event.type)) {
        events.push({ type: event.type, ...(event.toolName ? { toolName: event.toolName, toolCallId: event.toolCallId } : {}) })
      }
      enqueue(async () => options.onEvent?.(event))
    })
    options.onStage?.('installed-public-harness-ready')
    const flush = async () => {
      await queue
      if (failures.length) throw failures[0]
    }
    const e2e = async method => {
      const response = await harness.e2e.execute({ protocol: 'aily-agent-e2e', version: 4,
        method, ...(method === 'session.read' ? { sessionId: session.sessionId } : {}) })
      assert.equal(response.ok, true)
      return response.result
    }
    return {
      harness, session,
      async prompt(text) {
        assert.equal(promptRuns++, 0, 'One original user turn; recovery must not create another prompt')
        try { await session.prompt({ text, source: 'rpc' }); await session.waitForIdle() }
        finally { await flush() }
      },
      flush,
      messages: () => session.getState().messages,
      snapshot: () => session.getState(),
      read: () => e2e('session.read'),
      list: () => e2e('session.list'),
      nativeCall(id, name, args) {
        assert.ok(nativeNames.has(name)); assertArguments(name, args)
        return { id, name, arguments: args }
      },
      loadCall(id, names) {
        assertArguments('tool_load', { names })
        return { id, name: 'tool_load', arguments: { names } }
      },
      deferredCall(id, name, args) {
        assert.ok(deferredNames.has(name)); assertArguments(name, args)
        return { id, name: 'tool_invoke', arguments: { name, arguments: args } }
      },
      proof() {
        return { installedPublicEntry: publicEntry, installedVersion: manifest.version, inputHash: receipt.inputHash,
          actualInstalledComposition: true, privateAgentDistImported: false, replacementToolExecutor: false,
          actualPermissionMode: session.getState().permissionMode, promptRuns,
          sessionUserMessages: session.getState().messages.filter(message => message.role === 'user').length,
          permissionPrompts: permissionPrompts.length, tools: tools.map(tool => ({ name: tool.toolName,
            id: tool.toolCallId, isError: tool.isError })), events: [...events] }
      },
      async dispose() {
        if (disposed) return
        disposed = true
        unsubscribe?.()
        await harness.closeAll()
        await queue
      }
    }
  } catch (error) {
    unsubscribe?.()
    await harness.closeAll()
    throw error
  }
}
