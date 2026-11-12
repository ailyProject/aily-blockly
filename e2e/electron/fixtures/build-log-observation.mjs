import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha = value => createHash('sha256').update(value).digest('hex')
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
const textOf = value => (value?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
}
const stateOf = page => page.evaluate(() => {
  const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
  const builder = editor._builderService
  return { project: editor.projectService.currentProjectPath, attempt: builder.buildAttempt ?? 0,
    requestId: builder.activeBuildRequestId, streamId: builder.streamId,
    completed: builder.buildCompleted, cancelled: builder.cancelled }
})

/** A real host observation disconnect, separate from the 129 model/SSE case.
 * Only the copied private discovery descriptor points to this transparent
 * proxy. Authentication and all command/result bytes come from the host. */
async function observationProxy(descriptor, project) {
  const commands = [], active = new Set()
  let firstResolve, drop, firstRequestId
  const first = new Promise(resolve => { firstResolve = resolve })
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length; assert.ok(bytes <= 1024 * 1024)
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      let value
      if (body.length) value = JSON.parse(body.toString())
      const operation = value?.operation
      const build = value?.action === 'blockly-live-operation'
        && ['project_build', 'project_build_status'].includes(operation)
      if (build) {
        assert.ok(same(value.path, project), 'Only the owned project can pass this observation proxy')
        commands.push({ operation, requestId: value.params?.buildRequest?.requestId, at: Date.now() })
      }
      const selected = build && operation === 'project_build' && !firstRequestId
      if (selected) firstRequestId = value.params.buildRequest.requestId
      // Hold only the original observer response. Never abort the upstream
      // command, even after the downstream is deliberately disconnected.
      const upstream = http.request({ host: '127.0.0.1', port: descriptor.port,
        method: request.method, path: request.url, headers: { ...request.headers, host: `127.0.0.1:${descriptor.port}` } }, reply => {
        if (!selected) response.writeHead(reply.statusCode, reply.headers)
        reply.on('data', chunk => { if (!selected && !response.destroyed) response.write(chunk) })
        reply.once('end', () => { if (!selected && !response.destroyed) response.end() })
        reply.once('error', () => { if (!response.destroyed) response.destroy() })
      })
      active.add(upstream); upstream.once('close', () => active.delete(upstream))
      upstream.once('error', () => { if (!response.destroyed) response.destroy() })
      upstream.end(body)
      if (selected) {
        drop = () => response.destroy()
        firstResolve(firstRequestId)
      }
    })().catch(() => response.destroy())
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { port: server.address().port, first, commands,
    disconnect() { assert.equal(typeof drop, 'function'); drop() },
    async close() {
      // The caller waits for the real terminal receipt before closing.
      for (const request of active) request.destroy()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections(); await closed
    } }
}

/** Direct installed public tool composition, no model call or replacement
 * tool executor. The main UI suite independently proves the real129 roundtrip.
 * Run only after its per-project assertions, as this starts one further build. */
export async function runBuildLogObservation(options) {
  const { page, project, suite, home, appData, installedRoot, output, hostPid } = options
  assert.ok(inside(suite, project) && inside(suite, home) && inside(suite, appData))
  const sourceDescriptor = path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json')
  const initialDescriptor = JSON.parse(await fs.readFile(sourceDescriptor, 'utf8'))
  assert.equal(initialDescriptor.pid, hostPid)
  // Opening a project in the UI does not update the bridge's cached project.
  // Let a real read-only host command establish it before copying discovery.
  const statusResponse = await fetch(`http://127.0.0.1:${initialDescriptor.port}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: initialDescriptor.token, action: 'blockly-live-operation',
      operation: 'project_load_status', path: project }), signal: AbortSignal.timeout(15000)
  })
  assert.equal(statusResponse.status, 200)
  const status = await statusResponse.json()
  assert.ok(status.ok && status.ready && same(status.project, project))
  const descriptorBytes = await fs.readFile(sourceDescriptor)
  const descriptor = JSON.parse(descriptorBytes)
  assert.equal(descriptor.pid, hostPid); assert.ok(Number.isSafeInteger(descriptor.port) && descriptor.port > 0)
  assert.ok(same(descriptor.project, project))
  const before = await stateOf(page)
  assert.ok(same(before.project, project)); assert.ok(!before.requestId && !before.streamId)
  const requestRoot = path.join(project, '.log/compile/requests')
  const existingFiles = await fs.readdir(requestRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const privateRoot = path.join(suite, 'cli-observation-' + randomUUID())
  const privateHome = path.join(privateRoot, 'home'), profile = path.join(privateRoot, 'agent-profile')
  const temp = path.join(privateRoot, 'temp'), data = path.join(privateRoot, 'appdata')
  for (const directory of [privateHome, profile, temp, data]) await fs.mkdir(directory, { recursive: true })
  const config = JSON.parse(await fs.readFile(path.join(appData, 'config.json'), 'utf8'))
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(config), { flag: 'wx' })
  const apiBase = config.regions?.[config.region]?.api_server
  assert.match(apiBase, /^http:\/\/127\.0\.0\.1:\d+$/)
  const authFile = path.join(appData, '.aily')
  const token = JSON.parse(await fs.readFile(authFile, 'utf8')).access_token
  assert.ok(typeof token === 'string' && token.length > 0)
  const redact = value => String(value).replaceAll(token, '[private credential]')
    .replace(/([?&]token=|Bearer\s+)[^\s"'&]+/gi, '$1[private credential]')
  const proxy = await observationProxy(descriptor, project)
  const copiedDescriptor = path.join(privateHome, '.aily-blockly/cli-bridge', hostPid + '.json')
  await fs.mkdir(path.dirname(copiedDescriptor), { recursive: true })
  await fs.writeFile(copiedDescriptor, JSON.stringify({ ...descriptor, port: proxy.port }), { flag: 'wx', mode: 0o600 })
  const settingsFile = path.join(privateRoot, 'settings.json')
  await fs.writeFile(settingsFile, JSON.stringify({ project, installedRoot, profile, hostPid }), { flag: 'wx' })
  const { ELECTRON_RUN_AS_NODE, NODE_PATH, AILY_CHILD_PATH, AILY_CHILD_TOOL, ...env } = process.env
  let child, timer, firstUnknown, failureText = '', final
  try {
    const done = new Promise((resolve, reject) => {
      child = fork(fileURLToPath(import.meta.url), ['--worker', settingsFile], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...env, HOME: privateHome, USERPROFILE: privateHome, AILY_APPDATA_PATH: data,
          PI_CODING_AGENT_DIR: profile, TEMP: temp, TMP: temp, AILY_PORTABLE_ROOT: installedRoot,
          AILY_AUTH_FILE: authFile, AILY_API_SERVER: apiBase }
      })
      const capture = chunk => { failureText = (failureText + redact(chunk)).slice(-16000) }
      child.stdout.on('data', capture); child.stderr.on('data', capture)
      child.on('message', message => {
        if (message.kind === 'unknown') firstUnknown = message.result
        else if (message.kind === 'complete') final = message.result
        else if (message.kind === 'failure') reject(new Error(redact(message.message)))
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 && final ? resolve(final) : reject(new Error(`Installed observation worker failed (${code}): ${failureText}`)))
      timer = setTimeout(() => { child.kill(); reject(new Error('Installed observation worker exceeded its test budget')) }, 180000)
    })
    // Attach a rejection handler while waiting on the independent UI state.
    done.catch(() => {})
    const requestId = await Promise.race([proxy.first, done.then(() => { throw Error('No real build request passed the proxy') })])
    await page.waitForFunction(id => {
      const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
      const builder = editor?._builderService
      return builder?.activeBuildRequestId === id && !!builder.streamId && !builder.buildCompleted
    }, requestId, { timeout: 30000, polling: 20 })
    const running = await stateOf(page)
    assert.equal(running.requestId, requestId); assert.ok(running.streamId && !running.completed)
    proxy.disconnect()
    const result = await done
    assert.equal(firstUnknown?.buildOutcome, 'unknown')
    assert.equal(firstUnknown?.observation?.compilationCancelled, false)
    assert.equal(firstUnknown?.pendingBuild?.arguments?.build_request_id, requestId)
    assert.equal(firstUnknown?.pendingBuild?.arguments?.build_target_pid, hostPid)
    const after = await stateOf(page)
    assert.equal(after.attempt - before.attempt, 1, 'The real compiler admission counter increases exactly once')
    assert.equal(result.build.buildReceipt.requestId, requestId); assert.equal(result.build.targetPid, hostPid)
    assert.equal(result.build.ok, true); assert.equal(result.build.logStatus, 'complete')
    assert.deepEqual(proxy.commands.filter(item => item.operation === 'project_build').map(item => item.requestId), [requestId])
    assert.ok(proxy.commands.filter(item => item.operation === 'project_build_status').length >= 2)
    assert.ok(proxy.commands.every(item => item.requestId === requestId))
    const addedFiles = (await fs.readdir(requestRoot)).filter(name => !existingFiles.includes(name))
    assert.deepEqual(addedFiles, [sha(requestId) + '.log'])
    const currentDescriptorBytes = await fs.readFile(sourceDescriptor)
    const currentDescriptor = JSON.parse(currentDescriptorBytes)
    for (const key of ['pid', 'port', 'token', 'project'])
      assert.equal(currentDescriptor[key], descriptor[key], 'The original host discovery identity is unchanged')
    const proof = { ok: true, onlineModel: false, installedPublicComposition: true,
      replacementToolExecutor: false, fabricatedToolResults: false, fault: 'running-host-observation-http-disconnect',
      hostPid, requestId, running, buildAdmissions: after.attempt - before.attempt,
      firstObservation: firstUnknown, ...result, commands: proxy.commands, newRequestLogs: addedFiles,
      originalDescriptorIdentityUnchanged: true,
      hostRefreshedDescriptorTimestamp: sha(currentDescriptorBytes) !== sha(descriptorBytes) }
    await fs.writeFile(path.join(output, 'cli-observation.json'), JSON.stringify(proof, null, 2))
    return proof
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) child.kill()
    await proxy.close()
    // A copied bridge token is needed only while this fixture is running.
    await fs.unlink(copiedDescriptor).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

async function worker(settingsFile) {
  const { project, installedRoot, profile, hostPid } = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
  const { createAilyHarness } = await import(pathToFileURL(path.join(installedRoot, 'runtime/agent/index.js')).href)
  const harness = createAilyHarness({ agentDir: profile, resourceRoot: path.join(installedRoot, 'runtime/resources'), enableE2E: true })
  try {
    const session = await harness.open({ cwd: project, developmentMode: 'blockly', permissionMode: 'default',
      projectTrustOverride: true, model: { provider: 'aily-services', id: 'auto' } }, { persistImmediately: true })
    const buildTool = session.raw.getToolDefinition('project_build'), readTool = session.raw.getToolDefinition('read')
    assert.equal(typeof buildTool?.execute, 'function'); assert.equal(typeof readTool?.execute, 'function')
    assert.ok(session.raw.sessionManager)
    const context = { cwd: project, sessionManager: session.raw.sessionManager }
    const loader = session.raw.getToolDefinition('tool_load')
    assert.equal(typeof loader?.execute, 'function')
    const loaded = await loader.execute(randomUUID(), { names: ['project_build'] }, new AbortController().signal, undefined, context)
    assert.notEqual(loaded.isError, true)
    const call = async (tool, args) => {
      try {
        const output = await tool.execute(randomUUID(), args, new AbortController().signal, undefined, context)
        return { output, result: output.details?.result ?? JSON.parse(textOf(output)) }
      } catch (error) {
        let result
        try { result = JSON.parse(error.message) } catch { throw error }
        return { toolError: true, result }
      }
    }
    const first = await call(buildTool, { project, clear_cache: true })
    assert.equal(first.result.buildOutcome, 'unknown'); assert.equal(first.result.pendingBuild.resumable, true)
    process.send?.({ kind: 'unknown', result: first.result })
    const resume = first.result.pendingBuild.arguments
    assert.equal(resume.build_target_pid, hostPid)
    const observed = await call(buildTool, resume)
    const build = observed.result
    assert.equal(build.ok, true); assert.equal(build.buildReceipt.state, 'completed')
    const source = await fs.readFile(build.sourceLogFile, 'utf8'), copy = await fs.readFile(build.resultFile, 'utf8')
    assert.equal(copy, source)
    assert.ok(source.startsWith(`Build request: ${resume.build_request_id}\n`))
    const loggedProject = /^Project: (.+)$/m.exec(source)?.[1]
    assert.ok(loggedProject && same(loggedProject, project))
    assert.equal(path.basename(build.sourceLogFile), sha(resume.build_request_id) + '.log')
    const lines = source.split('\n'), range = build.readRange
    assert.equal(build.logLineCount, lines.length)
    assert.deepEqual(range, { offset: Math.max(1, lines.length - 79), limit: Math.min(80, Math.max(1, lines.length)) })
    const expected = lines.slice(range.offset - 1, range.offset - 1 + range.limit).join('\n').replaceAll('\r\n', '\n').trimEnd()
    const read = await readTool.execute(randomUUID(), { path: build.resultFile, ...range }, new AbortController().signal, undefined, context)
    assert.notEqual(read.isError, true); assert.ok(textOf(read).replaceAll('\r\n', '\n').includes(expected))
    const sourceRead = await readTool.execute(randomUUID(), { path: build.sourceLogFile, ...range }, new AbortController().signal, undefined, context)
    assert.notEqual(sourceRead.isError, true); assert.ok(textOf(sourceRead).replaceAll('\r\n', '\n').includes(expected))
    const copyStat = await fs.stat(build.resultFile), repeated = await call(buildTool, resume)
    assert.equal(repeated.result.resultFile, build.resultFile)
    assert.equal(repeated.result.buildReceipt.requestId, build.buildReceipt.requestId)
    assert.equal((await fs.stat(build.resultFile)).mtimeMs, copyStat.mtimeMs)
    assert.equal(sha(await fs.readFile(build.resultFile)), sha(source))
    process.send?.({ kind: 'complete', result: { build, exactResumeArguments: resume,
      logProof: { bytes: Buffer.byteLength(source), sha256: sha(source), lineCount: lines.length,
        readRange: range, actualInstalledRead: true, persistentSourceRead: true,
        immutableRepeatedObservation: true, directPublicTools: ['project_build', 'read'], modelPrompts: 0 } } })
  } finally { await harness.closeAll() }
}

if (process.argv[2] === '--worker') {
  worker(process.argv[3]).catch(error => {
    process.send?.({ kind: 'failure', message: error.message })
    process.exitCode = 1
  }).finally(() => { process.disconnect?.() })
}
