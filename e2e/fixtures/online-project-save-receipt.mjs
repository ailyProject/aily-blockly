import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const sha = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const textOf = value => (value?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')

/** Compare the complete program, models and protected block attributes, but
 * not view-only coordinates. Fields containing their own x/y data stay intact. */
export function savedProgramHash(document) {
  const copy = JSON.parse(JSON.stringify(document))
  const isBlock = value => value && typeof value.id === 'string' && typeof value.type === 'string'
  const block = value => {
    if (!isBlock(value)) return value
    delete value.x; delete value.y
    // Traverse only Blockly's structural links. An opaque field, extraState,
    // plugin payload or model can legitimately contain ordered id/type data.
    for (const input of Object.values(value.inputs ?? {})) if (input && typeof input === 'object') {
      if (input.block) block(input.block)
      if (input.shadow) block(input.shadow)
    }
    if (value.next?.block) block(value.next.block)
    return value
  }
  const roots = value => {
    if (!Array.isArray(value)) return
    value.forEach(block)
    if (value.every(isBlock)) value.sort((a, b) => a.id.localeCompare(b.id))
  }
  for (const page of copy.pages) {
    delete page.viewState
    roots(page.content?.blocks?.blocks)
  }
  roots(copy.sharedModel?.procedureBlocks)
  return sha(JSON.stringify(canonical(copy)))
}

/** The real SDK may expose a deferred tool through tool_invoke. Match its
 * original ID, not a display label or a second fabricated direct-tool call. */
export function onlineSaveToolEvidence(snapshot, project) {
  const calls = snapshot.messages.filter(item => item.role === 'assistant').flatMap(item => item.content ?? [])
    .filter(item => item.type === 'toolCall').map(item => ({ ...item,
      actualName: item.name === 'tool_invoke' ? item.arguments?.name : item.name,
      actualArguments: item.name === 'tool_invoke' ? item.arguments?.arguments : item.arguments }))
  const saves = calls.filter(item => item.actualName === 'project_save')
  assert.equal(saves.length, 1, 'The real LLM must invoke project_save exactly once, never replay it')
  const call = saves[0]
  assert.ok(typeof call.actualArguments?.project === 'string' && path.isAbsolute(call.actualArguments.project))
  assert.ok(same(call.actualArguments?.project ?? '', project))
  assert.equal(call.actualArguments?.save_request_id, undefined, 'This is one original save, not a second model-issued status tool')
  const forbidden = ['write', 'edit', 'abs_export', 'abs_apply', 'abs_validate', 'project_build', 'blocks_tidy', 'project_upload', 'app_reload']
  assert.deepEqual(calls.filter(item => forbidden.includes(item.actualName)).map(item => item.actualName), [],
    'A save-only turn must not edit, apply, compile, tidy, upload or reload')
  const results = snapshot.messages.filter(item => item.role === 'toolResult' && item.toolCallId === call.id)
  assert.equal(results.length, 1, 'The SDK must commit the original save result only once')
  assert.notEqual(results[0].isError, true)
  const saved = results[0].details?.result ?? JSON.parse(textOf(results[0]))
  assert.equal(saved.ok, true); assert.equal(saved.projectSaved, true); assert.equal(saved.partial, false)
  assert.equal(saved.saveReceipt?.state, 'completed'); assert.equal(saved.saveReceipt.operation, 'project_save')
  assert.equal(saved.workspaceSaveVerification?.ok, true)
  assert.equal(saved.workspaceSaveVerification.candidateApplied, false)
  assert.ok(same(saved.saveReceipt.project, project))
  return { saved, toolCallIdSha256: sha(call.id), toolCalls: saves.length, toolResults: results.length,
    sdkTool: call.name, noModelMutationOrCompilation: true }
}

/** A streamed deferred invocation may not reveal its target name until its
 * arguments finish. The SDK resolves that name; the service preserves its ID. */
export function onlineSaveServiceToolEvidence(transport, sdkProof) {
  const calls = transport.operations.flatMap(operation => operation.toolCalls)
    .filter(call => call.idHash === sdkProof.toolCallIdSha256)
  assert.equal(calls.length, 1, 'The real service must emit the original SDK save tool ID exactly once')
  assert.ok(['project_save', 'tool_invoke'].includes(calls[0].name), 'The original service call must be a save or deferred invocation')
  return { toolCallIdSha256: calls[0].idHash, wireToolName: calls[0].name, serviceToolCalls: calls.length }
}

/** Test-owned latency and one lost IPC reply only. Every save still calls the
 * real editor method once; no file writes or synthetic model/state responses. */
export async function prepareOnlineProjectSaveReceipt({ page, app, project }) {
  assert.ok(path.isAbsolute(project) && /[\\/]aily-project[\\/]dev-tests[\\/].+[\\/]online-installed-[^\\/]+[\\/]project$/.test(project))
  await page.evaluate(expected => {
    const domain = window.ng.getComponent(document.querySelector('blockly-main')).projectService
    if (domain.currentProjectPath.replaceAll('\\', '/').toLowerCase() !== expected.replaceAll('\\', '/').toLowerCase())
      throw new Error('Refuse to instrument another project')
    const editor = domain.application.blocklyEditorProjectService, original = editor.save.bind(editor)
    if (window.__onlineSaveReceipts) throw new Error('Receipt injection is already installed')
    window.__onlineSaveReceipts = { delays: [], calls: [] }
    editor.save = async (...args) => {
      const state = window.__onlineSaveReceipts
      const selected = state.agentDelayPending ?? state.delays.shift() ?? { kind: 'unarmed', delay: 0 }
      state.agentDelayPending = undefined
      const record = { ...selected, started: Date.now() }
      window.__onlineSaveReceipts.calls.push(record)
      await new Promise(resolve => setTimeout(resolve, record.delay))
      try { const result = await original(...args); record.projectSaved = result.projectSaved; record.partial = result.partial; return result }
      finally { record.finished = Date.now() }
    }
  }, project)
  const nativeDocument = () => page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return JSON.parse(editor.blocklyService.captureRecoverySnapshot().documentText)
  })
  const armDelay = (kind, delay) => page.evaluate(value => window.__onlineSaveReceipts.delays.push(value), { kind, delay })
  const calls = () => page.evaluate(() => window.__onlineSaveReceipts.calls)
  const waitStar = value => page.waitForFunction(value => {
    const header = window.ng.getComponent(document.querySelector('app-header'))
    return header.hasUnsavedProjectChanges === value && !header.projectSavingFromUi && !header.projectConflictResolving
  }, value, { timeout: 20000 })
  const editNumber = async value => {
    const edited = await page.evaluate(value => {
      const main = window.ng.getComponent(document.querySelector('blockly-main'))
      const block = window.Blockly.getMainWorkspace().getAllBlocks(false).find(item => item.type === 'math_number' && !item.isShadow())
      if (!block) throw new Error('The owned acceptance seed needs one ordinary number block')
      const previewToken = main.generatedArtifactRetryToken, changed = Number(block.getFieldValue('NUM')) !== value
      block.setFieldValue(String(value), 'NUM')
      return { id: block.id, changed, previewToken }
    }, value)
    if (edited.changed) await page.waitForFunction(previous => {
      const main = window.ng.getComponent(document.querySelector('blockly-main'))
      return main.generatedArtifactRetryToken > previous && !main.backgroundCodeGenerationInProgress && !main.generatedArtifactRetryTimer
    }, edited.previewToken, { timeout: 20000 })
    await waitStar(true)
    return edited.id
  }
  const findBlock = (value, id) => {
    if (!value || typeof value !== 'object') return undefined
    if (value.id === id && typeof value.type === 'string') return value
    for (const child of Object.values(value)) { const block = findBlock(child, id); if (block) return block }
    return undefined
  }
  const assertDisk = async (id, value, expectedProgram) => {
    const document = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
    const map = JSON.parse(await fs.readFile(path.join(project, 'project.abs.map.json'), 'utf8'))
    assert.equal(Number(findBlock(document, id)?.fields?.NUM), value)
    assert.equal(map.savedAbiHash, 'sha256:' + sha(JSON.stringify(canonical(document))))
    if (expectedProgram) assert.equal(savedProgramHash(document), expectedProgram, 'Saving must preserve the exact native program and models')
    return { programSha256: savedProgramHash(document), abiSha256: map.savedAbiHash }
  }

  const manualId = await editNumber(61)
  await armDelay('manual', 6500)
  // Opening Chat focuses its iframe composer. Ctrl+S must originate from the
  // actual host workspace, as it does for a user saving the canvas.
  const canvas = page.locator('blockly-main svg.blocklySvg').first()
  const canvasBox = await canvas.boundingBox()
  assert.ok(canvasBox && canvasBox.width > 100 && canvasBox.height > 100)
  await canvas.click({ position: { x: canvasBox.width - 40, y: 40 } })
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME')
  const started = Date.now()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => window.__onlineSaveReceipts.calls.some(item => item.kind === 'manual'))
  await page.waitForTimeout(5500)
  assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).projectSavingFromUi), true)
  assert.equal((await calls()).find(item => item.kind === 'manual').finished, undefined)
  await page.keyboard.press('Control+s')
  await waitStar(false)
  const allManualCalls = await calls(), manualCalls = allManualCalls.filter(item => item.kind === 'manual')
  assert.equal(allManualCalls.length, 1, 'A repeated Ctrl+S must not start an unlabelled second save either')
  assert.equal(manualCalls.length, 1); assert.equal(manualCalls[0].projectSaved, true); assert.equal(manualCalls[0].partial, false)
  assert.ok(manualCalls[0].finished - manualCalls[0].started >= 6500)
  const manual = { elapsedMs: Date.now() - started, saves: 1, repeatedShortcutDidNotReplay: true,
    starClearedAfterOriginalCompletion: true, ...await assertDisk(manualId, 61) }

  // The LLM receives a save-only goal after the real manual save. Leave that
  // exact program untouched; a second edit would obscure byte-level checks.
  const agentId = manualId, baselineDocument = await nativeDocument()
  const expectedAgentProgram = savedProgramHash(baselineDocument)
  // Bind the latency to receipt-bearing project_save dispatch, not to the
  // next arbitrary save during before_agent_start's normal synchronization.
  await page.evaluate(() => {
    const ipc = window.ipcRenderer ?? window.electronAPI?.ipcRenderer
    if (!ipc?.on) throw new Error('The real renderer IPC observer is unavailable')
    ipc.on('cli-bridge:blockly-live-operation', (_event, payload) => {
      const state = window.__onlineSaveReceipts
      if (payload?.operation === 'project_save' && payload.params?.saveRequest?.version === 1 && !state.agentRequestId) {
        state.agentRequestId = payload.params.saveRequest.requestId
        state.agentDelayPending = { kind: 'agent', requestId: state.agentRequestId, delay: 16000 }
      }
    })
  })
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const state = global.__onlineSaveReceiptFault = { starts: [], queries: [], dropped: 0 }
    for (const win of BrowserWindow.getAllWindows()) {
      const send = win.webContents.send.bind(win.webContents)
      win.webContents.send = (channel, payload, ...rest) => {
        if (channel === 'cli-bridge:blockly-live-operation' && payload?.params?.saveRequest) {
          const record = { requestId: payload.params.saveRequest.requestId, at: Date.now() }
          if (payload.operation === 'project_save') { state.starts.push(record); state.dropId ??= payload.requestId }
          if (payload.operation === 'project_save_status') state.queries.push(record)
        }
        return send(channel, payload, ...rest)
      }
    }
    const emit = ipcMain.emit
    ipcMain.emit = function (channel, ...args) {
      if (channel === 'cli-bridge:blockly-live-operation:response' && args[1]?.requestId === state.dropId && !state.dropped) {
        state.dropped++; return true
      }
      return emit.call(this, channel, ...args)
    }
  })

  return { manual, baselineDocument,
    async verifyAgent(snapshot) {
      const proof = onlineSaveToolEvidence(snapshot, project)
      const transport = await app.evaluate(() => global.__onlineSaveReceiptFault)
      assert.equal(transport.starts.length, 1); assert.equal(transport.dropped, 1); assert.ok(transport.queries.length >= 1)
      assert.ok(transport.queries.every(item => item.requestId === transport.starts[0].requestId))
      assert.equal(proof.saved.saveReceipt.requestId, transport.starts[0].requestId)
      const saves = await calls(), agentSaves = saves.filter(item => item.kind === 'agent')
      assert.equal(agentSaves.length, 1, 'The receipt-bound Agent task must call the real editor save once')
      assert.equal(saves.filter(item => item.started >= transport.starts[0].at).length, 1,
        'No additional editor save may follow the original Agent task dispatch')
      assert.equal(agentSaves[0].requestId, transport.starts[0].requestId)
      assert.equal(agentSaves[0].projectSaved, true); assert.equal(agentSaves[0].partial, false)
      assert.ok(agentSaves[0].finished - agentSaves[0].started >= 16000)
      assert.equal(savedProgramHash(await nativeDocument()), expectedAgentProgram)
      await waitStar(false)
      return { ...proof, transport, editorSaves: 1, autoSynchronizationSaves: saves.filter(item => item.kind === 'unarmed').length,
        delayBoundToRequest: agentSaves[0].requestId, elapsedSaveMs: agentSaves[0].finished - agentSaves[0].started,
        ...await assertDisk(agentId, 61, expectedAgentProgram) }
    },
    async finishExit() {
      const id = await editNumber(63), expected = savedProgramHash(await nativeDocument())
      await armDelay('exit', 6500)
      const closed = app.waitForEvent('close', { timeout: 30000 }), started = Date.now()
      await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).close())
      const modal = page.locator('app-unsave-dialog:visible')
      await modal.waitFor({ timeout: 5000 })
      const actions = await modal.evaluate(element => window.ng.getComponent(element).buttons.map(button => button.action))
      assert.deepEqual(actions, ['cancel', 'continue', 'save'])
      await modal.locator('.footer button').nth(actions.indexOf('save')).click()
      await page.waitForFunction(() => window.__onlineSaveReceipts.calls.some(item => item.kind === 'exit'))
      await page.waitForTimeout(5500)
      assert.equal((await calls()).filter(item => item.kind === 'exit').length, 1)
      assert.equal((await calls()).find(item => item.kind === 'exit').finished, undefined)
      assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).projectSavingFromUi), true)
      await closed
      assert.ok(Date.now() - started >= 6500)
      return { waitedForOriginalCompletion: true, exitedNormally: true, saves: 1, ...await assertDisk(id, 63, expected) }
    } }
}
