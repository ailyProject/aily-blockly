import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

/** One terminal source read, shared by early evidence and later assertions. */
export function readBootstrapTerminalGeneratedSource() {
  const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
  if (typeof editor?.blocklyService?.getReusableGeneratedCode !== 'function') throw new Error('Terminal generated source is unavailable')
  const source = editor.blocklyService.getReusableGeneratedCode()
  if (typeof source !== 'string') throw new Error('Terminal generated source is not text')
  return source
}

/** Browser-side read-only terminal observation. Keep it before acceptance
 * assertions so a strict later failure does not discard actual UI evidence. */
export function readBootstrapTerminalUi() {
  const component = selector => { const element = document.querySelector(selector)
    return element ? window.ng?.getComponent(element) : undefined }
  const editor = component('app-blockly-editor'), service = editor?.blocklyService
  const host = component('app-child-tool-host'), project = editor?.projectService?.currentProjectPath ?? null
  const projectService = component('app-header')?.projectService
  let documentText = null, captureError = null
  try { documentText = service?.captureRecoverySnapshot().documentText ?? null }
  catch (error) { captureError = { name: error.name, message: String(error.message) } }
  return { documentText, captureError, finalHost: { project, busy: service?.isWorkspaceEditInProgress(),
    blocked: service?.isWorkspaceEditBlocked(), recoveryRequired: service?.isWorkspaceRecoveryRequired(),
    hasRunning: host?.aiOperationProtocol?.hasRunning, lifecycleOwners: projectService?.projectLifecycle?.owners?.size ?? null,
    aiNoticeCount: [...document.querySelectorAll('app-notification .notification-box')]
      .filter(node => /AI正在操作|正在停止 AI|正在同步 AI 状态/.test(node.textContent)).length } }
}

/** This is a case-specific functional-test capacity check, not a product
 * limit or a performance qualification. Unknown CIM data never bypasses it. */
export function bootstrapResourceAssessment(profile, snapshot) {
  assert.ok(['physical-1gib', 'windows-functional'].includes(profile))
  const policy = { profile, minimumPhysicalBytes: profile === 'windows-functional' ? 256 * 1024 ** 2 : 1024 ** 3,
    minimumAvailableCommitBytes: profile === 'windows-functional' ? 4 * 1024 ** 3 : null }
  if (profile === 'physical-1gib') return { ...policy,
    passed: Number.isSafeInteger(snapshot?.freeBytes) && snapshot.freeBytes >= policy.minimumPhysicalBytes }
  const memory = snapshot?.windowsMemory
  const valid = snapshot?.platform === 'win32' && memory
    && ['availablePhysicalBytes', 'commitLimitBytes', 'committedBytes'].every(key => Number.isSafeInteger(memory[key]) && memory[key] >= 0)
    && memory.commitLimitBytes > 0 && memory.committedBytes <= memory.commitLimitBytes
  const availableCommitBytes = valid ? memory.commitLimitBytes - memory.committedBytes : null
  return { ...policy, performanceComparisonEligible: false, metricsValid: Boolean(valid), availableCommitBytes,
    passed: Boolean(valid && memory.availablePhysicalBytes >= policy.minimumPhysicalBytes
      && availableCommitBytes >= policy.minimumAvailableCommitBytes) }
}

/** Auto is the product's normal selectable default, independent of the
 * server's effective response preset. Match its catalog label precedence. */
export function bootstrapOriginalAutoSelection(catalog) {
  assert.ok(catalog?.data && typeof catalog.data === 'object' && !Array.isArray(catalog.data))
  const entry = { ...catalog.data.model_presets?.auto, ...catalog.data.user_visible_model_presets?.auto }
  const label = [entry.display_name, catalog.data.picker_control_model_presets?.auto?.label]
    .find(value => typeof value === 'string' && value.trim())?.trim() ?? 'Auto'
  return { id: 'auto', provider: 'aily-services', label }
}

export const bootstrapPrompt = '帮我写一个arduino uno R4 wifi获取成都天气数据，然后通过HTTP POST传输到指定服务器的程序\n\n新建项目，不得参考现有项目'
export const bootstrapPromptSha256 = createHash('sha256').update(bootstrapPrompt).digest('hex')

export function bootstrapQuestionKind(question) {
  if (/天气.*(?:源|服务|API)|(?:源|服务|API).*天气|Open.?Meteo/i.test(question)) return 'weather'
  if (/JSON|请求体|(?:传输|上报|数据).*格式|格式.*(?:传输|上报|数据)/i.test(question)) return 'payload'
  if (/(?:服务器|接收|目标|POST).*?(?:地址|URL|哪)|(?:地址|URL).*?(?:服务器|接收|POST)/i.test(question)) return 'server'
  if (/SSID|Wi.?Fi.*(?:名称|账号)|(?:网络|无线).*名称/i.test(question)) return 'wifi-ssid'
  if (/(?:Wi.?Fi|网络|无线).*(?:密码|口令)|(?:密码|口令).*(?:Wi.?Fi|网络|无线)/i.test(question)) return 'wifi-password'
  if (/(?:上报|上传|发送).*(?:周期|频率|间隔)|(?:周期|频率|间隔).*(?:上报|上传|发送)/i.test(question)) return 'interval'
  return null
}

/** Answers are explicit input data, never additional instructions or tool order.
 * A new, unknown question is retained as a fixture limitation instead of being
 * answered with an invented user preference or a recovery approval. */
export function selectBootstrapAnswer(question, labels, originalAnswers) {
  const kind = bootstrapQuestionKind(question)
  assert.ok(kind, 'The task asked a question outside the three supplied user choices')
  const synthetic = { 'wifi-ssid': 'E2E_BOOTSTRAP_WIFI', 'wifi-password': 'e2e-test-only', interval: '60秒' }[kind]
  if (synthetic) return { kind, option: labels.find(label => kind === 'interval'
    ? /(?:60\s*秒|1\s*分钟)/.test(label) : /占位|测试值|稍后|之后|后续.*填/.test(label)) ?? null,
    freeText: synthetic, answerOrigin: 'synthetic-hardware-fixture', originalQuestion: null, originalAnswer: null }
  const original = originalAnswers.find(item => bootstrapQuestionKind(item.question) === kind)
  assert.ok(original && typeof original.answer === 'string' && original.answer.trim(), 'An explicit original answer is required')
  let preferred, freeText
  if (kind === 'weather') {
    assert.match(original.answer, /Open.?Meteo/i)
    preferred = labels.find(label => /Open.?Meteo/i.test(label)); freeText = 'Open-Meteo'
  } else if (kind === 'payload') {
    assert.match(original.answer, /JSON/i)
    preferred = labels.find(label => /\bJSON\b/i.test(label)); freeText = 'JSON'
  } else {
    const url = original.answer.match(/https?:\/\/[^\s，。；）)"']+/)?.[0]
    assert.ok(url, 'The supplied server choice must contain its actual example URL')
    preferred = labels.find(label => label.includes(url)); freeText = url
  }
  return { kind, option: preferred ?? null, freeText: preferred ? null : freeText,
    originalQuestion: original.question, originalAnswer: original.answer, answerOrigin: 'original-user-choice' }
}

/** Operate only the actual visible questionnaire. No synthetic tool result,
 * control-socket business command or additional user message is submitted. */
export async function answerBootstrapQuestionnaire(frame, originalAnswers) {
  const carousel = frame.locator('.runtime-question-carousel.has-question')
  if (!await carousel.isVisible()) return null
  const evidence = []
  for (const item of await carousel.locator('.rtq-question').all()) {
    const question = await item.locator('.rtq-question-title').innerText()
    const options = item.locator('.rtq-option')
    const labels = await options.locator('.rtq-option-copy strong').allTextContents()
    const selected = selectBootstrapAnswer(question, labels, originalAnswers)
    if (selected.option !== null) {
      const index = labels.indexOf(selected.option), option = options.nth(index)
      if (!(await option.getAttribute('class')).split(/\s+/).includes('rtq-checked')) await option.click()
    } else {
      const freeform = item.locator('.rtq-freeform')
      assert.equal(await freeform.count(), 1, 'The original answer needs a visible freeform field')
      // Clear a recommendation so it cannot be submitted alongside the user's
      // explicit answer when an exact option is absent.
      for (const checked of await item.locator('.rtq-option.rtq-checked').all()) await checked.click()
      await freeform.fill(selected.freeText)
    }
    evidence.push({ question, ...selected })
  }
  assert.ok(evidence.length > 0)
  await carousel.locator('.rtq-actions .cca-btn-primary').click()
  return { answeredAt: Date.now(), source: 'original-user-selected-answers', visibleUiOnly: true, answers: evidence }
}

export const bootstrapText = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
export function bootstrapPayload(message) {
  if (message?.details?.result && typeof message.details.result === 'object') return message.details.result
  try { return JSON.parse(bootstrapText(message)) } catch { return undefined }
}
export function bootstrapCalls(snapshot) {
  return (snapshot?.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
    .filter(item => item.type === 'toolCall').map(item => ({ ...item,
      actualName: item.name === 'tool_invoke' ? item.arguments?.name : item.name,
      actualArguments: item.name === 'tool_invoke' ? item.arguments?.arguments : item.arguments }))
}

/** Controlled providers follow the same public progressive-tool wire schema as
 * a real model. Loading a description never exposes a deferred native name. */
export function bootstrapDeferredCall(id, name, args) {
  assert.ok(['project_open', 'project_create', 'abs_apply', 'project_status'].includes(name))
  return { id, name: 'tool_invoke', arguments: { name, arguments: args } }
}

export function inspectBootstrapSession(snapshot) {
  const calls = bootstrapCalls(snapshot), results = snapshot.messages.filter(message => message.role === 'toolResult')
  const creates = calls.filter(call => call.actualName === 'project_create').map(call => {
    const message = results.find(item => item.toolCallId === call.id), value = bootstrapPayload(message)
    return { callId: call.id, arguments: call.actualArguments, result: value,
      isError: message?.isError === true, resultObserved: Boolean(message) }
  })
  const builds = calls.filter(call => call.actualName === 'project_build').map(call => {
    const message = results.find(item => item.toolCallId === call.id)
    return { callId: call.id, arguments: call.actualArguments, result: bootstrapPayload(message), isError: message?.isError === true }
  })
  const final = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
  const finalText = bootstrapText(final)
  const userPrompts = snapshot.messages.filter(message => message.role === 'user').map(bootstrapText)
  return { calls, creates, builds, final, finalText, userPrompts,
    successfulCreates: creates.filter(item => !item.isError && item.result?.ok === true),
    completedBuilds: builds.filter(item => item.result?.buildReceipt?.state === 'completed'),
    projectSwitchCalls: calls.filter(call => ['project_fork', 'project_open', 'app_open'].includes(call.actualName)),
    manualLifecycleHandoff: /(?:你|用户).{0,30}(?:手动|自行).{0,45}(?:新建|打开|重开|切换)|(?:新建|打开|重开|切换).{0,40}(?:后告诉我|后再继续)/s.test(finalText) }
}

const cppLiteralOrComment = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g
const withoutComments = source => source.replace(cppLiteralOrComment, token => token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token)
const withoutLiterals = source => source.replace(cppLiteralOrComment, token => token.replace(/[^\r\n]/g, ' '))

// A small expression reader for the generated API arguments, not a C++ parser.
// It rejects unsupported syntax instead of evaluating arbitrary source text.
function firstCppArgument(source, start, endCharacters) {
  let depth = 0, quote = null, escaped = false
  for (let index = start; index < source.length && index - start <= 32768; index++) {
    const char = source[index]
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = null; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (depth === 0 && endCharacters.includes(char)) return source.slice(start, index)
    if (char === '(') depth++
    else if (char === ')') { if (--depth < 0) return null }
  }
  return null
}

function cppConcatParts(expression) {
  const parts = []; let depth = 0, quote = null, escaped = false, start = 0
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index]
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = null; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') depth++
    else if (char === ')') { if (--depth < 0) return null }
    else if (char === '+' && depth === 0) { parts.push(expression.slice(start, index)); start = index + 1 }
  }
  if (quote || depth !== 0) return null
  parts.push(expression.slice(start)); return parts
}

function weatherGetUrls(source) {
  const code = withoutComments(source), masked = withoutLiterals(code), declarations = new Map()
  const declaration = /\b((?:(?:static|const|constexpr)\s+)*)(String|float|double|int|long|short|auto|char\s*\*)\s*([A-Za-z_]\w*)\s*=/g
  for (const match of masked.matchAll(declaration)) {
    const name = match[3], initializer = firstCppArgument(code, match.index + match[0].length, ';')
    const writes = [...masked.matchAll(new RegExp('\\b' + name + '\\s*(?:=(?!=)|\\+=|-=|\\*=|/=|%=|\\+\\+|--)|(?:\\+\\+|--)\\s*\\b' + name + '\\b', 'g'))]
    const bindings = declarations.get(name) ?? []
    bindings.push({ at: match.index, initializer, constant: /\b(?:const|constexpr)\b/.test(match[1]), writes: writes.length })
    declarations.set(name, bindings)
  }
  const resolve = (expression, before, seen = new Set(), depth = 0) => {
    if (typeof expression !== 'string' || expression.length > 32768 || depth > 16) return null
    expression = expression.trim()
    if (/^"(?:\\.|[^"\\])*"$/.test(expression)) {
      try { return { kind: 'cstring', value: JSON.parse(expression) } } catch { return null }
    }
    if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?[fFlL]?$/.test(expression)) {
      const number = Number(expression.replace(/[fFlL]$/, ''))
      return Number.isFinite(number) ? { kind: 'number', value: String(number) } : null
    }
    if (/^[A-Za-z_]\w*$/.test(expression)) {
      const bindings = declarations.get(expression)
      if (seen.has(expression) || bindings?.length !== 1) return null
      const binding = bindings[0]
      if (!binding.constant || binding.writes !== 1 || binding.at >= before) return null
      return resolve(binding.initializer, binding.at, new Set([...seen, expression]), depth + 1)
    }
    const parts = cppConcatParts(expression)
    if (!parts) return null
    if (parts.length > 1) {
      let value = resolve(parts[0], before, seen, depth + 1)
      for (const part of parts.slice(1)) {
        const next = resolve(part, before, seen, depth + 1)
        // C-string + number is pointer arithmetic, not URL concatenation.
        if (!value || !next || value.kind !== 'String' && next.kind !== 'String') return null
        value = { kind: 'String', value: value.value + next.value }
      }
      return value
    }
    if (expression.startsWith('String(') && expression.endsWith(')')) {
      const argument = firstCppArgument(expression, 7, ',)')
      if (argument === null || expression !== 'String(' + argument + ')') return null
      const value = resolve(argument, before, seen, depth + 1)
      return value ? { kind: 'String', value: value.value } : null
    }
    if (expression.startsWith('(') && expression.endsWith(')')) {
      const argument = firstCppArgument(expression, 1, ')')
      if (argument !== null && expression === '(' + argument + ')') return resolve(argument, before, seen, depth + 1)
    }
    return null
  }
  const urls = []
  for (const call of masked.matchAll(/\.\s*get\s*\(/gi)) {
    const argument = firstCppArgument(code, call.index + call[0].length, ',)')
    const value = resolve(argument, call.index)
    if (!value || value.kind === 'number') continue
    try { const url = new URL(value.value)
      if (['http:', 'https:'].includes(url.protocol) && url.hostname === 'api.open-meteo.com' && url.pathname === '/v1/forecast') urls.push(url)
    } catch { /* An unresolved or malformed URL cannot prove the weather input. */ }
  }
  return { urls, code, masked }
}

export function inspectWeatherGeneratedSource(source) {
  const { urls, code, masked } = weatherGetUrls(source)
  const sameUrlCoordinates = urls.some(url => {
    const latitude = Number(url.searchParams.get('latitude')), longitude = Number(url.searchParams.get('longitude'))
    return url.searchParams.has('latitude') && url.searchParams.has('longitude')
      && latitude >= 30 && latitude < 31 && longitude >= 104 && longitude < 105
  })
  return { openMeteoEndpoint: urls.length > 0, chengduLatitude: sameUrlCoordinates, chengduLongitude: sameUrlCoordinates,
    postOperation: /\.\s*post(?:Json)?\s*\(/i.test(masked),
    jsonPayloadOrParsing: /ArduinoJson|JsonDocument|deserializeJson|serializeJson|application\/json/i.test(code),
    wifiConnection: /WiFiS3|WiFi\.begin|WiFiClient/i.test(code) }
}

/** Goal coverage is independent of actual compiler/persistence evidence. An
 * unsupported expression is unqualified, never a fabricated compiler failure. */
export function qualifyBootstrapWeatherGoal(generated, compilerInput) {
  const required = ['openMeteoEndpoint', 'chengduLatitude', 'chengduLongitude', 'postOperation', 'jsonPayloadOrParsing', 'wifiConnection']
  const unproven = []
  for (const [scope, checks] of Object.entries({ generated, compilerInput }))
    for (const name of required) if (checks?.[name] !== true) unproven.push({ scope, name })
  return { status: unproven.length === 0 ? 'verified' : 'incomplete', finiteOracle: true, unproven,
    generated, compilerInput, interpretation: 'Incomplete means the finite oracle has not established the entire requested goal. Actual compiler and Native evidence retain their own independent outcomes.' }
}

/** A durable workspace can retain an explicitly associated project. Never
 * infer binding from the Host's visible canvas or from a successful RPC alone. */
export function bootstrapSessionProjectBinding(snapshot, project) {
  const normalized = value => typeof value === 'string' ? value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() : null
  const association = snapshot?.projectAssociation
    ?? snapshot?.entries?.filter(entry => entry.type === 'custom' && entry.customType === 'aily.project-association').at(-1)?.data
  const cwdMatches = normalized(snapshot?.cwd) === normalized(project)
  const associated = Boolean(association && typeof association.workspaceId === 'string' && typeof association.root === 'string'
    && Array.isArray(association.projects) && association.projects.some(item => normalized(item) === normalized(project)))
  return { sessionId: snapshot?.sessionId, cwd: snapshot?.cwd, cwdMatches, associatedProjectMatches: associated,
    association: association ? { workspaceId: association.workspaceId, root: association.root, projects: association.projects } : null,
    bound: cwdMatches || associated }
}

/** A durable exact user Stop is a normal aborted terminal outcome. An error
 * string alone cannot establish cancellation or excuse a provider failure. */
export function bootstrapUserStopOutcome(snapshot, requestedAt) {
  const final = snapshot?.messages?.filter(message => message.role === 'assistant').at(-1)
  const intent = snapshot?.entries?.find(entry => entry.type === 'custom' && entry.customType === 'aily.abort-request'
    && entry.data?.version === 1 && entry.data.sessionId === snapshot.sessionId
    && entry.data.source === 'user' && entry.data.reason === 'user_stop'
    && Number.isFinite(entry.data.requestedAt) && entry.data.requestedAt >= requestedAt)
  const cancellationMessage = !final?.errorMessage || final.errorMessage === 'Request aborted (user: user_stop)'
  return { normalUserStop: Number.isFinite(requestedAt) && Boolean(intent) && final?.stopReason === 'aborted' && cancellationMessage,
    stopReason: final?.stopReason, matchingIntent: Boolean(intent), backendRequestedAt: intent?.data.requestedAt ?? null,
    cancellationMessageMatches: cancellationMessage }
}
