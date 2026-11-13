import assert from 'node:assert/strict'

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const exactText = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')

/** Observe the composer's existing control socket, never create another client
 * or invoke a model. A visible textbox is not a completed cold catalog load. */
export function observeOnlineModelCatalog(page, workspace) {
  const normalized = value => typeof value === 'string' ? value.replaceAll('\\', '/').toLowerCase() : ''
  const pending = new Map(), observations = [], listeners = new Set(), cleanups = []
  let models = [], closed = false
  const notify = () => { for (const listener of [...listeners]) listener() }
  const parse = payload => { try { return record(JSON.parse(String(payload))) } catch { return undefined } }
  const onSocket = socket => {
    let url
    try { url = new URL(socket.url()) } catch { return }
    if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ws') return
    const sent = ({ payload }) => {
      const message = parse(payload), command = record(message?.command)
      if (message?.channel !== 'agent' || typeof message.id !== 'string' || !command
        || !['models.list', 'models.refresh'].includes(command.type) || normalized(command.cwd) !== normalized(workspace)) return
      const observation = { command: command.type, state: 'pending', modelCount: 0 }
      observations.push(observation); pending.set(message.id, observation); notify()
    }
    const received = ({ payload }) => {
      const message = parse(payload)
      if (message?.channel !== 'agent' || message.type !== 'response') return
      const observation = pending.get(message.id)
      if (!observation) return
      pending.delete(message.id)
      const values = record(message.result)?.models
      if (message.ok === true && Array.isArray(values) && values.every(item => record(item) && typeof item.id === 'string' && typeof item.provider === 'string' && typeof item.enabled === 'boolean')) {
        models = values.map(item => ({ id: item.id, provider: item.provider, enabled: item.enabled }))
        observation.state = 'completed'; observation.modelCount = models.length
      } else {
        observation.state = 'failed'
        observation.errorCode = typeof message.errorCode === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(message.errorCode)
          ? message.errorCode : 'catalog_response_invalid'
      }
      notify()
    }
    socket.on('framesent', sent); socket.on('framereceived', received)
    cleanups.push(() => { socket.off('framesent', sent); socket.off('framereceived', received) })
  }
  page.on('websocket', onSocket)
  const snapshot = () => ({ stage: closed ? 'closed' : pending.size ? 'catalog-initializing' : observations.length ? 'catalog-settled' : 'awaiting-catalog-command',
    modelCount: models.length, observations: observations.map(item => ({ ...item })) })
  return {
    snapshot,
    waitUntilReady(preset, { deadline }) {
      assert.ok(preset && Number.isSafeInteger(deadline), 'Catalog readiness needs the explicit preset and original startup deadline')
      return new Promise((resolve, reject) => {
        let timer
        const finish = (error) => { clearTimeout(timer); listeners.delete(check); error ? reject(error) : resolve(snapshot()) }
        const failure = reason => Object.assign(new Error(`Online model catalog initialization ${reason}`), { catalogReadiness: snapshot() })
        const check = () => {
          if (closed) return finish(failure('observer closed'))
          if (models.some(model => model.id === preset.id && model.provider === preset.provider && model.enabled)) return finish()
          if (observations.some(item => item.state === 'failed')) return finish(failure('failed on the UI control channel'))
          if (observations.some(item => item.command === 'models.refresh' && item.state === 'completed')) return finish(failure('completed without the requested selectable preset'))
          if (Date.now() >= deadline) return finish(failure('exceeded the existing startup budget'))
        }
        listeners.add(check)
        timer = setTimeout(() => finish(failure('exceeded the existing startup budget')), Math.max(0, deadline - Date.now()))
        check()
      })
    },
    close() {
      if (closed) return
      closed = true; page.off('websocket', onSocket)
      for (const cleanup of cleanups) cleanup()
      notify()
    }
  }
}

export function isOnlineModelChipLabel(actual, catalogLabel) {
  if (typeof actual !== 'string' || /[\r\n]/.test(actual)) return false
  if (actual === catalogLabel) return true
  const prefix = catalogLabel + ' · '
  if (!actual.startsWith(prefix)) return false
  const reasoning = actual.slice(prefix.length)
  return reasoning.length > 0 && reasoning.trim() === reasoning
}

/** Only an explicit test preset changes the normal UI selection. Never route
 * a failed default request to another model or invent an unavailable preset. */
export function explicitOnlineModelId(value) {
  if (value === undefined || value === 'auto') return undefined
  assert.ok(typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value), 'Explicit online model must be a catalog preset ID')
  return value
}

export function resolveOnlineModelPreset(payload, requestedModel) {
  const id = explicitOnlineModelId(requestedModel)
  if (!id) return undefined
  const data = record(record(payload)?.data)
  assert.ok(data, 'The real model catalog must contain its data object')
  const base = record(data.model_presets) ?? {}, visible = record(data.user_visible_model_presets) ?? {}
  const hasVisibleCatalog = Object.keys(visible).length > 0
  assert.ok(hasVisibleCatalog ? Object.hasOwn(visible, id) : record(base[id])?.user_visible === true,
    'The requested model must be visible in the real catalog')
  const entry = { ...(record(base[id]) ?? {}), ...(record(visible[id]) ?? {}) }
  assert.equal(entry.is_user_selectable, true, 'The requested model is not explicitly user-selectable')
  for (const flag of ['available', 'is_available', 'enabled']) if (Object.hasOwn(entry, flag))
    assert.equal(entry[flag], true, 'The requested model has an unavailable or malformed availability flag')
  assert.ok(entry.unavailable_reason === undefined || entry.unavailable_reason === null || entry.unavailable_reason === '',
    'The requested model has an unavailable reason')
  assert.ok(typeof entry.display_name === 'string' && entry.display_name.trim() === entry.display_name && entry.display_name.length > 0,
    'The requested model needs its exact visible display name')
  return { id, provider: 'aily-services', label: entry.display_name }
}

export async function selectOnlineModelFromUi(frame, preset, { catalogTimeoutMs = 5000 } = {}) {
  if (!preset) return undefined
  const chip = frame.locator('.composer-model-chip')
  assert.equal(await chip.count(), 1, 'Use the normal single composer model selector')
  await chip.click()
  const menu = frame.locator('.popup-menu-model')
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  const label = menu.locator('.popup-menu-label strong').filter({ hasText: exactText(preset.label) })
  await label.first().waitFor({ state: 'visible', timeout: catalogTimeoutMs })
  assert.equal(await label.count(), 1, 'The requested model must have one exact visible UI label')
  const button = label.locator('xpath=ancestor::button[1]')
  assert.equal(await button.isEnabled(), true, 'Do not select a disabled model')
  assert.notEqual(await button.getAttribute('aria-disabled'), 'true', 'The product UI must also allow this model')
  await label.click()
  const chipPattern = new RegExp(exactText(preset.label).source.slice(0, -1) + '(?: · \\S(?:[^\\r\\n]*\\S)?)?$')
  await chip.locator('span').filter({ hasText: chipPattern }).waitFor({ state: 'visible', timeout: 5000 })
  const actualUiLabel = await chip.innerText()
  assert.ok(isOnlineModelChipLabel(actualUiLabel, preset.label), 'The composer must acknowledge the exact model with only an optional reasoning label')
  return { requestedId: preset.id, provider: preset.provider, catalogLabel: preset.label, actualUiLabel, normalUiSelection: true }
}

export function assertSelectedOnlineModel(snapshot, preset) {
  if (!preset) return
  assert.equal(snapshot.model?.provider, preset.provider, 'The real SDK must use the selected catalog provider')
  assert.equal(snapshot.model?.id, preset.id, 'The real SDK must use the exact UI-selected preset')
}
