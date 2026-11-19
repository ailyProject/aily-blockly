import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createLocalChatApiRouter, prepareInstalledChatProfile } from '../fixtures/installed-chat-ui.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
assert.ok(process.env.AILY_SAVE_HOST_BUILD && process.env.AILY_SAVE_AGENT_ROOT, 'Explicit current host and Agent builds are required')
const appData = 'C:/Users/LENOVO/AppData/Local/aily-project'
const seed = path.join(appData, 'dev-tests/abs-serial-analysis-20261028/archive-user-project/esp32-c3-HANTAI')
const root = await fs.mkdtemp(path.join(appData, 'dev-tests/save-receipts-20261102-'))
const project = path.join(root, 'serial-agent-receipts-' + randomUUID(), 'project')
const active = JSON.parse(await fs.readFile(path.join(appData, 'npm-global/app/store/subapp-aily-chat/active.json'), 'utf8'))
const installedRoot = await fs.realpath(path.join(appData, 'npm-global/app/store/subapp-aily-chat', active.selected.path))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const protectedFiles = ['package.json', 'package-lock.json', 'project.abi']
const before = new Map(await Promise.all(protectedFiles.map(async name => [name, digest(await fs.readFile(path.join(seed, name)))])))
await fs.mkdir(project, { recursive: true })
for (const name of [...protectedFiles, 'node_modules'])
  await fs.cp(path.join(seed, name), path.join(project, name), { recursive: true, force: false, errorOnExist: true })
const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
for (const spec of Object.values(manifest.dependencies ?? {})) if (typeof spec === 'string' && spec.startsWith('file:')) {
  const relative = spec.slice(5)
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'))
  await fs.cp(path.join(seed, relative), path.join(project, relative), { recursive: true, force: false, errorOnExist: true })
}
const api = await createLocalChatApiRouter({ installedRoot })
try {
  const profile = await prepareInstalledChatProfile({ appData: path.join(root, 'appdata'), installedRoot, apiBase: api.origin,
    baseConfigPath: path.join(appData, 'config.json') })
  Object.assign(process.env, profile.env)
  Object.assign(process.env, { AILY_SAVE_RECEIPT_ONLY: '1', AILY_SAVE_TEST_ROOT: root, AILY_SAVE_PROJECT: project,
    AILY_SAVE_OUTPUT: path.join(repo, 'e2e/test-results/save-receipts-20261102', path.basename(root)) })
  await import('./abs-save-consistency.acceptance.mjs')
} finally {
  await api.close()
  for (const [name, hash] of before) assert.equal(digest(await fs.readFile(path.join(seed, name))), hash, 'Never modify the source seed')
  await fs.unlink(path.join(root, 'appdata/.aily')).catch(error => { if (error.code !== 'ENOENT') throw error })
}
