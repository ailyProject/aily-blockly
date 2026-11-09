import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapPrompt, bootstrapPromptSha256, selectBootstrapAnswer, inspectBootstrapSession,
  inspectWeatherGeneratedSource, bootstrapSessionProjectBinding, bootstrapUserStopOutcome,
  bootstrapDeferredCall, bootstrapCalls, bootstrapOriginalAutoSelection, bootstrapResourceAssessment,
  readBootstrapTerminalUi } from './bootstrap-natural.mjs'
import { explicitOnlineModelId } from '../../fixtures/online-model-selection.mjs'
import { summarizeOnlineComparison } from './online-comparison.mjs'

test('terminal UI observation captures actual Native and notices without applying an acceptance gate', () => {
  const previous = { document: globalThis.document, window: globalThis.window }
  let captures = 0
  const components = new Map([
    ['app-blockly-editor', { projectService: { currentProjectPath: 'fixture-project' }, blocklyService: {
      captureRecoverySnapshot: () => { captures++; return { documentText: '{"pages":[]}' } },
      isWorkspaceEditInProgress: () => false, isWorkspaceEditBlocked: () => false, isWorkspaceRecoveryRequired: () => false } }],
    ['app-child-tool-host', { aiOperationProtocol: { hasRunning: false } }],
    ['app-header', { projectService: { projectLifecycle: { owners: new Map() } } }]
  ])
  try {
    globalThis.document = { querySelector: selector => components.has(selector) ? selector : null,
      querySelectorAll: () => [{ textContent: 'AI正在操作' }] }
    globalThis.window = { ng: { getComponent: element => { assert.notEqual(element, null); return components.get(element) } } }
    const observed = readBootstrapTerminalUi()
    assert.equal(captures, 1); assert.equal(observed.documentText, '{"pages":[]}')
    assert.equal(observed.finalHost.aiNoticeCount, 1, 'Retain the actual nonzero state for later strict rejection')
    assert.equal(observed.finalHost.lifecycleOwners, 0)
    components.clear()
    assert.equal(readBootstrapTerminalUi().documentText, null, 'Absent editor remains unknown, never fabricated empty Native')
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window
  }
})

test('explicit Windows functional resource profile requires both real capacity metrics', () => {
  const sample = { platform: 'win32', freeBytes: 512 * 1024 ** 2,
    windowsMemory: { availablePhysicalBytes: 512 * 1024 ** 2, commitLimitBytes: 16 * 1024 ** 3, committedBytes: 10 * 1024 ** 3 } }
  const assess = value => bootstrapResourceAssessment('windows-functional', value)
  assert.equal(assess(sample).passed, true); assert.equal(assess(sample).performanceComparisonEligible, false)
  assert.equal(assess({ ...sample, windowsMemory: { ...sample.windowsMemory, availablePhysicalBytes: 255 * 1024 ** 2 } }).passed, false)
  assert.equal(assess({ ...sample, windowsMemory: { ...sample.windowsMemory, committedBytes: 13 * 1024 ** 3 } }).passed, false)
  assert.equal(assess({ ...sample, windowsMemory: undefined }).passed, false)
  assert.equal(assess({ ...sample, windowsMemory: { ...sample.windowsMemory, commitLimitBytes: 'unknown' } }).passed, false)
  assert.equal(assess({ ...sample, windowsMemory: { ...sample.windowsMemory, committedBytes: -1 } }).passed, false)
  assert.equal(assess({ ...sample, platform: 'linux' }).passed, false)
  assert.equal(bootstrapResourceAssessment('physical-1gib', sample).passed, false)
  assert.equal(bootstrapResourceAssessment('physical-1gib', { freeBytes: 1024 ** 3 }).passed, true)
})

test('original Auto UI selection stays separate from its effective response route', () => {
  assert.deepEqual(bootstrapOriginalAutoSelection({ data: {} }), { id: 'auto', provider: 'aily-services', label: 'Auto' })
  assert.equal(bootstrapOriginalAutoSelection({ data: { model_presets: { auto: { display_name: 'Default' } },
    user_visible_model_presets: { auto: { display_name: 'Automatic' } } } }).label, 'Automatic')
  assert.equal(bootstrapOriginalAutoSelection({ data: { picker_control_model_presets: { auto: { label: 'Automatic' } } } }).label, 'Automatic')
  assert.equal(explicitOnlineModelId('auto'), undefined, 'Keep shared normal Auto behavior unchanged')
  const snapshot = { model: { provider: 'aily-services', id: 'auto' }, messages: [{ role: 'assistant',
    responseModel: 'glm-5.3', responsePresetId: 'auto-max', usage: { input: 1 }, content: [] }] }
  const options = { expectedModel: 'glm-5.3', expectedPreset: 'auto-max' }
  assert.equal(summarizeOnlineComparison(snapshot, options).modelEvidenceValid, true)
  snapshot.messages[0].responsePresetId = 'auto-fast'
  assert.equal(summarizeOnlineComparison(snapshot, options).modelEvidenceValid, false, 'A changed Auto route is ineligible, never silently replaced')
})

const answers = [
  { question: 'HTTP POST 要发送到哪个服务器？请填写完整 URL', answer: '示例：http://example.invalid/weather' },
  { question: '使用哪个天气数据源获取成都天气？', answer: 'Open-Meteo（推荐）' },
  { question: '上报到服务器时使用什么请求体格式？', answer: 'JSON（推荐）' },
]

test('original natural request stays byte exact and contains no tool choreography', () => {
  assert.equal(bootstrapPrompt, '帮我写一个arduino uno R4 wifi获取成都天气数据，然后通过HTTP POST传输到指定服务器的程序\n\n新建项目，不得参考现有项目')
  assert.match(bootstrapPromptSha256, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(bootstrapPrompt, /project_create|skill|abs_apply/)
})

test('only original three answers can be selected, without inventing recovery permission', () => {
  assert.equal(selectBootstrapAnswer('选择天气 API 数据源', ['Open-Meteo（免费）', '其它'], answers).option, 'Open-Meteo（免费）')
  assert.equal(selectBootstrapAnswer('HTTP POST 的目标服务器地址？', ['自定义', '暂不填写'], answers).freeText, 'http://example.invalid/weather')
  assert.equal(selectBootstrapAnswer('上报数据格式？', ['JSON', '文本'], answers).option, 'JSON')
  assert.throws(() => selectBootstrapAnswer('是否删除现有项目再重建？', ['删除', '保留'], answers))
  assert.equal(selectBootstrapAnswer('WiFi SSID 是什么？', [], answers).freeText, 'E2E_BOOTSTRAP_WIFI')
  assert.equal(selectBootstrapAnswer('WiFi密码是什么？', [], answers).answerOrigin, 'synthetic-hardware-fixture')
  assert.equal(selectBootstrapAnswer('天气上报间隔？', ['60秒', '5分钟'], answers).option, '60秒')
})

test('rejected create and loaded build are never counted as completed business work', () => {
  const snapshot = { messages: [
    { role: 'user', content: [{ type: 'text', text: bootstrapPrompt }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'project_create', arguments: {} },
      { type: 'toolCall', id: 'b', name: 'tool_load', arguments: { names: ['project_build'] } }] },
    { role: 'toolResult', toolCallId: 'a', isError: true, content: [{ type: 'text', text: JSON.stringify({
      ok: false, code: 'ABS_WORKING_CANDIDATE_UNSUPPORTED', commandDispatched: false }) }] },
    { role: 'assistant', content: [{ type: 'text', text: '请你手动新建项目，建好后告诉我。' }] },
  ] }
  const facts = inspectBootstrapSession(snapshot)
  assert.equal(facts.creates.length, 1); assert.equal(facts.successfulCreates.length, 0)
  assert.equal(facts.builds.length, 0); assert.equal(facts.completedBuilds.length, 0)
  assert.equal(facts.manualLifecycleHandoff, true)
})

test('generated-source inspection checks task semantics without claiming hardware networking', () => {
  const facts = inspectWeatherGeneratedSource('WiFiS3; client.get("http://api.open-meteo.com/v1/forecast?latitude=30.67&longitude=104.06", callback); client.postJson("http://example.invalid", body, callback); JsonDocument;')
  assert.ok(Object.values(facts).every(Boolean))
  assert.equal(inspectWeatherGeneratedSource('void setup() {}').openMeteoEndpoint, false)
})

test('weather coordinates must resolve in one actual GET URL, including finite String and const expressions', () => {
  const common = '#include <WiFiS3.h>\n#include <ArduinoJson.h>\n'
  const post = '\nclient.postJson("http://example.invalid/weather", body, callback);'
  for (const get of [
    'client.get("http://api.open-meteo.com/v1/forecast?latitude=30.57&longitude=104.06", callback);',
    'client.get(String("http://api.open-meteo.com/v1/forecast?latitude=") + String(30.57) + String("&longitude=") + String(104.06), callback);',
    'const float lat=30.57; const float lon=104.06; const String url=String("http://api.open-meteo.com/v1/forecast?latitude=") + String(lat) + "&longitude=" + String(lon); client.get(url, callback);',
  ]) assert.ok(Object.values(inspectWeatherGeneratedSource(common + get + post)).every(Boolean), get)
  for (const get of [
    '// client.get("http://api.open-meteo.com/v1/forecast?latitude=30.57&longitude=104.06", callback);',
    'const float lat=30.57; const float lon=104.06; client.get("http://example.invalid", callback);',
    'client.get(String("http://api.open-meteo.com/v1/forecast?latitude=") + String(unknownLat) + "&longitude=104.06", callback);',
    'client.get("http://api.open-meteo.com/v1/forecast?latitude=30.57", callback); client.get("http://api.open-meteo.com/v1/forecast?longitude=104.06", callback);',
    'const float lat=30.57; lat=20; client.get(String("http://api.open-meteo.com/v1/forecast?latitude=") + String(lat) + "&longitude=104.06", callback);',
    'const String unused="http://api.open-meteo.com/v1/forecast?latitude=30.57&longitude=104.06"; client.get(dynamicUrl, callback);',
  ]) assert.equal(inspectWeatherGeneratedSource(common + get + post).chengduLatitude, false, get)
  assert.equal(inspectWeatherGeneratedSource(common + 'client.get("http://api.open-meteo.com/v1/forecast?latitude=30.57&longitude=104.06", callback); const char *unrelated="POST";').postOperation, false)
})

test('late Host success alone does not establish the original session project binding', () => {
  const project = '/owned/new-project', stale = { sessionId: 'original', cwd: '/owned/empty', entries: [] }
  assert.equal(bootstrapSessionProjectBinding(stale, project).bound, false)
  assert.equal(bootstrapSessionProjectBinding({ ...stale, cwd: project }, project).bound, true)
  assert.equal(bootstrapSessionProjectBinding({ ...stale, projectAssociation: {
    workspaceId: 'owned-workspace', root: stale.cwd, projects: [stale.cwd, project] } }, project).bound, true)
})

test('normal user Stop requires the original durable intent and rejects unrelated error outcomes', () => {
  const snapshot = { sessionId: 'original-session', messages: [{ role: 'assistant', stopReason: 'aborted',
    errorMessage: 'Request aborted (user: user_stop)' }], entries: [{ type: 'custom', customType: 'aily.abort-request',
    data: { version: 1, sessionId: 'original-session', source: 'user', reason: 'user_stop', requestedAt: 101 } }] }
  assert.equal(bootstrapUserStopOutcome(snapshot, 100).normalUserStop, true)
  assert.equal(bootstrapUserStopOutcome({ ...snapshot, entries: [] }, 100).normalUserStop, false)
  assert.equal(bootstrapUserStopOutcome({ ...snapshot, sessionId: 'different-session' }, 100).normalUserStop, false)
  assert.equal(bootstrapUserStopOutcome(snapshot, 102).normalUserStop, false)
  for (const patch of [{ stopReason: 'error' }, { errorMessage: 'ECONNRESET' }])
    assert.equal(bootstrapUserStopOutcome({ ...snapshot, messages: [{ ...snapshot.messages[0], ...patch }] }, 100).normalUserStop, false)
  for (const patch of [{ source: 'network' }, { reason: 'session_close' }])
    assert.equal(bootstrapUserStopOutcome({ ...snapshot, entries: [{ ...snapshot.entries[0],
      data: { ...snapshot.entries[0].data, ...patch } }] }, 100).normalUserStop, false)
})

test('controlled deferred tools use public tool_invoke and observation keeps their actual arguments', () => {
  for (const name of ['project_open', 'project_create', 'abs_apply', 'project_status']) {
    const args = { project: '/test-owned/project' }, call = bootstrapDeferredCall('original-id', name, args)
    assert.deepEqual(call, { id: 'original-id', name: 'tool_invoke', arguments: { name, arguments: args } })
    const observed = bootstrapCalls({ messages: [{ role: 'assistant', content: [{ type: 'toolCall', ...call }] }] })[0]
    assert.equal(observed.actualName, name); assert.deepEqual(observed.actualArguments, args)
  }
  for (const native of ['read', 'edit', 'tool_load']) assert.throws(() => bootstrapDeferredCall('id', native, {}))
})
