import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { runSerialInitializationAcceptance } from './abs-serial-initialization.acceptance.mjs'

const inside = (root, value) => {
  const relative = path.relative(root, value)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
const textOf = message => (message.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')

// Explicit paid online acceptance, never included in automatic unit suites.
// Normal product composition, prompts, skills, tools, permissions and provider.
assert.equal(process.env.AILY_ABS_ONLINE_ENABLED, '1', 'Online acceptance requires explicit opt-in')
const authFile = process.env.AILY_ABS_ONLINE_AUTH_FILE
const libraryRoot = process.env.AILY_ABS_ONLINE_LIBRARIES
const apiBase = process.env.AILY_ABS_ONLINE_API_BASE
assert.ok(authFile && path.isAbsolute(authFile))
assert.ok(libraryRoot && path.isAbsolute(libraryRoot))
assert.ok(apiBase && ['http:', 'https:'].includes(new URL(apiBase).protocol))

await runSerialInitializationAcceptance({
  additionalLocalLibraries: ['pid', 'esp32_freertos'],
  async afterCompile({ project, suite, page, config, call }) {
    // Dependencies are installed only through the real managed Agent tools.
    for (const name of ['pid', 'esp32_freertos']) {
      const source = path.join(suite, name)
      await fs.cp(path.join(libraryRoot, name), source, { recursive: true, force: false, errorOnExist: true })
      await call('lib_install_local', { project, source })
    }
    await call('app_reload', { project })
    await call('abs_export', { project })
    const before = JSON.parse(await page.evaluate(() => JSON.stringify(
      window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
    const originalBlocks = flatten(before), originalModels = before.variables ?? []
    const profile = path.join(suite, 'online-profile')
    await fs.mkdir(profile)
    const auth = JSON.parse(await fs.readFile(authFile, 'utf8'))
    assert.equal(typeof auth.access_token, 'string')
    const privateAuth = path.join(profile, '.aily')
    // No refresh token: this test cannot rotate or rewrite the user's credentials.
    await fs.writeFile(privateAuth, JSON.stringify({ access_token: auth.access_token }))
    for (const name of ['PI_OFFLINE', 'AILY_CHILD_TOOL', 'AILY_CHILD_TOOL_ID']) delete process.env[name]
    Object.assign(process.env, { PI_CODING_AGENT_DIR: profile, AILY_AUTH_FILE: privateAuth, AILY_API_SERVER: apiBase })
    const { createAilyHarness } = await import(pathToFileURL(path.join(config.agent, 'dist/index.js')).href)
    const runtime = createAilyHarness({ agentDir: profile, enableE2E: true })
    const allowed = new Set(['read', 'ls', 'find', 'grep', 'write', 'edit', 'skill',
      'abs_export', 'abs_validate', 'abs_apply', 'project_build', 'library_docs', 'block_info', 'block_list',
      'project_status', 'board_info', 'get_board_config', 'todo', 'app_info', 'app_status'])
    let active, handle, unsubscribe, deadline
    const events = [], failures = []
    const scope = (name, input) => {
      if (name === 'tool_load') return Array.isArray(input.names) && input.names.length > 0
        && input.names.every(value => typeof value === 'string' && allowed.has(value))
      if (name === 'tool_invoke') return typeof input.name === 'string' && allowed.has(input.name)
        && input.arguments && typeof input.arguments === 'object' && scope(input.name, input.arguments)
      if (!allowed.has(name)) return false
      if (typeof input.project === 'string' && !same(input.project, project)) return false
      if (['write', 'edit'].includes(name)) return typeof input.path === 'string'
        && same(path.resolve(project, input.path), path.join(project, 'project.abs'))
      if (['read', 'ls', 'find', 'grep'].includes(name)) return (typeof input.path === 'string' || name !== 'read')
        && [project, config.agent].some(root => inside(root, path.resolve(project, input.path ?? '.')))
      return true
    }
    assert.equal(scope('read', { path: privateAuth }), false, 'Credentials must never enter model-visible file tools')
    const ui = new Proxy({
      select: async (_title, choices) => active && scope(active.name, active.arguments) && choices.includes('Yes') ? 'Yes' : 'No',
      confirm: async () => false, input: async () => undefined, custom: async () => undefined, notify() {},
    }, { get: (target, key) => key in target ? target[key] : () => {} })
    try {
      handle = await runtime.open({ cwd: project, developmentMode: 'blockly', permissionMode: 'default',
        projectTrustOverride: true, model: { provider: 'aily-services', id: 'auto' }, uiContext: ui })
      assert.equal(handle.getState().permissionMode, 'default')
      const agent = handle.raw.agent, beforeTool = agent.beforeToolCall, afterTool = agent.afterToolCall
      assert.equal(typeof beforeTool, 'function')
      agent.beforeToolCall = async (context, signal) => {
        active = context.toolCall
        if (!scope(active.name, active.arguments)) return { block: true, reason: 'This isolated acceptance permits only scoped ABS, read-only discovery and compilation; no upload, other projects, shell, library changes or subagents.' }
        return beforeTool(context, signal)
      }
      agent.afterToolCall = async (context, signal) => {
        try { return await afterTool?.(context, signal) } finally { active = undefined }
      }
      unsubscribe = handle.subscribe(event => {
        if (event.type === 'tool_execution_start') {
          events.push({ type: event.type, name: event.toolName, id: event.toolCallId, at: Date.now() })
          console.log(new Date().toISOString(), 'ONLINE_TOOL', event.toolName)
        }
        if (event.type === 'tool_execution_end') {
          events.push({ type: event.type, name: event.toolName, id: event.toolCallId, isError: event.isError, at: Date.now() })
          if (event.isError) failures.push({ name: event.toolName, result: event.result })
        }
      })
      const startedAt = Date.now()
      deadline = setTimeout(() => void handle.abort({ source: 'timeout', reason: 'isolated_online_acceptance_deadline' }), 12 * 60 * 1000)
      await handle.prompt({ text: `这是已授权的隔离验收工程 ${project}，不是用户原工程。保留已有代码、所有旧块ID、变量模型以及禁用/折叠/保护状态。已安装 PID 和 ESP32 FreeRTOS 库，不必再安装、升级或创建库。请自主读取必要文档和当前 ABS，使用实际 Agent read/edit/write 与 ABS validate/apply 工具，在 arduino_global 增加 PID 初始化：控制器名 acceptancePid，输入 acceptanceInput，输出 acceptanceOutput，目标 acceptanceTarget，Kp=2、Ki=5、Kd=1、方向 DIRECT；用库原生合法语法/模型初始化，不用 variable_define 伪造 typed 模型。再增加一个 FreeRTOS 任务 acceptanceRtosTask，优先级1、栈4096，周期100ms执行PID计算（若该库需要，使用原生任务延时）；在 setup 启动。不要删除或迁移已有任务，不做串口解析或真实控温改造。完成一次应用并调用 project_build 编译。不烧录、不操作串口、不碰其他项目，不用 bash/外部脚本替代ABS工具。最终分别报告编译验收和未进行的硬件/功能验证。`, context: { mode: 'agent' } })
      // The public prompt facade acknowledges enqueueing; settlement is a
      // separate lifecycle boundary, not proof provided by that acknowledgement.
      await handle.waitForIdle()
      const state = handle.getState(), finished = state.messages.filter(message => message.role === 'assistant').at(-1)
      assert.ok(handle.isIdle)
      assert.ok(finished && !['error', 'aborted'].includes(finished.stopReason), 'The actual online turn must finish normally')
      assert.ok(events.some(event => event.type === 'tool_execution_end' && event.name === 'abs_apply' && !event.isError))
      assert.ok(events.some(event => event.type === 'tool_execution_end' && event.name === 'project_build' && !event.isError))
      const result = JSON.parse(await fs.readFile(path.join(project, '.log/compile/latest-result.json'), 'utf8'))
      assert.equal(result.success, true)
      assert.ok(result.finishedAt >= startedAt, 'An old successful build is not evidence')
      const after = JSON.parse(await page.evaluate(() => JSON.stringify(
        window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
      const blocks = flatten(after)
      for (const [id, block] of originalBlocks) assert.deepEqual(blocks.get(id), block, `Preserve old block ${id}`)
      for (const model of originalModels) assert.deepEqual(after.variables.find(value => value.id === model.id), model)
      const code = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')
      assert.match(code, /acceptancePid/)
      assert.match(code, /acceptanceRtosTask/)
      assert.match(code, /Compute\(/)
      const evidence = { ok: true, onlineLlm: true, productionComposition: true, permissionMode: 'default',
        sourceBlocksPreserved: originalBlocks.size, sourceModelsPreserved: originalModels.length,
        model: state.model, sessionId: handle.sessionId, startedAt, completedAt: Date.now(), events, failures,
        finalText: textOf(finished), compiled: true, hardwareTested: false }
      await fs.writeFile(path.join(config.output, 'online-result.json'), JSON.stringify(evidence, null, 2))
      return evidence
    } finally {
      clearTimeout(deadline)
      if (handle) await fs.writeFile(path.join(config.output, 'online-session.json'), JSON.stringify(handle.getState(), null, 2))
      unsubscribe?.()
      if (handle && !handle.isIdle) await handle.abort({ source: 'session_close', reason: 'isolated_acceptance_cleanup' })
      await runtime.closeAll()
      await fs.unlink(privateAuth).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  },
}).catch(error => { console.error(error); process.exitCode = 1 })

function flatten(state) {
  const result = new Map()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    if (typeof value.type === 'string' && typeof value.id === 'string') {
      const { inputs, next, x, y, ...block } = value
      result.set(value.id, block)
    }
    for (const [key, child] of Object.entries(value)) if (!['fields', 'extraState', 'variables'].includes(key)) visit(child)
  }
  visit(state)
  return result
}
