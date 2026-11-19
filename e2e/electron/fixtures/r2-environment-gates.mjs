import assert from 'node:assert/strict'

// Provider ordering only. The observer owns all actual readback and assertions;
// this helper has no project, session, filesystem or host observation callback.
export function createEnvironmentPhaseGates() {
  const plans=[{step:1,id:'env-install-library'},{step:3,id:'env-select-board'}]
  const gates=new Map(plans.map(plan=>{
    let resolve,reject
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no})
    promise.catch(()=>{})
    return [plan.id,{...plan,promise,resolve,reject,waiting:false,released:false}]
  }))
  let cancelled
  return {
    async waitAfterResult({turn,step,previousResult}) {
      const gate=plans.find(plan=>turn===1&&step===plan.step)
      if(!gate)return
      const pending=gates.get(gate.id)
      assert.equal(previousResult?.toolCallId??previousResult?.tool_call_id,gate.id,'Only the corresponding actual tool result may wait on this phase')
      if(cancelled)throw cancelled
      pending.waiting=true
      await pending.promise
    },
    release(toolCallId) {
      const gate=gates.get(toolCallId)
      assert.ok(gate,'Only the externally verified library or board result can release a gate')
      assert.equal(cancelled,undefined)
      assert.equal(gate.released,false,'Each external phase is verified once')
      gate.released=true;gate.resolve()
    },
    cancel(reason) {
      if(cancelled||[...gates.values()].every(gate=>gate.released))return
      cancelled=reason
      for(const gate of gates.values())if(!gate.released)gate.reject(reason)
    },
    snapshot() {return {cancelled:!!cancelled,phases:[...gates.values()].map(({step,id,waiting,released})=>({step,id,waiting,released}))}}
  }
}
