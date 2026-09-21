const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { selection, cases } = require('./abs-final-library-cases.cjs');

test('final acceptance uses the fixed random selection, without replacement of failed libraries', () => {
  const rank = name => createHash('sha256').update(selection.seed + ':' + name).digest('hex');
  for (const [kind, pool] of Object.entries(selection.pools)) {
    assert.deepEqual([...pool].sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, kind === 'dynamic' ? 5 : 2), selection.selected[kind]);
  }
  assert.deepEqual(cases.map(fixture => fixture.library), Object.values(selection.selected).flat());
  assert.equal(new Set(cases.map(fixture => fixture.library)).size, 7);
});

test('each selected library has new/edit/re-edit checks, declared root identities and code expectations', () => {
  for (const fixture of cases) {
    assert.equal(fixture.rounds.length, 3, fixture.library);
    assert.ok(fixture.types.length);
    for (const round of fixture.rounds) {
      assert.equal(round.calls.length, fixture.types.length, fixture.library);
      if (round.instances) assert.equal(round.instances.length, round.calls.length, fixture.library);
      round.calls.forEach((call, index) => assert.ok(call.startsWith(fixture.types[index] + '('), call));
      assert.ok(round.code);
    }
    assert.notDeepEqual(fixture.rounds[0].calls, fixture.rounds[1].calls);
    assert.notDeepEqual(fixture.rounds[1].calls, fixture.rounds[2].calls);
  }
});
