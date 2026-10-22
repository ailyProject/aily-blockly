const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { resolveSubappRoot } = require('../subapp-manager');

test('an explicitly configured Subapp installation keeps the SDK prefix independent', () => {
  assert.equal(resolveSubappRoot({ platform: 'win32', env: {
    AILY_NPM_PREFIX: 'C:\\installed\\sdk', AILY_SUBAPP_INSTALL_ROOT: 'D:\\candidate\\apps',
  } }), 'D:\\candidate\\apps');
  assert.equal(resolveSubappRoot({ platform: 'linux', env: {
    AILY_NPM_PREFIX: '/installed/sdk', AILY_SUBAPP_INSTALL_ROOT: '/candidate/apps',
  } }), '/candidate/apps');
});

test('a manager-specific root takes precedence over process configuration', () => {
  const rootDir = path.resolve('manager-owned-apps');
  assert.equal(resolveSubappRoot({ rootDir, env: { AILY_SUBAPP_INSTALL_ROOT: '/other/apps' } }), rootDir);
});

test('the default installed layout remains prefix/app without an override', () => {
  assert.equal(resolveSubappRoot({ platform: 'win32', env: { AILY_NPM_PREFIX: 'C:\\installed\\sdk' } }),
    'C:\\installed\\sdk\\app');
  assert.equal(resolveSubappRoot({ platform: 'linux', env: { AILY_NPM_PREFIX: '/installed/sdk' } }),
    '/installed/sdk/app');
});
