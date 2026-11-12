import assert from 'node:assert/strict'
import path from 'node:path'

const same = (left, right) => typeof left === 'string' && typeof right === 'string'
  && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()

/** Passive UI evidence only: fresh sessions use create + subscribe; existing
 * sessions use openSubscribe. Neither sending a command nor a JSONL header is
 * a ready runtime. Callers must not read the registry before this returns. */
export function environmentSessionStartup(commands, responses, project) {
  for (const command of commands.filter(value => same(value.cwd, project)
    && ['session.create', 'session.openSubscribe'].includes(value.type))) {
    const opened = responses.find(value => value.id === command.id)
    if (!opened) continue
    assert.equal(opened.ok, true, `The real UI session open failed: ${opened.errorCode ?? 'unknown'}`)
    const sessionId = command.type === 'session.create' ? opened.sessionId : command.sessionId
    assert.ok(typeof sessionId === 'string' && sessionId)
    if (opened.cwd !== undefined) assert.ok(same(opened.cwd, project))
    if (command.type === 'session.openSubscribe') {
      assert.equal(opened.subscribed, true)
      if (opened.sessionId !== undefined) assert.equal(opened.sessionId, sessionId)
      return { sessionId, opened: command, openResponse: opened, subscribed: command, subscriptionResponse: opened }
    }
    assert.ok(same(opened.cwd, project), 'The created runtime must report its exact project')
    const subscribe = commands.find(value => value.type === 'session.subscribe' && value.sessionId === sessionId && value.at >= command.at)
    if (!subscribe) continue
    const subscribed = responses.find(value => value.id === subscribe.id)
    if (!subscribed) continue
    assert.equal(subscribed.ok, true, `The real UI session subscribe failed: ${subscribed.errorCode ?? 'unknown'}`)
    assert.equal(subscribed.subscribed, true)
    if (subscribed.sessionId !== undefined) assert.equal(subscribed.sessionId, sessionId)
    return { sessionId, opened: command, openResponse: opened, subscribed: subscribe, subscriptionResponse: subscribed }
  }
}
