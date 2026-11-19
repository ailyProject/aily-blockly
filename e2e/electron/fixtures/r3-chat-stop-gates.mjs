import assert from 'node:assert/strict'

/** A provider response waits only on memory. Actual UI/registry/native facts
 * are verified by the independent observer before it releases each result. */
export function createChatStopGates(mode) {
  assert.ok(['apply-chat', 'recovery-owner'].includes(mode))
  const plans = [
    [0, 1, 'load-abs-tools'], [0, 2, 'export-baseline'], [0, 3, 'read-before-A'], [0, 4, 'edit-A'],
    ...(mode === 'recovery-owner' ? [[0, 5, 'validate-A-before-load-failure'], [0, 6, 'one-real-app-reload-fails']] : []),
    [1, 1, 'read-A-next-turn'], [1, 2, 'edit-B-next-turn'], [1, 3, 'apply-A-B-next-turn'],
  ]
  const gates = new Map(plans.map(([turn, step, id]) => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    promise.catch(() => {})
    return [id, { turn, step, id, promise, resolve, reject, waiting: false, released: false }]
  }))
  let cancelled
  return {
    async wait({ turn, step, previousResult }) {
      if (cancelled) throw cancelled
      const gate = [...gates.values()].find(value => value.turn === turn && value.step === step)
      if (!gate) return
      assert.equal(previousResult?.toolCallId ?? previousResult?.tool_call_id, gate.id,
        'The provider must present its exact preceding tool result')
      assert.equal(gate.waiting, false)
      gate.waiting = true
      await gate.promise
    },
    has: id => gates.has(id),
    release(id) {
      const gate = gates.get(id)
      assert.ok(gate); assert.equal(cancelled, undefined); assert.equal(gate.released, false)
      gate.released = true; gate.resolve()
    },
    cancel(error) {
      if (cancelled) return
      cancelled = error
      for (const gate of gates.values()) if (!gate.released) gate.reject(error)
    },
    snapshot: () => [...gates.values()].map(({ turn, step, id, waiting, released }) => ({ turn, step, id, waiting, released })),
  }
}
