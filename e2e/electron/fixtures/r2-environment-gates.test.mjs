import assert from 'node:assert/strict'
import test from 'node:test'
import {createEnvironmentPhaseGates} from './r2-environment-gates.mjs'

test('provider waits after each exact tool result until external verification releases its own gate',async()=>{
  const gates=createEnvironmentPhaseGates(),order=[]
  const library=gates.waitAfterResult({turn:1,step:1,previousResult:{toolCallId:'env-install-library'}}).then(()=>order.push('library-next'))
  await Promise.resolve();assert.deepEqual(order,[])
  gates.release('env-install-library');await library
  const board=gates.waitAfterResult({turn:1,step:3,previousResult:{tool_call_id:'env-select-board'}}).then(()=>order.push('board-next'))
  await Promise.resolve();assert.deepEqual(order,['library-next'])
  gates.release('env-select-board');await board
  assert.deepEqual(order,['library-next','board-next'])
  assert.ok(gates.snapshot().phases.every(phase=>phase.waiting&&phase.released))
})

test('cleanup cancellation exits a held provider without releasing a subsequent tool',async()=>{
  const gates=createEnvironmentPhaseGates(),reason=new DOMException('Owned test cleanup','AbortError')
  const waiting=gates.waitAfterResult({turn:1,step:1,previousResult:{toolCallId:'env-install-library'}})
  gates.cancel(reason);gates.cancel(reason)
  await assert.rejects(waiting,error=>error===reason)
  assert.equal(gates.snapshot().phases[0].released,false)
})

test('foreign result/release cannot open the owned gate',async()=>{
  const gates=createEnvironmentPhaseGates()
  await assert.rejects(gates.waitAfterResult({turn:1,step:1,previousResult:{toolCallId:'foreign'}}))
  assert.throws(()=>gates.release('foreign'))
  assert.ok(gates.snapshot().phases.every(phase=>!phase.released))
})

test('other provider steps need no gate, observation or project access',async()=>{
  const gates=createEnvironmentPhaseGates()
  const input={turn:0,step:0,get previousResult(){throw Error('An unrelated step must not inspect a result')}}
  // The public callback destructures only the local result metadata; it never
  // accepts or calls an E2E observer, host command or filesystem provider.
  await gates.waitAfterResult({turn:input.turn,step:input.step})
  await gates.waitAfterResult({turn:1,step:2})
  assert.ok(gates.snapshot().phases.every(phase=>!phase.waiting&&!phase.released))
})
