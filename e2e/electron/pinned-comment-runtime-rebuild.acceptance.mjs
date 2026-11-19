import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'

// Real rendered regression for the native document reconstruction boundary.
// Uses copied board/core libraries and self-created comments; no user project,
// credentials, model, hardware or process-wide shutdown participates.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: {
  'host-build': { type: 'string' }, 'agent-root': { type: 'string' }, 'library-root': { type: 'string' },
  'installed-root': { type: 'string' }, 'test-root': { type: 'string' }, output: { type: 'string' },
} })
for (const name of Object.keys(values)) assert.ok(path.isAbsolute(values[name]), `--${name} must be absolute`)
for (const name of ['host-build', 'agent-root', 'library-root', 'installed-root', 'test-root', 'output'])
  assert.ok(values[name], `--${name} is required`)
const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await fs.mkdir(values['test-root'], { recursive: true })
await fs.mkdir(values.output, { recursive: false })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'pinned-rebuild-'))
assert.ok(inside(await fs.realpath(values['test-root']), await fs.realpath(suite)))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata')
const profileRoot = path.join(suite, 'agent-profile'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
for (const dir of [project, appData, profileRoot, home, temp]) await fs.mkdir(dir)
const report = { experimentCompleted: false, covered: false, bugReproduced: false,
  realElectron: true, realSdk: false, llmInvoked: false, credentialsUsed: false, userProjectUsed: false,
  suite, project, startedAt: Date.now(), toolResults: [], stages: [], blockedExternalRequests: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(report, null, 2))
const stage = async name => { report.stages.push({ name, at: Date.now() }); await persist(); console.log('PHASE=' + name) }
const hashes = async () => Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(async name => {
  try { return [name, sha(await fs.readFile(path.join(project, name)))] }
  catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error }
})))
let app, renderer, page, hostPid
try {
  await stage('copy-self-contained-template')
  const board = '@aily-project/board-arduino_uno'
  const boardRoot = path.join(values['installed-root'], 'node_modules', board)
  const manifest = JSON.parse(await fs.readFile(path.join(boardRoot, 'template/package.json'), 'utf8'))
  manifest.name = 'pinned-comment-runtime-rebuild-diagnostic'
  for (const name of Object.keys(manifest.dependencies)) {
    const source = name === board ? boardRoot : path.join(values['library-root'], name.replace('@aily-project/lib-', ''))
    const target = path.join(project, 'node_modules', name)
    await fs.cp(source, target, { recursive: true, dereference: true, force: false, errorOnExist: true })
    manifest.dependencies[name] = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8')).version
  }
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  await fs.copyFile(path.join(boardRoot, 'template/project.abi'), path.join(project, 'project.abi'))
  const config = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
  config.metricsEnabled = false; config.project_path = suite; config.recentlyProjects = []
  config.appdata_path[process.platform] = appData
  config.region = 'pinned-offline'
  config.regions = { 'pinned-offline': { official: false, enabled: true, name: 'Offline diagnostic',
    api_server: 'http://127.0.0.1:9', resource: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9',
    tool_web: 'http://127.0.0.1:9', ucenter_web: 'http://127.0.0.1:9',
    npm_registry: 'http://127.0.0.1:9', npm_registry_linux: 'http://127.0.0.1:9' } }
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx' })
  renderer = await serveRendererBuild(values['host-build'])
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...parentEnv } = process.env
  await stage('owned-cold-host')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    cwd: repo, timeout: 60000, env: { ...parentEnv, AILY_E2E: '1', AILY_APPDATA_PATH: appData,
      AILY_NPM_PREFIX: path.join(appData, 'npm-global'), AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, PI_CODING_AGENT_DIR: profileRoot,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  report.hostPid = hostPid
  await app.context().route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      return route.continue()
    report.blockedExternalRequests.push({ origin: url.origin, path: url.pathname }); return route.abort()
  })
  const windowDeadline = Date.now() + 60000
  while (!page && Date.now() < windowDeadline) {
    page = app.windows().find(win => win.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'The isolated renderer must start')
  page.on('dialog', dialog => dialog.dismiss())
  page.on('pageerror', error => { (report.pageErrors ??= []).push(error.message) })
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  await page.evaluate(async target => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    await service.initializeProjectDataSchema(target)
    if (!await service.projectOpen(target)) throw Error('The self-created project did not open')
  }, project)
  await page.waitForFunction(target => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return component?.projectService.currentProjectPath === target
      && component.projectService.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 120000 })
  await stage('persist-real-closed-comments')
  report.fixture = await page.evaluate(async target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor')), B = window.Blockly
    const w = c.blocklyService.workspace, roots = w.getTopBlocks(false)
    const setup = roots.find(block => block.type === 'arduino_setup'), loop = roots.find(block => block.type === 'arduino_loop')
    if (!setup || !loop) throw Error('The actual UNO template is incomplete')
    setup.setCommentText('Closed comment must survive 原始注释')
    loop.setCommentText('Pinned comment must survive 原始注释')
    await B.renderManagement.finishQueuedRenders()
    const comment = loop.getIcon(B.icons.CommentIcon.TYPE)
    await comment.setBubbleVisible(false)
    await B.renderManagement.finishQueuedRenders()
    const save = await c.projectService.save(target)
    if (!save.success) throw Error(save.error)
    return { state: B.serialization.workspaces.save(w), document: c.blocklyService.getProjectDocument(),
      blockCount: w.getAllBlocks(false).length }
  }, project)
  const comments = state => {
    const result = []
    const visit = value => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) return value.forEach(visit)
      if (value.id && value.type && value.icons?.comment) result.push({ id: value.id, comment: value.icons.comment })
      for (const [key, child] of Object.entries(value)) if (!['fields', 'extraState'].includes(key)) visit(child)
    }
    visit(state); return result.sort((a, b) => a.id.localeCompare(b.id))
  }
  report.closedBefore = comments(report.fixture.state)
  assert.equal(report.closedBefore.filter(item => item.comment.pinned === true).length, 0)
  const rebuild = () => page.evaluate(async target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    const editor = c.blocklyService, native = c._projectService
    if (native.currentProjectPath !== target) throw Error('Refuse a rebuild outside this isolated project')
    const beforeDocument = editor.getProjectAbiForSave(editor.getProjectDocument())
    let failure
    try { await native.rebuildLibraryRuntime({ projectPath: target, packageJson: native.currentPackageData,
      libraryNames: [...editor.loadedLibraryInfos.values()].map(item => item.packageName) }) }
    catch (error) { failure = { code: error.code, message: error.message } }
    const retained = native.runtimeRecovery
    return { failure, beforeDocument, state: window.Blockly.serialization.workspaces.save(editor.workspace),
      retainedSnapshot: retained ? { path: retained.path, document: JSON.parse(retained.documentText),
        bytes: retained.documentText.length } : undefined,
      blocked: editor.isWorkspaceEditBlocked(), ready: editor.generatorRuntime.isReady(),
      activity: { aiWriting: editor.aiWriting, aiWaiting: editor.aiWaiting,
        editInProgress: editor.isWorkspaceEditInProgress(),
        writingSources: [...editor.aiWritingSources], executionSources: [...editor.aiExecutionActiveSources] } }
  }, project)
  await stage('closed-comment-runtime-rebuild-control')
  report.closedRebuild = await rebuild()
  assert.equal(report.closedRebuild.failure, undefined, JSON.stringify(report.closedRebuild.failure))
  assert.equal(report.closedRebuild.ready, true)
  assert.deepEqual(comments(report.closedRebuild.state), report.closedBefore)
  await stage('persist-real-pinned-comment')
  report.fixture = await page.evaluate(async target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor')), B = window.Blockly
    const w = c.blocklyService.workspace, loop = w.getTopBlocks(false).find(block => block.type === 'arduino_loop')
    const comment = loop.getIcon(B.icons.CommentIcon.TYPE)
    await comment.setBubbleVisible(true)
    comment.setBubbleLocation(new B.utils.Coordinate(440, 340))
    await B.renderManagement.finishQueuedRenders()
    const save = await c.projectService.save(target)
    if (!save.success) throw Error(save.error)
    return { state: B.serialization.workspaces.save(w), document: c.blocklyService.getProjectDocument(),
      blockCount: w.getAllBlocks(false).length }
  }, project)
  const expectedComments = comments(report.fixture.state)
  assert.equal(expectedComments.length, 2)
  assert.equal(expectedComments.filter(item => item.comment.pinned === true).length, 1)
  const candidate = '# This isolated retained draft is never applied.\n'
  const candidatePath = path.join(project, 'candidate.abs')
  await fs.writeFile(candidatePath, candidate, { flag: 'wx' })
  await stage('actual-runtime-rebuild')
  report.beforeRebuild = await hashes()
  report.rebuild = await rebuild()
  report.afterRebuild = await hashes()
  assert.deepEqual(report.afterRebuild, report.beforeRebuild, 'Runtime-only reconstruction must retain all published source bytes')
  report.commentsBefore = expectedComments
  report.commentsAfter = comments(report.rebuild.state)
  report.commentsMatch = JSON.stringify(report.commentsBefore) === JSON.stringify(report.commentsAfter)
  if (report.rebuild.failure) {
    assert.match(report.rebuild.failure.message, /comment\/pinned/)
    report.bugReproduced = true; report.covered = false
    const snapshot = report.rebuild.retainedSnapshot
    assert.ok(snapshot && inside(project, snapshot.path), 'The real host must retain its complete pre-rebuild snapshot')
    const savedSnapshot = JSON.parse(await fs.readFile(snapshot.path, 'utf8'))
    assert.deepEqual(snapshot.document, report.rebuild.beforeDocument, 'Retain the complete original document')
    assert.deepEqual(savedSnapshot, snapshot.document, 'The retained document must exist durably on disk')
    report.retainedSnapshot = { sourcePreserved: true, candidateApplied: false,
      snapshotHash: sha(await fs.readFile(snapshot.path)), completeDocumentMatched: true }
  } else {
    assert.equal(report.commentsMatch, true, 'Every explicit comment state must survive the actual reconstruction')
    assert.equal(report.rebuild.ready, true)
    report.covered = true
  }
  assert.equal(report.covered, true, 'The pinned-comment reconstruction must succeed without weakening readback')
  assert.equal(report.rebuild.blocked, false)
  assert.equal(report.rebuild.activity.aiWriting, false)
  assert.equal(report.rebuild.activity.editInProgress, false)
  await stage('persist-explicit-closed-comment-coordinates')
  const closedCoordinates = await page.evaluate(async target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor')), B = window.Blockly
    const icon = c.blocklyService.workspace.getTopBlocks(false)
      .find(block => block.type === 'arduino_loop').getIcon(B.icons.CommentIcon.TYPE)
    await icon.setBubbleVisible(false)
    await B.renderManagement.finishQueuedRenders()
    const saved = await c.projectService.save(target)
    if (!saved.success) throw Error(saved.error)
    return B.serialization.workspaces.save(c.blocklyService.workspace)
  }, project)
  const expectedClosed = comments(closedCoordinates)
  assert.ok(expectedClosed.some(({ comment }) => comment.pinned === false && Number.isFinite(comment.x) && Number.isFinite(comment.y)),
    'The regression must retain explicit coordinates on a closed native comment')
  const beforeClosed = await hashes()
  report.closedCoordinatesRebuild = await rebuild()
  assert.equal(report.closedCoordinatesRebuild.failure, undefined)
  assert.equal(report.closedCoordinatesRebuild.ready, true)
  assert.deepEqual(comments(report.closedCoordinatesRebuild.state), expectedClosed)
  assert.deepEqual(await hashes(), beforeClosed)
  assert.equal(report.closedCoordinatesRebuild.activity.aiWriting, false)
  assert.equal(report.closedCoordinatesRebuild.blocked, false)
  assert.equal(sha(await fs.readFile(candidatePath)), sha(candidate))
  report.candidatePreserved = true
  report.experimentCompleted = true
  await page.screenshot({ path: path.join(values.output, 'final.png'), fullPage: true })
} catch (error) {
  report.error = error.stack ?? String(error); process.exitCode = 1
  console.error(error.message)
  await page?.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  if (app) await app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated host exit')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { (report.cleanupErrors ??= []).push(error.message) })
  await renderer?.close().catch(error => { (report.cleanupErrors ??= []).push(error.message) })
  report.finishedAt = Date.now(); await persist()
  console.log(JSON.stringify({ experimentCompleted: report.experimentCompleted, bugReproduced: report.bugReproduced,
    covered: report.covered, output: values.output }))
}
