import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const nativeNames = new Set(['read', 'write', 'edit'])
const deferredNames = new Set(['project_recover', 'abs_export', 'abs_validate', 'abs_apply',
  'app_reload', 'project_build', 'app_close', 'app_info'])
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Observe the real embedded Chat session. This adapter does not import an
 * Agent, replace a tool executor, call a tool API, or create another harness. */
export async function createInstalledChatUiAgent(options) {
  const { loadedChat } = options
  assert.ok(loadedChat?.frame && typeof loadedChat.e2e === 'function')
  const project = path.resolve(options.project), isolationRoot = path.resolve(options.isolationRoot)
  assert.ok(inside(isolationRoot, project) && same(await fs.realpath(project), project))
  assert.ok(path.isAbsolute(options.installedRoot))
  const manifest = JSON.parse(await fs.readFile(path.join(options.installedRoot, 'package.json'), 'utf8'))
  const receipt = JSON.parse(await fs.readFile(path.join(options.installedRoot, 'runtime/build-evidence.json'), 'utf8'))
  assert.equal(manifest.name, '@aily-project/subapp-aily-chat')
  if (options.expectedInputHash) assert.equal(receipt.inputHash, options.expectedInputHash)
  if (options.expectedOutputHash) assert.equal(receipt.outputHash, options.expectedOutputHash)
  assert.equal(loadedChat.evidence?.buildEvidence?.inputHash, receipt.inputHash)
  assert.equal(loadedChat.evidence?.buildEvidence?.outputHash, receipt.outputHash)
  const observed = new Map(), tools = [], trustDecisions = []
  let sessionId, lastSnapshot, promptRuns = 0, disposed = false, queue = Promise.resolve()
  const assertArguments = (name, args) => {
    assert.ok(args && typeof args === 'object' && !Array.isArray(args))
    if (name === 'tool_load') {
      assert.ok(Array.isArray(args.names) && args.names.length > 0)
      for (const target of args.names) assert.ok(deferredNames.has(target), `Do not load unrelated tool: ${target}`)
    } else if (name === 'tool_invoke') {
      assert.ok(deferredNames.has(args.name)); assertArguments(args.name, args.arguments)
    } else if (nativeNames.has(name)) {
      assert.ok(typeof args.path === 'string' && path.isAbsolute(args.path) && inside(project, args.path))
      if (name !== 'read') assert.ok(same(args.path, path.join(project, 'project.abs')), 'Only ABS may be edited')
    } else {
      assert.ok(deferredNames.has(name), `Unexpected executable tool: ${name}`)
      assert.ok(typeof args.project === 'string' && same(args.project, project), 'Only this isolated project is in scope')
    }
  }
  const acknowledgeScopedTrust = async () => {
    const frame = loadedChat.frame
    if (frame.isDetached()) return
    assert.equal(await frame.locator('.full-access-permission-dialog').isVisible(), false,
      'The acceptance never grants full access')
    const dialogs = frame.locator('.pi-extension-dialog')
    for (let index = 0; index < await dialogs.count(); index++) {
      const dialog = dialogs.nth(index)
      if (!await dialog.isVisible()) continue
      const title = await dialog.getAttribute('aria-label'), lines = String(title).split(/\r?\n/)
      assert.equal(lines[0], 'Trust project folder?', 'Unexpected permission prompt is not automatically accepted')
      assert.ok(lines[1] && path.isAbsolute(lines[1]) && same(lines[1], project), 'Trust must name this exact fresh project')
      await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
      trustDecisions.push({ project, sessionOnly: true })
    }
  }
  const observeSnapshot = async () => {
    assert.equal(disposed, false)
    await acknowledgeScopedTrust()
    if (!sessionId) {
      const listed = await loadedChat.e2e('session.list')
      const candidates = listed.sessions.filter(item => same(item.cwd, project))
      assert.ok(candidates.length <= 1, 'A fresh isolated project must not acquire two embedded sessions')
      if (!candidates.length) return
      sessionId = candidates[0].sessionId
    }
    const value = await loadedChat.e2e('session.read', { sessionId })
    const snapshot = value.session
    assert.equal(snapshot.sessionId, sessionId)
    assert.ok(same(snapshot.cwd, project))
    assert.equal(snapshot.permissionMode, 'default')
    assert.equal(snapshot.activeTools.includes('code_run'), false)
    lastSnapshot = snapshot
    const ids = new Set()
    for (const message of snapshot.messages) {
      if (message.role === 'assistant') for (const block of message.content ?? []) {
        if (block.type === 'toolCall') assertArguments(block.name, block.arguments)
      }
      if (message.role !== 'toolResult') continue
      assert.ok(typeof message.toolCallId === 'string' && message.toolCallId)
      assert.equal(ids.has(message.toolCallId), false, 'Duplicate tool-result messages are not hidden by observation deduplication')
      ids.add(message.toolCallId)
      const digest = hash([message.toolName, message.content, message.details, message.isError])
      if (observed.has(message.toolCallId)) {
        assert.equal(observed.get(message.toolCallId), digest, 'A committed tool result cannot change between snapshots')
        continue
      }
      observed.set(message.toolCallId, digest)
      const result = { content: message.content, details: message.details, isError: message.isError === true }
      const event = { ...structuredClone(message), type: 'tool_execution_end',
        isError: message.isError === true, result: structuredClone(result), observationSource: 'embedded-session-snapshot' }
      tools.push({ id: event.toolCallId, name: event.toolName, isError: event.isError })
      await options.onToolResult?.(event)
    }
    if (snapshot.isOpen === false) {
      const final = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
      assert.ok(snapshot.isIdle && ['stop', 'error', 'aborted'].includes(final?.stopReason),
        'The original embedded session closed before its answer was settled')
    }
  }
  const flush = () => {
    const next = queue.then(observeSnapshot)
    queue = next
    return next
  }
  options.onStage?.('installed-embedded-composer-ready')
  return {
    async prompt(text) {
      assert.equal(promptRuns++, 0, 'Recovery must never submit a second user prompt')
      assert.equal(disposed, false)
      await flush()
      assert.equal(lastSnapshot?.messages.filter(message => message.role === 'user').length ?? 0, 0,
        'Only an empty newly-created embedded session is allowed')
      const composer = loadedChat.frame.locator('.aily-chat-composer-input[role="textbox"]')
      await composer.fill(text)
      await loadedChat.frame.locator('button.primary-action.send-action').click()
      options.onStage?.('installed-embedded-composer-sent')
      // This bounds the test, not the production provider or compilation timeout.
      const deadline = Date.now() + 12 * 60 * 1000
      do {
        await flush()
        if (lastSnapshot) {
          const users = lastSnapshot.messages.filter(message => message.role === 'user')
          assert.ok(users.length <= 1, 'Only one user message may be sent')
          const final = lastSnapshot.messages.filter(message => message.role === 'assistant').at(-1)
          if (users.length === 1 && lastSnapshot.isIdle && !lastSnapshot.isStreaming
            && ['stop', 'error', 'aborted'].includes(final?.stopReason)) return
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      } while (Date.now() < deadline)
      throw new Error('Embedded Agent did not settle within the isolated acceptance deadline')
    },
    flush,
    messages: () => lastSnapshot?.messages ?? [],
    snapshot: () => lastSnapshot,
    read: async () => { await flush(); return { session: lastSnapshot } },
    list: () => loadedChat.e2e('session.list'),
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
      return { actualEmbeddedComposerPrompt: true, actualInstalledComposition: true,
        installedVersion: manifest.version, inputHash: receipt.inputHash,
        privateAgentDistImported: false, replacementToolExecutor: false,
        actualPermissionMode: lastSnapshot?.permissionMode, promptRuns,
        sessionUserMessages: lastSnapshot?.messages.filter(message => message.role === 'user').length ?? 0,
        sessionId, trustDecisions: [...trustDecisions], tools: [...tools],
        snapshotToolExecutions: lastSnapshot?.toolExecutions?.length ?? 0 }
    },
    async dispose() {
      if (disposed) return
      await queue.catch(() => undefined)
      disposed = true
    }
  }
}
