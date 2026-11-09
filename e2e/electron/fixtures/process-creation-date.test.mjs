import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

const powershell=script=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}).trim()
const literal=value=>"'"+String(value).replaceAll("'","''")+"'"

test('controlled Windows JSON date conversion explains the old mismatch while UTC ISO preserves creation ticks', {skip:process.platform!=='win32'},()=>{
  const value=JSON.parse(powershell(`$creation=[DateTime]::Parse('2026-11-08T03:04:42.1234567Z').ToUniversalTime()
$record=[pscustomobject]@{CreationDate=$creation}
$legacy=$record|ConvertTo-Json -Compress
$parsed=$legacy|ConvertFrom-Json
@{legacy=(ConvertFrom-Json $legacy).CreationDate.ToString();legacyWire=$legacy;canonical=$creation.ToUniversalTime().ToString('o');canonicalAgain=$parsed.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`))
  assert.notEqual(JSON.parse(value.legacyWire).CreationDate,value.legacy)
  assert.match(value.canonical,/^2026-11-08T03:04:42\.1234567Z$/)
  // The legacy /Date(ms)/ wire drops sub-millisecond ticks; the new capture is a string before serialization.
  assert.notEqual(value.canonical,value.canonicalAgain)
})

test('the actual Node owner matches a second OS query with the driver UTC ISO representation, without terminating a process', {skip:process.platform!=='win32'},()=>{
  const capture=`Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}' | Select-Object ProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`
  const identity=JSON.parse(powershell(capture))
  assert.equal(identity.ProcessId,process.pid)
  const same=JSON.parse(powershell(`$owned=Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}'
@{same=($owned.CreationDate.ToUniversalTime().ToString('o') -ceq ${literal(identity.CreationDate)});wrong=($owned.CreationDate.ToUniversalTime().ToString('o') -ceq '2000-01-01T00:00:00.0000000Z')}|ConvertTo-Json -Compress`))
  assert.equal(same.same,true);assert.equal(same.wrong,false)
  for(const name of ['../r2-customer-history.acceptance.mjs','../r2-state-observation-cold.acceptance.mjs']){
    const source=fs.readFileSync(new URL(name,import.meta.url),'utf8')
    assert.ok(source.includes("CreationDate.ToUniversalTime().ToString('o')"))
    assert.equal(source.includes('ConvertTo-Json -Compress | ConvertFrom-Json'),false)
  }
})
