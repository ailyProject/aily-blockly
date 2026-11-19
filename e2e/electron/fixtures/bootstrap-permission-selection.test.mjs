import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const directory = path.dirname(fileURLToPath(import.meta.url))
const lex = path.resolve(directory, '../../../../aily-lex-pro')
const require = createRequire(path.resolve(directory, '../../../package.json'))
const ts = require('typescript')

async function functionSource(file, name) {
  const source = await fs.readFile(file, 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let found
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    else ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(found, `${name} must be the actual source function`)
  return ts.transpile(found.getText(parsed).replace(/^export\s+/m, ''), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None
  })
}

test('natural selection waits for full permission after the dialog closes', async () => {
  const ui = path.join(lex, 'packages/aily-chat/ui/src')
  const confirm = await functionSource(path.join(ui, 'hooks/useChatMenus.ts'), 'confirmFullAccessPermission')
  const update = await functionSource(path.join(ui, 'services/chat/actions/settings-actions.ts'), 'updateSettings')
  const select = await functionSource(path.join(directory, '../bootstrap-installed.acceptance.mjs'), 'selectOriginalSettings')
  let completeBackend
  const backend = new Promise(resolve => { completeBackend = resolve })
  let dialogVisible = true, backendMode = 'default', uiMode = 'default', returned = false
  let updateOperation, releaseIndicator
  const indicator = new Promise(resolve => { releaseIndicator = resolve })
  const evidence = {}
  const context = {
    assert, evidence, selectedModel: { id: 'auto' }, fullAccessRequest: { sessionId: null }, activeSessionId: null,
    rememberedFullAccessSessionsRef: { current: new Set() },
    setFullAccessRequest: value => { dialogVisible = value !== null },
    getAgentSessionState: () => ({ activeSessionId: null }),
    setAgentPermissionMode: () => { throw new Error('No existing session may be modified') },
    setAgentDefaultPermissionMode: async mode => { await backend; backendMode = mode },
    getUiState: () => ({ runtimeSettings: {}, permissionMode: uiMode }),
    saveWorkspacePreferences: () => {},
    patchUiState: patch => { uiMode = patch.permissionMode; if (uiMode === 'full') releaseIndicator() },
    selectOnlineModelFromUi: async () => ({ id: 'auto' })
  }
  const frame = {
    locator(selector) {
      if (selector === '.permission-mode-indicator') return {
        click: async () => {}, innerText: async () => uiMode === 'full' ? 'Full access' : 'Default'
      }
      if (selector === '.popup-menu-permission button') return {
        filter: () => ({ count: async () => 1, click: async () => {} })
      }
      if (selector === 'i.fa-triangle-exclamation') return {}
      if (selector === '.permission-mode-indicator i.fa-triangle-exclamation') return {
        waitFor: async () => { if (uiMode !== 'full') await indicator }
      }
      if (selector === '.full-access-permission-dialog') return {
        waitFor: async ({ state }) => assert.equal(dialogVisible, state === 'visible'),
        locator: child => child === 'input[type="checkbox"]'
          ? { uncheck: async () => {} }
          : { click: async () => context.confirmFullAccessPermission(false) }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    }
  }
  context.loaded = { frame }
  context.invoke = (name, input) => {
    assert.equal(name, 'settings.update')
    updateOperation = context.updateSettings(input)
    return updateOperation
  }
  vm.createContext(context)
  vm.runInContext(`${update}\n${confirm}\n${select}`, context)
  const selection = context.selectOriginalSettings().then(() => { returned = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(dialogVisible, false, 'The real confirmation hides before its async settings command finishes')
    assert.equal(backendMode, 'default')
    assert.equal(returned, false, 'Do not send while the full-permission command is still pending')
  } finally {
    completeBackend()
    await updateOperation
    await selection
  }
  assert.equal(backendMode, 'full')
  assert.equal(uiMode, 'full')
  assert.equal(returned, true)
  assert.equal(evidence.settingsSelectedViaVisibleUi.permissionMode, 'full')
})
