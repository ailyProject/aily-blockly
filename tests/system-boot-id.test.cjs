'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const test = require('node:test');
const filename = require.resolve('../child/scripts/system-boot-id');
const uuid = '11111111-1111-4111-8111-111111111111';

for (const platform of ['darwin', 'linux', 'win32']) {
  for (const response of [uuid, '', '00000000-0000-0000-0000-000000000000', new Error('denied')]) {
    test(`${platform} kernel identity is cached and invalid queries remain unknown (${String(response)})`, () => {
      let calls = 0;
      const read = () => { calls++; if (response instanceof Error) throw response; return response; };
      const local = createRequire(filename);
      const context = { module: { exports: {} }, process: { platform, env: { SystemRoot: 'C:\\Windows' } },
        require: name => name === 'node:fs' ? { readFileSync: read } : name === 'node:child_process' ? {
          execFileSync: (command, args, options) => {
            assert.equal(options.windowsHide, true); assert.ok(options.timeout <= 3000);
            assert.equal(options.shell, undefined);
            if (platform === 'win32') {
              assert.ok(args.includes('-NoProfile')); assert.ok(args.includes('-NonInteractive'));
              assert.match(args.at(-1), /NtQuerySystemInformation\(90/);
            }
            return read();
          },
        } : local(name),
      };
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
      const { getSystemBootId, isSystemBootId } = context.module.exports;
      const expected = response === uuid ? `${platform}:${uuid}` : null;
      assert.equal(getSystemBootId(), expected); assert.equal(getSystemBootId(), expected);
      assert.equal(calls, 1);
      assert.equal(isSystemBootId(`${platform}:00000000-0000-0000-0000-000000000000`), false);
    });
  }
}

test('independent processes read the same actual kernel boot identity', () => {
  const { getSystemBootId, isSystemBootId } = require(filename);
  const current = getSystemBootId();
  const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).getSystemBootId()))', filename],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), current);
  if (current !== null) assert.equal(isSystemBootId(current), true);
});
