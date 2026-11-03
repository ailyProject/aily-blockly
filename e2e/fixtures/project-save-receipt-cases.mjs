import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Delays the real editor save in this owned renderer; never writes project
 * files or substitutes a save result. Lost IPC affects only the first start's
 * response. Status calls and the original persistence continue normally. */
export async function runProjectSaveReceiptCases({ page, app, project, createAgent, editNumber, assertSaved, chooseDialog }) {
  await page.evaluate(() => {
    const domain = window.ng.getComponent(document.querySelector('blockly-main')).projectService
    const editor = domain.application.blocklyEditorProjectService
    const original = editor.save.bind(editor)
    window.__receiptSaves = { delays: [], calls: [] }
    editor.save = async (...args) => {
      const record = { started: Date.now(), delay: window.__receiptSaves.delays.shift() ?? 0 }
      window.__receiptSaves.calls.push(record)
      await new Promise(resolve => setTimeout(resolve, record.delay))
      try { const result = await original(...args); record.projectSaved = result.projectSaved; return result }
      finally { record.finished = Date.now() }
    }
  })
  const armDelay = delay => page.evaluate(delay => { window.__receiptSaves.delays.push(delay) }, delay)
  const calls = () => page.evaluate(() => window.__receiptSaves.calls)
  const manualId = await editNumber(61)
  console.log('SAVE_RECEIPT_PHASE=manual-delayed')
  await armDelay(6500)
  const manualStarted = Date.now()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => window.__receiptSaves.calls.length === 1)
  await page.waitForTimeout(5500)
  assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).projectSavingFromUi), true)
  assert.equal((await calls())[0].finished, undefined)
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => window.__receiptSaves.calls[0]?.finished && !window.ng.getComponent(document.querySelector('app-header')).projectSavingFromUi,
    undefined, { timeout: 20000 })
  assert.equal((await calls()).length, 1, 'A repeated pending Ctrl+S must not start another write')
  await assertSaved(manualId, 61)
  await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
  const manual = { elapsedMs: Date.now() - manualStarted, lateResultAdopted: true, saves: 1 }

  const agentId = await editNumber(62)
  console.log('SAVE_RECEIPT_PHASE=agent-lost-reply')
  await armDelay(16000)
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const state = global.__saveReceiptFault = { starts: [], queries: [], dropped: 0 }
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
  const agent = await createAgent()
  let saved, proof, transport, build
  try {
    const outcome = await agent.call('project_save', { project })
    saved = outcome.structured
    assert.equal(saved?.ok, true)
    assert.equal(saved.workspaceSaveVerification?.ok, true)
    transport = await app.evaluate(() => global.__saveReceiptFault)
    assert.equal(transport.dropped, 1)
    assert.equal(transport.starts.length, 1)
    assert.ok(transport.queries.length >= 1)
    const requestId = transport.starts[0].requestId
    assert.ok(transport.queries.every(query => query.requestId === requestId))
    assert.equal((await calls()).length, 2, 'A lost receipt must not replay the editor save')
    const hostPid = await app.evaluate(() => process.pid)
    const observed = (await agent.call('project_save', { project, save_request_id: requestId, save_target_pid: hostPid })).structured
    assert.equal(observed?.ok, true)
    assert.equal((await calls()).length, 2, 'Explicit receipt recovery is read-only')
    const unknown = await agent.call('project_save', { project, save_request_id: 'unknown-isolated-receipt', save_target_pid: hostPid }, { allowError: true })
    assert.equal(unknown.isError, true)
    assert.equal((await calls()).length, 2, 'An unknown receipt cannot create a new save')
    console.log('SAVE_RECEIPT_PHASE=compile')
    const compileStarted = Date.now()
    const resultFile = path.join(project, '.log/compile/latest-result.json')
    const previousCompile = await fs.readFile(resultFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    const compiled = (await agent.call('project_build', { project })).structured
    assert.equal(compiled?.ok, true, 'The saved native program must still compile through the actual Agent tool')
    const compileText = await fs.readFile(resultFile, 'utf8'), compile = JSON.parse(compileText)
    assert.equal(compile.success, true)
    assert.ok(compile.finishedAt >= compileStarted)
    assert.notEqual(compileText, previousCompile, 'Do not count an old compilation as this tool result')
    build = { ok: true, finishedAt: compile.finishedAt, freshResultVerified: true }
    transport = await app.evaluate(() => global.__saveReceiptFault)
    proof = agent.proof()
    await agent.settle()
  } finally { await agent.dispose() }
  await assertSaved(agentId, 62)

  const exitId = await editNumber(63)
  console.log('SAVE_RECEIPT_PHASE=exit-delayed')
  await armDelay(6500)
  const closed = app.waitForEvent('close', { timeout: 30000 })
  await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).close())
  await chooseDialog('save', ['cancel', 'continue', 'save'], { closing: true })
  await page.waitForTimeout(5500)
  assert.equal((await calls()).length, 3)
  assert.equal((await calls())[2].finished, undefined, 'The application must remain open while its save is pending')
  assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).projectSavingFromUi), true)
  await closed
  return { manual, agent: { saved, transport, build, actualSdkProof: proof, originalTaskExecutedOnce: true },
    exit: { savedNumberId: exitId, savedValue: 63, waitedForOriginalSaveBeforeClosing: true },
    ownedHostClosed: true, realLlm: false }
}
