import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
export const nativeSourceHashes = async project => Object.fromEntries(await Promise.all(
  ['project.abi', 'project.abs', 'project.abs.map.json'].map(async name => {
    try { return [name, sha(await fs.readFile(path.join(project, name)))] }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error }
  })))

export function nativeBlockIndex(state) {
  const result = new Map(), pending = [...(state?.blocks?.blocks ?? [])]
  while (pending.length) {
    const block = pending.pop()
    assert.ok(block && typeof block.id === 'string' && typeof block.type === 'string')
    assert.ok(!result.has(block.id), 'Duplicate native block identity')
    result.set(block.id, block)
    if (block.next?.block) pending.push(block.next.block)
    for (const input of Object.values(block.inputs ?? {})) for (const key of ['block', 'shadow'])
      if (input?.[key]) pending.push(input[key])
  }
  return result
}
export const nativeComments = state => [...nativeBlockIndex(state)].filter(([, block]) => block.icons?.comment)
  .map(([id, block]) => ({ id, comment: block.icons.comment })).sort((a, b) => a.id.localeCompare(b.id))

export async function captureNativeCommentState(page, project) {
  return page.evaluate(target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor')), editor = c.blocklyService
    if (c.projectService.currentProjectPath !== target) throw Error('Refuse an unrelated native project')
    return { workspace: window.Blockly.serialization.workspaces.save(editor.workspace),
      document: editor.getProjectAbiForSave(editor.getProjectDocument()),
      activity: { writing: editor.aiWriting, waitHint: editor.aiWaitWriting,
        busy: editor.isWorkspaceEditInProgress(), blocked: editor.isWorkspaceEditBlocked(),
        recoveryRequired: editor.isWorkspaceRecoveryRequired(), ready: editor.isLibraryRuntimeReady() } }
  }, project)
}

/** Real native setters, real persistence coordinator and real runtime rebuild.
 * No loader/guard/tool executor is replaced or forced to accept a partial graph. */
export async function prepareOnlineNativeCommentCase({ page, project, isolationRoot, marker }) {
  assert.ok(path.isAbsolute(project) && inside(isolationRoot, project))
  assert.match(isolationRoot.replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
  assert.ok(same(await fs.realpath(project), project))
  await page.evaluate(async ({ target, marker }) => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor')), B = window.Blockly
    if (c.projectService.currentProjectPath !== target) throw Error('Refuse an unrelated native project')
    const editor = c.blocklyService, roots = editor.workspace.getTopBlocks(false)
    if (editor.isWorkspaceEditBlocked()) throw Error('The fixture must begin with a healthy native workspace')
    const setup = roots.find(block => block.type === 'arduino_setup'), loop = roots.find(block => block.type === 'arduino_loop')
    if (!setup || !loop) throw Error('A complete local UNO template is required')
    for (const [block, pinned, x, y] of [[setup, false, 370, 230], [loop, true, 440, 340]]) {
      block.setCommentText(`${marker} ${pinned ? 'pinned' : 'closed'} 原始注释`)
      await B.renderManagement.finishQueuedRenders()
      const icon = block.getIcon(B.icons.CommentIcon.TYPE)
      await icon.setBubbleVisible(true)
      icon.setBubbleSize(new B.utils.Size(260, 130))
      icon.setBubbleLocation(new B.utils.Coordinate(x, y))
      await B.renderManagement.finishQueuedRenders()
      if (!pinned) await icon.setBubbleVisible(false)
    }
    const saved = await c.projectService.save(target)
    if (!saved.success) throw Error(saved.error || 'The real fixture save failed')
  }, { target: project, marker })
  const before = await captureNativeCommentState(page, project), beforeHashes = await nativeSourceHashes(project)
  const comments = nativeComments(before.workspace)
  assert.equal(comments.length, 2)
  for (const pinned of [false, true]) assert.ok(comments.some(({ comment }) => comment.pinned === pinned
    && Number.isFinite(comment.x) && Number.isFinite(comment.y) && comment.width === 260 && comment.height === 130),
  'Both native pinned and explicit closed coordinates must actually be persisted')
  const rebuild = await page.evaluate(async target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor')), native = c._projectService
    if (native.currentProjectPath !== target) throw Error('Refuse an unrelated runtime rebuild')
    await native.rebuildLibraryRuntime({ projectPath: target, packageJson: native.currentPackageData,
      libraryNames: [...c.blocklyService.loadedLibraryInfos.values()].map(value => value.packageName) })
    const offer = await native.inspectLibraryRuntimeRecovery()
    return { recoveryOfferPresent: !!offer }
  }, project)
  const after = await captureNativeCommentState(page, project), afterHashes = await nativeSourceHashes(project)
  assert.deepEqual(after.workspace, before.workspace, 'The complete native workspace must survive reconstruction')
  assert.deepEqual(after.document, before.document, 'Pages, shared state and all metadata must survive reconstruction')
  assert.deepEqual(afterHashes, beforeHashes, 'Runtime-only reconstruction must preserve all published source bytes')
  assert.deepEqual(after.activity, { writing: false, waitHint: false, busy: false, blocked: false, recoveryRequired: false, ready: true })
  assert.equal(rebuild.recoveryOfferPresent, false)
  return { baseline: after, evidence: { sourceHashes: afterHashes, comments, runtimeRebuilt: true,
    fullNativeReadback: true, completeDocumentMatched: true, recoverRuntime: { state: 'not-needed', reason: 'healthy-no-offer' } } }
}

export function nativeSessionTools(session) {
  const calls = session.messages.filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
    .filter(block => block.type === 'toolCall').map(call => ({ ...call,
      tool: call.name === 'tool_invoke' ? call.arguments?.name : call.name,
      args: call.name === 'tool_invoke' ? call.arguments?.arguments : call.arguments }))
  const ids = new Set()
  return calls.map(call => {
    assert.ok(typeof call.id === 'string' && !ids.has(call.id)); ids.add(call.id)
    const results = session.messages.filter(message => message.role === 'toolResult' && message.toolCallId === call.id)
    assert.ok(results.length <= 1, 'A committed SDK tool result must not be duplicated')
    const message = results[0]
    let result = message?.details?.result
    if (!result) for (const block of message?.content ?? []) if (block.type === 'text') {
      try { const parsed = JSON.parse(block.text); if (parsed && typeof parsed.ok === 'boolean') { result = parsed; break } } catch {}
    }
    return { ...call, message, result, index: message ? session.messages.indexOf(message) : -1 }
  })
}

export function assertOnlineNativeReceipts(session, project) {
  const tools = nativeSessionTools(session), successful = name => tools.filter(tool => tool.tool === name
    && tool.message?.isError !== true && tool.result?.ok === true)
  const validated = successful('abs_validate').at(-1), applied = successful('abs_apply').at(-1), built = successful('project_build').at(-1)
  assert.ok(validated && applied && built, 'A model answer cannot replace actual validate/apply/compile results')
  assert.ok(validated.index < applied.index && applied.index < built.index)
  for (const tool of [validated, applied, built]) assert.ok(same(tool.args?.project, project) && same(tool.result.project, project))
  assert.equal(validated.result.receipt?.validation?.ok, true)
  assert.equal(validated.result.receipt.validation.scope, 'prepared-generation')
  assert.equal(applied.result.applyVerification?.ok, true)
  assert.equal(applied.result.receipt?.validation?.scope, 'complete-generation')
  assert.equal(applied.result.receipt.validation.ok, true)
  assert.deepEqual(applied.result.receipt.candidate, validated.result.receipt.candidate)
  assert.equal(applied.result.receipt.base.generation, validated.result.receipt.base.generation)
  assert.equal(built.result.buildReceipt?.state, 'completed')
  assert.ok(same(built.result.buildReceipt.project, project))
  assert.ok(typeof built.result.buildReceipt.requestId === 'string' && built.result.buildReceipt.requestId)
  assert.equal(built.result.verification?.scope, 'project-compilation')
  assert.equal(built.result.verification.status, 'passed')
  assert.notEqual(built.args?.preprocess_only, true)
  const absPath = path.join(project, 'project.abs')
  const publishedPath = file => {
    if (same(file, absPath)) return true
    if (typeof file !== 'string') return false
    const relative = path.relative(path.join(project, '.workspace-history/overlays'), file).replaceAll('\\', '/')
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/view\/project\.abs$/i.test(relative)
  }
  const edits = tools.filter(tool => ['write', 'edit'].includes(tool.tool) && tool.message?.isError !== true
    && same(path.resolve(project, tool.args?.path ?? ''), absPath) && tool.index < validated.index)
    .flatMap(tool => tool.message?.details?.absEdits ?? [])
    .filter(edit => publishedPath(edit.path) && edit.publication === 'published' && edit.changed === true)
  assert.ok(edits.length > 0, 'The real model must publish a native ABS file edit before validation')
  assert.deepEqual(edits.at(-1).after, applied.result.receipt.candidate)
  return { tools, evidence: { validate: validated.result.receipt, apply: applied.result.receipt,
    applyVerification: applied.result.applyVerification, build: built.result.buildReceipt,
    nativeEdit: edits.at(-1).after, matchedOriginalToolIds: true, compilationScope: built.result.verification } }
}

export function assertNativeCommentEditPreserved(before, after, marker) {
  const old = nativeBlockIndex(before.workspace), current = nativeBlockIndex(after.workspace)
  for (const [id, block] of old) {
    const loaded = current.get(id); assert.ok(loaded, 'A preexisting block cannot disappear')
    const { inputs, next, ...attributes } = block, { inputs: loadedInputs, next: loadedNext, ...loadedAttributes } = loaded
    assert.deepEqual(loadedAttributes, attributes, 'All original native block attributes must remain exact')
    if (next?.block) assert.equal(loadedNext?.block?.id, next.block.id)
    for (const [name, input] of Object.entries(inputs ?? {})) for (const key of ['block', 'shadow'])
      if (input?.[key]) assert.equal(loadedInputs?.[name]?.[key]?.id, input[key].id)
  }
  const envelope = document => ({ ...document, pages: document.pages.map(({ content, ...page }) => page) })
  assert.deepEqual(envelope(after.document), envelope(before.document))
  for (const page of before.document.pages) {
    const loaded = after.document.pages.find(value => value.id === page.id)
    if (page.id !== before.document.activePageId) assert.deepEqual(loaded.content, page.content)
    else {
      const { blocks, ...extra } = page.content, { blocks: loadedBlocks, ...loadedExtra } = loaded.content
      assert.deepEqual(loadedExtra, extra)
    }
  }
  assert.deepEqual(nativeComments(after.workspace), nativeComments(before.workspace))
  const added = [...current].filter(([id]) => !old.has(id)).map(([, block]) => block)
  assert.deepEqual(added.map(block => block.type).sort(), ['serial_print', 'text'])
  assert.ok(added.some(block => block.type === 'text' && Object.values(block.fields ?? {}).includes(marker)))
  assert.equal(after.activity.recoveryRequired, false); assert.equal(after.activity.blocked, false)
  return { originalBlocks: old.size, addedBlocks: added.length, nativeCommentsPreserved: true,
    allOriginalAttributesPreserved: true, documentEnvelopeAndInactivePagesPreserved: true }
}
