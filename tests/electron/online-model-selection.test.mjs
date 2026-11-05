import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { assertSelectedOnlineModel, explicitOnlineModelId, isOnlineModelChipLabel, observeOnlineModelCatalog, resolveOnlineModelPreset } from '../../e2e/fixtures/online-model-selection.mjs'

const catalog = () => ({ data: { model_presets: { 'auto-fast': { display_name: 'Aily Fast', model: 'glm-5.3-flash', is_user_selectable: true } },
  user_visible_model_presets: { 'auto-fast': { display_name: 'Aily Fast', is_user_selectable: true, unavailable_reason: null } } } })

test('no override and auto keep the existing product default without inspecting catalog', () => {
  assert.equal(explicitOnlineModelId(undefined), undefined)
  assert.equal(explicitOnlineModelId('auto'), undefined)
  assert.equal(resolveOnlineModelPreset(null, 'auto'), undefined)
  assert.doesNotThrow(() => assertSelectedOnlineModel({ model: { provider: 'other', id: 'another-default' } }, undefined))
})

test('explicit preset uses only the real visible selectable catalog display name and exact SDK identity', () => {
  const selected = resolveOnlineModelPreset(catalog(), 'auto-fast')
  assert.deepEqual(selected, { id: 'auto-fast', provider: 'aily-services', label: 'Aily Fast' })
  assert.doesNotThrow(() => assertSelectedOnlineModel({ model: { id: 'auto-fast', provider: 'aily-services' } }, selected))
  for (const model of [{ id: 'auto', provider: 'aily-services' }, { id: 'auto-fast', provider: 'another-provider' }, undefined])
    assert.throws(() => assertSelectedOnlineModel({ model }, selected))
})

test('hidden, nonselectable, unavailable, malformed and ambiguous source IDs fail before any UI action', () => {
  for (const mutate of [
    item => { item.data.user_visible_model_presets = { another: {} } },
    item => { item.data.user_visible_model_presets['auto-fast'].is_user_selectable = false },
    item => { item.data.user_visible_model_presets['auto-fast'].is_user_selectable = undefined; item.data.model_presets['auto-fast'].is_user_selectable = undefined },
    item => { item.data.user_visible_model_presets['auto-fast'].unavailable_reason = 'pilot disabled' },
    item => { item.data.user_visible_model_presets['auto-fast'].available = false },
    item => { item.data.user_visible_model_presets['auto-fast'].is_available = false },
    item => { item.data.user_visible_model_presets['auto-fast'].enabled = false },
    item => { item.data.user_visible_model_presets['auto-fast'].available = 'true' },
    item => { item.data.user_visible_model_presets['auto-fast'].display_name = ' ' },
  ]) {
    const source = catalog(); mutate(source)
    assert.throws(() => resolveOnlineModelPreset(source, 'auto-fast'))
  }
  for (const id of ['', null, {}, '../auto-fast', 'auto-fast\n']) assert.throws(() => explicitOnlineModelId(id))
})

test('legacy catalog fallback still requires an explicitly visible base preset', () => {
  const source = catalog(); delete source.data.user_visible_model_presets
  assert.throws(() => resolveOnlineModelPreset(source, 'auto-fast'))
  source.data.model_presets['auto-fast'].user_visible = true
  assert.equal(resolveOnlineModelPreset(source, 'auto-fast').label, 'Aily Fast')
})

test('chip labels allow only the exact catalog name with an optional nonempty single-line reasoning label', () => {
  for (const label of ['Aily Fast', 'Aily Fast · High', 'Aily Fast · High accuracy'])
    assert.equal(isOnlineModelChipLabel(label, 'Aily Fast'), true)
  for (const label of ['Aily FastOther', 'Aily Fast Other · High', 'Aily Fast · ', 'Aily Fast ·  ',
    'Aily Fast · High\n', 'Aily Fast\n · High', 'Aily Fast · High\rLow', 'Aily Fast ·  High', 'Aily Fast · High '])
    assert.equal(isOnlineModelChipLabel(label, 'Aily Fast'), false)
})

const preset = { id: 'auto-fast', provider: 'aily-services', label: 'Aily Fast' }
function channel(t) {
  const page = new EventEmitter(), socket = new EventEmitter()
  socket.url = () => 'ws://127.0.0.1:1234/ws?token=never-persist-this'
  const observer = observeOnlineModelCatalog(page, 'C:/isolated/project')
  t.after(() => observer.close())
  page.emit('websocket', socket)
  const send = (id, type = 'models.list', cwd = 'C:/isolated/project') => socket.emit('framesent', { payload: JSON.stringify({ id, channel: 'agent', command: { type, cwd } }) })
  const response = (id, models, extra = {}) => socket.emit('framereceived', { payload: JSON.stringify({ id, channel: 'agent', type: 'response', ok: true, result: { models }, ...extra }) })
  const model = (extra = {}) => ({ ...preset, enabled: true, ...extra })
  return { page, socket, observer, send, response, model }
}

test('catalog readiness observes the existing UI channel and cached exact selectable preset without sending commands', async t => {
  const h = channel(t)
  h.send('list')
  h.response('unrelated', [])
  h.response('list', [h.model()])
  const ready = await h.observer.waitUntilReady(preset, { deadline: Date.now() + 100 })
  assert.equal(ready.modelCount, 1)
  assert.deepEqual(ready.observations, [{ command: 'models.list', state: 'completed', modelCount: 1 }])
  assert.doesNotMatch(JSON.stringify(ready), /token|never-persist|1234|isolated/)
})

test('a cold cached Auto list is not ready until the existing background refresh completes', async t => {
  const h = channel(t)
  h.send('list'); h.response('list', [h.model({ id: 'auto' })])
  const deadline = Date.now() + 1000
  let settled = false
  const waiting = h.observer.waitUntilReady(preset, { deadline }).then(value => { settled = true; return value })
  h.send('refresh', 'models.refresh')
  await Promise.resolve()
  assert.equal(settled, false)
  h.response('refresh', [h.model()])
  assert.equal((await waiting).observations[1].state, 'completed')
})

test('catalog readiness rejects failed UI responses without disclosing raw errors or credentials', async t => {
  const h = channel(t)
  h.send('list')
  h.response('list', undefined, { ok: false, errorCode: 'catalog_unavailable', error: 'secret-response-content' })
  await assert.rejects(h.observer.waitUntilReady(preset, { deadline: Date.now() + 100 }), error => {
    assert.equal(error.catalogReadiness.observations[0].errorCode, 'catalog_unavailable')
    assert.doesNotMatch(JSON.stringify(error), /secret-response-content|never-persist/)
    return /UI control channel/.test(error.message)
  })
})

test('completed refresh with wrong or disabled models fails instead of selecting another model', async t => {
  for (const value of [{ id: 'auto' }, { enabled: false }, { provider: 'foreign' }]) {
    const h = channel(t)
    h.send('refresh', 'models.refresh'); h.response('refresh', [h.model(value)])
    await assert.rejects(h.observer.waitUntilReady(preset, { deadline: Date.now() + 100 }), /without the requested/)
  }
})

test('foreign workspaces and unrelated control events cannot prove the visible catalog ready', async t => {
  const h = channel(t)
  h.send('foreign', 'models.refresh', 'C:/another/project'); h.response('foreign', [h.model()])
  h.send('not-models', 'tools.list'); h.response('not-models', [h.model()])
  await assert.rejects(h.observer.waitUntilReady(preset, { deadline: Date.now() }), error => {
    assert.equal(error.catalogReadiness.stage, 'awaiting-catalog-command')
    assert.equal(error.catalogReadiness.modelCount, 0)
    return /existing startup budget/.test(error.message)
  })
})

test('the original expired startup deadline is never reset and pending stages remain diagnosable', async t => {
  const h = channel(t)
  h.send('list')
  await assert.rejects(h.observer.waitUntilReady(preset, { deadline: Date.now() - 1 }), error => {
    assert.equal(error.catalogReadiness.stage, 'catalog-initializing')
    assert.equal(error.catalogReadiness.observations[0].state, 'pending')
    return true
  })
})

test('closing the observer rejects its pending observation once and removes socket listeners', async t => {
  const h = channel(t)
  const waiting = h.observer.waitUntilReady(preset, { deadline: Date.now() + 1000 })
  h.observer.close(); h.observer.close()
  await assert.rejects(waiting, /observer closed/)
  assert.equal(h.page.listenerCount('websocket'), 0)
  assert.equal(h.socket.listenerCount('framesent'), 0)
  assert.equal(h.socket.listenerCount('framereceived'), 0)
})
