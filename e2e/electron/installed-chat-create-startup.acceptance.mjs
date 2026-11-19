import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'

import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { createOnlineOperationFaultProxy } from '../fixtures/online-operation-fault-proxy.mjs'
import { observeOnlineModelCatalog, explicitOnlineModelId, resolveOnlineModelPreset,
  selectOnlineModelFromUi, assertSelectedOnlineModel } from '../fixtures/online-model-selection.mjs'
import repairEnvironment from '../../electron/project-repair-environment.js'

// Explicit paid, installed-product acceptance. Submission and cancellation use
// the visible iframe; the E2E channel only reads the resulting real session.
// Fault proxies may delay requests or close sockets, never create/replay model
// output or manufacture Services startup/owner evidence.
assert.equal(process.env.AILY_ONLINE_ACCEPTANCE, '1')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const scenario = process.env.AILY_CREATE_UI_SCENARIO ?? 'create-late'
assert.ok(['create-late', 'second-disconnect', 'user-stop'].includes(scenario))
const createForwardAfterMs = Number(process.env.AILY_CREATE_FORWARD_AFTER_MS ?? 27500)
assert.ok(Number.isFinite(createForwardAfterMs) && createForwardAfterMs >= 500 && createForwardAfterMs < 30000)
const sourceAppData = 'C:/Users/LENOVO/AppData/Local/aily-project'
const testRoot = path.join(sourceAppData, 'dev-tests/abs-serial-analysis-20261028')
const daily = path.join(sourceAppData, 'npm-global/app')
const lexRoot = process.env.AILY_ONLINE_LEX_ROOT ?? path.resolve(repo, '../aily-lex-pro')
const hostBuild = process.env.AILY_ONLINE_HOST_BUILD
  ?? path.join(repo, 'tests/test-results/view-conflict-resolution-20261029/host-final/browser')
const outputRoot = path.resolve(process.env.AILY_ONLINE_OUTPUT_ROOT
  ?? path.join(repo, 'e2e/test-results/create-startup-installed-20261103'))
const inside = (root, value) => {
  const relative = path.relative(root, value)
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const sha = value => createHash('sha256').update(value).digest('hex')
const textOf = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('')
assert.ok(inside(path.join(repo, 'e2e/test-results'), outputRoot), 'Use a private E2E output directory')
const connectionFile = process.env.AILY_ONLINE_CONNECTION_PROFILE
assert.ok(connectionFile && path.isAbsolute(connectionFile), 'An explicit test API/token connection profile is required')
const connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'))
assert.ok(connection && typeof connection.apiBase === 'string'
  && path.isAbsolute(connection.authFile ?? '') && path.isAbsolute(connection.configFile ?? ''))
const api = new URL(connection.apiBase)
assert.ok(['http:', 'https:'].includes(api.protocol) && api.pathname === '/'
  && !api.username && !api.password && !api.search && !api.hash)
const dailyAuth = path.join(sourceAppData, '.aily')
assert.ok(!same(connection.authFile, dailyAuth), 'Never use daily account credentials for acceptance')
const suite = await fs.mkdtemp(path.join(testRoot, 'create-startup-ui-'))
const output = path.join(outputRoot, path.basename(suite))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata')
const home = path.join(suite, 'home'), agentProfile = path.join(suite, 'agent-profile'), agentTemp = path.join(suite, 'agent-temp')
const seed = path.join(testRoot, 'archive-user-project/esp32-c3-HANTAI')
const protectedFiles = new Map()
const evidence = { ok: false, scenario, suite, project, realInstalledUi: true,
  submission: 'visible-composer-send', cancellation: 'visible-stop-button',
  onlineLlm: false, syntheticOutput: false, syntheticProof: false,
  sdkTimeoutsOverridden: false, userProjectsModified: false, backendDeployed: false,
  ...(scenario === 'create-late' ? { createForwardAfterMs } : {}),
  coverage: { createLate: false, secondDisconnect: false, userStop: false } }
let app, page, renderer, proxy, loaded, hostPid, snapshot, sessionId, installedRoot, installedEvidence
let verifyPortableBuild, sourceBefore, modelCatalogObserver, selectedModel, userStopAt, accessToken
const phase = value => { evidence.phase = value; console.log(new Date().toISOString(), 'PHASE=' + value) }
async function treeHash(root) {
  const entries = []
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Do not follow a seed project junction')
      if (entry.isDirectory()) await visit(file)
      else { assert.ok(entry.isFile()); entries.push([path.relative(root, file), sha(await fs.readFile(file))]) }
    }
  }
  await visit(root)
  return { files: entries.length, sha256: sha(JSON.stringify(entries)) }
}
const uncovered = reason => Object.assign(new Error(reason), { code: 'SCENARIO_NOT_COVERED' })
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
try {
  await fs.mkdir(output, { recursive: true })
  for (const directory of [project, home, agentProfile, agentTemp]) await fs.mkdir(directory)
  for (const file of new Set([connectionFile, connection.configFile, connection.authFile,
    path.join(sourceAppData, 'config.json'), dailyAuth,
    path.join(daily, 'store/subapp-aily-chat/active.json'), path.join(daily, 'subapp-index.json')])) {
    protectedFiles.set(file, await fs.readFile(file).catch(error => {
      if (same(file, dailyAuth) && error.code === 'ENOENT') return null
      throw error
    }))
  }
  const config = JSON.parse(protectedFiles.get(connection.configFile))
  const auth = JSON.parse(protectedFiles.get(connection.authFile))
  assert.equal(new URL(config.regions?.[config.region]?.api_server).origin, api.origin,
    'Test credentials must stay on their explicit configured API origin')
  assert.ok(typeof auth.access_token === 'string' && auth.access_token.length > 0)
  accessToken = auth.access_token
  const active = JSON.parse(protectedFiles.get(path.join(daily, 'store/subapp-aily-chat/active.json')))
  installedRoot = await fs.realpath(path.join(daily, 'store/subapp-aily-chat', active.selected.path))
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(lexRoot, 'packages/aily-chat/server/portable-integrity.ts'))))
  installedEvidence = await verifyPortableBuild(installedRoot)
  const { captureBuildInputs } = await import(pathToFileURL(path.join(lexRoot, 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
  assert.equal(installedEvidence.inputHash, sha(JSON.stringify(await captureBuildInputs(lexRoot))),
    'Install the current Chat artifact before invoking a paid model')
  evidence.installed = { version: active.selected.version, inputHash: installedEvidence.inputHash, outputHash: installedEvidence.outputHash }
  evidence.upstream = { apiBase: api.origin, configuredRegion: config.region, explicitProfile: true }
  phase('real-api-preflight')
  const me = await fetch(api.origin + '/api/v1/auth/me', {
    headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
  evidence.authStatus = me.status
  await me.body?.cancel()
  assert.equal(me.status, 200)
  sourceBefore = await treeHash(seed)
  for (const name of ['package.json', 'package-lock.json', 'project.abi', 'node_modules'])
    await fs.cp(path.join(seed, name), path.join(project, name), { recursive: true, force: false, errorOnExist: true })
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
  for (const spec of Object.values(manifest.dependencies ?? {})) if (typeof spec === 'string' && spec.startsWith('file:')) {
    const source = path.resolve(seed, spec.slice(5)), target = path.resolve(project, spec.slice(5))
    assert.ok(inside(seed, source) && inside(project, target))
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true })
  }
  if (scenario === 'second-disconnect') {
    proxy = await createOnlineOperationFaultProxy({ upstreamOrigin: api.origin, mode: 'live-disconnect',
      armNow: true, requireResumedThinkingSpan: true, firstDisconnectAfterThinkingMs: 5000 })
  } else {
    const { createStartupFaultProxy } = await import('../fixtures/create-startup-fault-proxy.mjs')
    proxy = await createStartupFaultProxy({ upstreamOrigin: api.origin,
      mode: scenario === 'create-late' ? 'create-startup-late' : 'passive', createForwardAfterMs })
  }
  const profile = await prepareInstalledChatProfile({ appData, installedRoot, apiBase: proxy.origin,
    baseConfigPath: connection.configFile, token: auth.access_token })
  evidence.platformManifests = repairEnvironment.seedPlatformManifests(appData, project, sourceAppData)
  // Pure text tasks need no model-visible filesystem, shell, device or project
  // tools. A denied attempt is still reported; no mutation is authorized here.
  const policy = path.join(agentProfile, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true })
  await fs.writeFile(policy, JSON.stringify({ permission: { '*': 'deny' } }), { flag: 'wx' })
  renderer = await serveRendererBuild(hostBuild)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, ...parentEnv } = process.env
  phase('host-start')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    cwd: repo, timeout: 60000, env: { ...parentEnv, ...profile.env, AILY_E2E: '1', AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentProfile, TEMP: agentTemp, TMP: agentTemp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  const launcherPid = app.process().pid
  const mainIdentity = await app.evaluate(() => ({
    pid: process.pid, ppid: process.ppid, appData: process.env.AILY_APPDATA_PATH
  }))
  assert.ok(Number.isSafeInteger(launcherPid) && launcherPid > 0)
  assert.ok(Number.isSafeInteger(mainIdentity.pid) && mainIdentity.pid > 0)
  assert.ok(typeof mainIdentity.appData === 'string' && same(mainIdentity.appData, appData),
    'Electron main must use this suite\'s isolated appData')
  assert.ok(mainIdentity.pid === launcherPid || process.platform === 'win32' && mainIdentity.ppid === launcherPid,
    'Electron main must be the launched process or its direct Windows shell child')
  hostPid = mainIdentity.pid
  evidence.hostPid = hostPid
  evidence.hostIdentity = { launcherPid, mainPid: hostPid, parentPid: mainIdentity.ppid,
    isolatedAppDataMatched: true, windowsShellLauncher: hostPid !== launcherPid }
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return route.continue()
    if (url.origin !== api.origin || !url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    const headers = { ...request.headers() }
    delete headers.host; delete headers.connection; delete headers['content-length']
    try {
      const result = await fetch(proxy.origin + url.pathname + url.search, { method: request.method(), headers,
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
      await route.fulfill({ status: result.status, headers: Object.fromEntries(result.headers), body: Buffer.from(await result.arrayBuffer()) })
    } catch { await route.abort('connectionfailed') }
  })
  await app.firstWindow()
  const pageDeadline = Date.now() + 60000
  while (!page && Date.now() < pageDeadline) {
    page = app.windows().find(candidate => candidate.url().startsWith(renderer.origin))
    if (!page) await wait(200)
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  if (explicitOnlineModelId(connection.model)) modelCatalogObserver = observeOnlineModelCatalog(page, project)
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await page.waitForFunction(target => {
    const element = document.querySelector('blockly-main'), service = element && window.ng?.getComponent(element)?.projectService
    return service?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
      && service.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 60000 })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-blockly-editor'))?._builderService?.isInstallInProgress() === false,
    undefined, { timeout: 60000 })
  loaded = await assertInstalledChatLoaded(page, { installedRoot, expectedApiBase: proxy.origin,
    expectedInputHash: installedEvidence.inputHash, expectedOutputHash: installedEvidence.outputHash })
  evidence.chat = { ...loaded.evidence, syntheticIdentity: false }
  delete evidence.chat.buildEvidence
  if (explicitOnlineModelId(connection.model)) {
    const response = await fetch(proxy.origin + '/api/v2/model_catalog', {
      headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200)
    selectedModel = resolveOnlineModelPreset(await response.json(), connection.model)
    evidence.modelCatalog = await modelCatalogObserver.waitUntilReady(selectedModel, { deadline: Date.now() + 60000 })
    evidence.selectedModel = await selectOnlineModelFromUi(loaded.frame, selectedModel)
  }
  phase('visible-composer-send')
  const marker = 'CREATE_UI_' + randomUUID().slice(0, 8)
  const fullReview = `这是当前隔离 ESP32-C3 Blockly 工程中 MAX6675 测温与加热 PID 控制的纯文本固件设计评审。下面贴出的 C++ 伪代码和假设就是本轮完整输入；它是待评审草案，不声称磁盘工程已经如此。请只分析这份输入，不读取文件、不调用任何工具、不查询网络、不修改工程、不编译、不烧录、不操作设备。直接给出评审和修订草案，不要求我补充其他信息。

已知假设：millis() 返回 uint32_t，按 2^32 毫秒回绕；所有正常设计间隔小于 2^31 毫秒。MAX6675 每次读取耗时 2ms，相邻有效新测量至少间隔 250ms，断路时返回 NaN；它不是每次调用都能生成新的测量。PID 计算耗时 1ms。Serial.readStringUntil 在没有换行时会阻塞至 1000ms 超时，println 在缓冲区满时可能阻塞 12ms。循环中的 delay(250) 会真实阻塞。看门狗期限为 2000ms，喂狗仅重置计时，不证明温控逻辑正确。加热 PWM 范围 0..255，复位后的硬件默认输出为关闭；工程要求检测到无效温度或过温后立即输出关闭并锁存故障，只有温度恢复安全且有明确人工确认才允许复位。希望正常温度控制周期为 50ms、采样周期为 250ms、报告周期为 1000ms；对于物理温度变化到执行关闭希望不超过 500ms，但你必须判断这些假设是否足以保证它，不能把目标当成已经证明的事实。伪代码中宽松 toDouble 非法文本会变成 0，超范围输入可能成为 Inf；不要假设 constrain 能把 NaN 可靠地变成安全输出。

待评审草案如下（辅助函数仅按上述假设理解）：
uint32_t lastSensor = 0, lastPid = 0, nextReport = 1000;
double input = 25, target = 180, integral = 0, lastError = 0;
bool fault = false;
int pwm = 0;
void setup() {
  Serial.begin(115200);
  initThermocouple();
  initHeaterPwm();
  setHeaterPwm(0);
}
void loop() {
  uint32_t now = millis();
  if (now >= lastSensor + uint32_t(250)) {
    lastSensor = now;
    input = readCelsius();
  }
  if (uint32_t(now - lastPid) >= 50) {
    double dt = double(uint32_t(now - lastPid)) / 1000.0;
    lastPid = now;
    double error = target - input;
    integral += error * dt;
    double derivative = (error - lastError) / dt;
    lastError = error;
    pwm = int(constrain(2.0 * error + 0.5 * integral + 0.1 * derivative, 0.0, 255.0));
  }
  setHeaterPwm(pwm);
  if (isnan(input) || input >= 200) {
    fault = true;
    pwm = 0;
  }
  if (now >= nextReport) {
    nextReport += 1000;
    Serial.println(input);
  }
  if (Serial.available()) target = Serial.readStringUntil('\\n').toDouble();
  feedWatchdog();
  delay(250);
}

请依次完成以下评审，给出计算过程和明确结论，不把静态推理写成实际硬件测试结果：
1. 解释启动基准、采样、控制、报告各自的时间语义。假设 setup 结束时 millis=2500，首次传感读取得到 170°C，按代码算出第一轮的 dt、error、integral、derivative 和截断前后 PWM，指出把启动耗时算进积分的问题。50ms 控制目标在现有 loop 中能否实现？重复使用旧测量与获得新测量有什么区别？
2. 手算回绕反例：进入一轮时 lastSensor=0xFFFFFF80、lastPid=0xFFFFFFC0、nextReport=0xFFFFFFF0，分别对 now=0xFFFFFFD0、0xFFFFFFF8、0x00000020、0x00000090 判定三个 if 是否进入。先把每个 now 当作相同初始状态下的独立快照，再解释真正连续执行时 lastSensor/lastPid/nextReport 更新会如何改变后续结果。明确区分 unsigned 差值法、绝对截止值比较，以及采用有符号差值时所需的范围前提。
3. 给出串口有字节却始终无换行时至少三轮的最坏时间线，计入读取、PID、日志、超时和 delay；指出欠采样、报告追赶和长期相位漂移的区别。解释“每轮仅补做一次”和“while 补齐所有漏掉周期”对温控、陈旧传感数据及看门狗各有什么风险，不要对所有任务套同一种调度策略。
4. 分析 NaN、断路、传感器重复旧值、过温和设定值 NaN/Inf/越界这几类输入；逐句追踪当前 setHeaterPwm 与 fault 的先后关系。说明为什么设置 fault=true 或本地 pwm=0 不能保证输出已经关闭，也不能保证下一轮保持关闭；列出安全检查与硬件写入的必要顺序。
5. 假设输出连续饱和 10 秒，随后 target 从 180 降到 60 而 input 仍为 170，分析积分饱和、微分冲击与 dt 不稳定。提出一种明确的抗积分饱和方法，说明允许积分和禁止积分的条件、故障/恢复时如何处理积分与微分历史，以及微分对误差还是对测量更合适。不要仅给“限制积分”四个字。
6. 分别讨论一次 1800ms 和 2200ms 的循环停顿。判断看门狗能证明什么、不能证明什么，喂狗应放在哪里，复位后是否应自动重启加热。结合 250ms 传感刷新、2ms 读耗时、调度抖动与串口阻塞，给出 500ms 物理过温关闭目标的延迟预算；若无法保证，明确需要额外的硬件或调度条件，不虚构测量精度和保护能力。
7. 给出一份连贯、能对应到 Blockly/ABS 实现思路的 C++ 修订草案：初始化有效时间基准；无 delay/阻塞读行；有界串口缓冲和严格数值范围检查；采样与 PID/报告各自调度；只把新鲜且有效的温度作为输入；最高优先级关闭并锁存故障；人工确认的安全恢复；合适的 dt 与抗积分饱和；避免日志阻塞破坏保护。可用明确命名的硬件抽象函数，但不要遗漏状态变量和失败分支。说明哪些语义可以直接映射为积木，哪些应由现有库或小型 C++ 封装实现；不要在本轮执行修改。
8. 最后给出验证表，至少覆盖启动、uint32 回绕、无换行串口洪泛、NaN/断路、过温、旧温度、输出饱和后降设定值、报告积压、看门狗复位与人工确认，每行写明输入/时序、期望输出、可静态确认的部分及仍需硬件验证的部分。

请完成上述当前固件领域评审后，在最终答复末尾原样输出本轮标记 ${marker}。`
  const shortReview = `请对当前隔离 ESP32-C3 Blockly 温控工程的以下草案做一次小型纯文本代码评审。输入已完整贴出；不读取文件、不调用工具、不修改工程、不编译、不烧录、不操作设备。直接回答，文字控制在900个汉字内，修订代码不超过25行；不要求形式化证明或完整控制器设计。
uint32_t last = 0;
bool fault = false;
void loop() {
  uint32_t now = millis();
  if (now >= last + 250) {
    last = now;
    float t = thermocouple.readCelsius();
    if (t > 80) fault = true;
    if (!fault) setHeat(pidCompute(t));
  }
  if (Serial.available()) {
    String command = Serial.readStringUntil('\\n');
    if (command == "reset") fault = false;
  }
}
已知：uint32_t millis按2^32回绕；MAX6675断路时返回NaN；读取温度与计算PID总共至多3ms；setHeat更新0..255的实际PWM，若不再调用就保持上次输出；串口读行可能阻塞1000ms。这里只讨论输入程序的四个缺陷，不扩展其他功能。
请分别用一个具体输入或时间值说明：1）last=0xFFFFFFF0时加法截止时间比较为何不可靠；2）之前PWM=200然后温度NaN时，为什么必须显式关热并锁存；3）串口迟迟无换行时，保护响应会怎样；4）过温仍未恢复时收到reset为什么不能直接清故障。给出短修订片段，可用已经实现的nonblockingResetRequested()和resetPidState()抽象函数，不实现串口解析器或PID。修订需使用无符号时间差、显式NaN/过温关闭、安全条件下人工复位；最后用四行表核对上述反例。
答案最后单独一行输出 ${marker}。`
  const problem = scenario === 'create-late' ? shortReview : fullReview
  evidence.promptKind = scenario === 'create-late' ? 'bounded-firmware-review' : 'extended-firmware-review'
  evidence.startedAt = Date.now()
  await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(problem)
  await loaded.frame.locator('button.primary-action.send-action').click()
  const deadline = Date.now() + 12 * 60 * 1000
  let nextProgressAt = 0
  while (Date.now() < deadline) {
    for (const dialog of await loaded.frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
      const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
      assert.equal(lines[0], 'Trust project folder?')
      assert.ok(same(lines[1], project))
      await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
    }
    const sessions = await loaded.e2e('session.list')
    const candidates = sessions.sessions.filter(value => same(value.cwd, project))
    assert.ok(candidates.length <= 1)
    sessionId ??= candidates[0]?.sessionId
    if (sessionId) {
      snapshot = (await loaded.e2e('session.read', { sessionId })).session
      assertSelectedOnlineModel(snapshot, selectedModel)
      const transport = proxy.snapshot()
      if (scenario === 'user-stop' && !userStopAt && !snapshot.isIdle && snapshot.isStreaming
        && transport.operations.some(operation => operation.semanticEvents > 0 && !operation.terminal)) {
        const running = transport.operations.filter(operation => operation.semanticEvents > 0 && !operation.terminal).at(-1)
        const response = await fetch(`${proxy.origin}/api/v3/interactions/${transport.interactionId}/operations/${running.step}/state`, {
          headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
        assert.equal(response.status, 200)
        const state = await response.json()
        if (state.status === 'running' && state.streamState === 'open') {
          const stop = loaded.frame.locator('button.primary-action.stop-action')
          await stop.waitFor({ state: 'visible', timeout: 3000 })
          await stop.click()
          userStopAt = Date.now()
          evidence.stop = { clickedAt: userStopAt, operationId: running.operationId,
            canonicalStatusBeforeClick: state.status, canonicalStreamStateBeforeClick: state.streamState }
          phase('visible-stop-clicked')
        }
      }
      const final = snapshot.messages.filter(value => value.role === 'assistant').at(-1)
      if (snapshot.isIdle && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(final?.stopReason)) {
        evidence.final = { stopReason: final.stopReason, textHash: sha(textOf(final)),
          textBytes: Buffer.byteLength(textOf(final)), markerPresent: textOf(final).includes(marker), errorMessage: final.errorMessage }
        break
      }
    }
    if (Date.now() >= nextProgressAt) {
      nextProgressAt = Date.now() + 5000
      await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ phase: evidence.phase, sessionId,
        transport: proxy.snapshot(), streaming: snapshot?.isStreaming, idle: snapshot?.isIdle }, null, 2))
    }
    await wait(300)
  }
  evidence.transport = proxy.snapshot()
  assert.ok(snapshot && evidence.final, 'The actual installed turn must settle before the acceptance deadline')
  assert.equal(snapshot.messages.filter(value => value.role === 'user').length, 1)
  assert.equal(snapshot.messages.filter(value => value.role === 'toolResult').length, 0, 'Pure-text acceptance must execute no tools')
  assert.equal(evidence.transport.syntheticOutput, false)
  assert.equal(evidence.transport.failures.length, 0)
  if (scenario === 'user-stop') {
    if (!userStopAt) throw uncovered('The model completed before a real running stream could be stopped from the UI')
    assert.equal(evidence.final.stopReason, 'aborted')
    assert.equal(evidence.transport.interruptCount, 1)
    assert.equal(evidence.transport.createCount, 1)
    evidence.coverage.userStop = true
  } else {
    assert.equal(evidence.final.stopReason, 'stop', 'The original online operation must complete normally')
    assert.equal(evidence.final.markerPresent, true)
    assert.equal(evidence.transport.interruptCount, 0)
    if (scenario === 'second-disconnect') {
      if (!evidence.transport.strictThinkingCovered)
        throw uncovered('The real resumed model did not produce fresh thinking spanning more than 32 seconds; two-break coverage is incomplete')
      assert.equal(evidence.transport.faults.length, 2)
      assert.ok(evidence.transport.faults[1].resumedThinkingDurationMs > 32000)
      evidence.coverage.secondDisconnect = true
    } else {
      const transport = evidence.transport, boundary = transport.firstFaultAt + 30000
      assert.equal(transport.createCount, 2)
      assert.equal(transport.createForwarded, 2)
      assert.equal(transport.createDropped, 1)
      assert.equal(transport.createRetryForwarded, 1)
      for (const key of ['bodySha256', 'startupIdSha256', 'threadIdSha256', 'idempotencyKeySha256'])
        assert.match(transport[key], /^[a-f0-9]{64}$/)
      assert.ok(Number.isFinite(transport.firstFaultAt))
      assert.ok(transport.originalForwardedAt >= transport.firstFaultAt + createForwardAfterMs - 100)
      assert.ok(transport.originalAcceptedAt >= transport.originalForwardedAt)
      assert.ok(transport.retryForwardedAt >= transport.originalAcceptedAt,
        'The same bytes may replay only after the original real upstream acceptance')
      assert.ok(transport.turnBeginAt >= transport.originalAcceptedAt && transport.turnBeginAt < boundary)
      assert.ok(transport.startupProofs.count >= 1 && transport.startupProofs.valid === true)
      assert.ok(transport.startupProofs.firstValidAt >= transport.turnBeginAt
        && transport.startupProofs.firstValidAt < boundary, 'A fresh actual receipt must arrive inside the original budget')
      if (!(transport.firstSemanticAt > boundary))
        throw uncovered('Actual upstream first output did not cross the original 30-second recovery boundary; no model events may be delayed to manufacture coverage')
      evidence.createStartupTiming = { originalBudgetMs: 30000,
        acceptedAfterFaultMs: transport.originalAcceptedAt - transport.firstFaultAt,
        proofAfterFaultMs: transport.startupProofs.firstValidAt - transport.firstFaultAt,
        firstSemanticAfterFaultMs: transport.firstSemanticAt - transport.firstFaultAt }
      evidence.coverage.createLate = true
    }
  }
  const lastOperation = evidence.transport.operations.toSorted((a, b) => a.step - b.step).at(-1)
  assert.ok(lastOperation)
  assert.equal(evidence.transport.operations.length, 1, 'One original operation owns this pure-text turn')
  const canonicalBase = `${proxy.origin}/api/v3/interactions/${evidence.transport.interactionId}/operations/${lastOperation.step}`
  const response = await fetch(canonicalBase + '/state', {
    headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200)
  const state = await response.json()
  assert.equal(state.status, scenario === 'user-stop' ? 'interrupted' : 'completed')
  evidence.canonical = { operationId: state.operationId, status: state.status, streamState: state.streamState }
  if (scenario !== 'user-stop') {
    const resultResponse = await fetch(canonicalBase + '/result', {
      headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
    assert.equal(resultResponse.status, 200)
    const result = await resultResponse.json()
    const finalText = textOf(snapshot.messages.filter(value => value.role === 'assistant').at(-1))
    assert.equal(result.status, 'completed')
    assert.equal(result.operationId, lastOperation.operationId)
    assert.equal(result.text, finalText)
    assert.equal(result.hash, 'sha256:' + sha(finalText))
    evidence.canonical.answerHash = result.hash
    evidence.canonical.sdkTextMatches = true
  }
  evidence.completedAt = Date.now()
  evidence.ok = true
  phase('complete')
} catch (error) {
  evidence.failure = { code: error.code, name: error.name, message: error.message,
    stack: String(error.stack).split('\n').slice(0, 6).join('\n') }
  if (error.catalogReadiness) evidence.modelCatalog = error.catalogReadiness
  console.error('ACCEPTANCE_FAILED', error.message)
  process.exitCode = 1
} finally {
  modelCatalogObserver?.close()
  const finish = async (label, action) => {
    try { await action() } catch (error) {
      evidence.cleanupFailures ??= []
      evidence.cleanupFailures.push({ label, message: error.message })
      evidence.ok = false
      process.exitCode = 1
    }
  }
  if (page) await page.screenshot({ path: path.join(output, 'final.png'), fullPage: true }).catch(() => {})
  if (loaded && (!snapshot || !snapshot.isIdle)) await finish('stop-owned-session', async () => {
    const stop = loaded.frame.locator('button.primary-action.stop-action')
    if (await stop.isVisible()) {
      await stop.click({ timeout: 3000 })
      evidence.cleanupStopRequested = true
    }
    const deadline = Date.now() + 15000
    const readWithinDeadline = async (method, fields) => {
      let timer
      try {
        return await Promise.race([loaded.e2e(method, fields), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned cleanup observation exceeded its original deadline')),
            Math.max(1, deadline - Date.now()))
        })])
      } finally { clearTimeout(timer) }
    }
    let canonicalStatus
    while (Date.now() < deadline) {
      if (!sessionId) {
        const sessions = await readWithinDeadline('session.list')
        const candidates = sessions.sessions.filter(value => same(value.cwd, project))
        assert.ok(candidates.length <= 1)
        sessionId = candidates[0]?.sessionId
      }
      if (sessionId) snapshot = (await readWithinDeadline('session.read', { sessionId })).session
      const transport = proxy.snapshot()
      const operation = transport.operations.toSorted((a, b) => a.step - b.step).at(-1)
      if (operation && accessToken) {
        const response = await fetch(`${proxy.origin}/api/v3/interactions/${transport.interactionId}/operations/${operation.step}/state`, {
          headers: { authorization: 'Bearer ' + accessToken },
          signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) })
        if (response.ok) canonicalStatus = (await response.json()).status
        else await response.body?.cancel()
      }
      if (snapshot?.isIdle && !snapshot.isStreaming && (!operation || canonicalStatus && canonicalStatus !== 'running')) {
        evidence.cleanupSettlement = { idle: true, streaming: false, canonicalStatus: canonicalStatus ?? 'not-started' }
        return
      }
      await wait(200)
    }
    throw new Error('Owned UI Stop did not settle its original session and canonical operation within 15 seconds')
  })
  evidence.transport = proxy?.snapshot()
  evidence.onlineLlm = evidence.transport?.operations.some(operation => operation.semanticEvents > 0 || operation.toolCalls.length > 0) ?? false
  if (evidence.chat) evidence.chat.realModelInvoked = evidence.onlineLlm
  if (app) await finish('close-owned-host', () => app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw new Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData }))
  await finish('close-owned-renderer', () => renderer?.close())
  await finish('close-owned-proxy', () => proxy?.close())
  await finish('remove-private-access-token', () => fs.unlink(path.join(appData, '.aily')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  }))
  await finish('preserve-inputs', async () => {
    if (sourceBefore) assert.deepEqual(await treeHash(seed), sourceBefore)
    for (const [file, original] of protectedFiles) {
      if (original === null) await assert.rejects(fs.readFile(file), { code: 'ENOENT' })
      else assert.equal(sha(await fs.readFile(file)), sha(original), 'Protected input changed: ' + path.basename(file))
    }
    if (installedEvidence) {
      const current = await verifyPortableBuild(installedRoot)
      assert.equal(current.inputHash, installedEvidence.inputHash)
      assert.equal(current.outputHash, installedEvidence.outputHash)
    }
    evidence.sourceAndDailyConfigurationUnchanged = true
  })
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, scenario, phase: evidence.phase,
    failure: evidence.failure?.message, coverage: evidence.coverage, output, suite }))
}
