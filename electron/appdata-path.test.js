const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { resolveAilyAppDataPath, resolveAilyNpmPrefix } = require('./appdata-path');

const config = {
  appdata_path: {
    win32: '%HOMEPATH%\\AppData\\Local\\aily-project',
    darwin: '~/Library/aily-project',
    linux: '~/.config/aily-project',
  },
};

test('explicit AILY_APPDATA_PATH has priority over platform defaults', () => {
  const explicit = path.resolve('temporary-appdata');
  assert.equal(resolveAilyAppDataPath({
    env: { AILY_APPDATA_PATH: explicit },
    platform: 'win32',
    home: 'C:\\Users\\someone',
    config,
  }), explicit);
});

test('platform config is used only when no explicit path is provided', () => {
  assert.equal(resolveAilyAppDataPath({
    env: {},
    platform: 'win32',
    home: 'C:\\Users\\someone',
    config,
  }), path.resolve('C:\\Users\\someone\\AppData\\Local\\aily-project'));
});

test('main initializes the auth store under the explicitly selected data root', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf('  const buildProduct = getBuildProduct();', main.indexOf('function loadEnv('));
  const end = main.indexOf('  builder.configureCacheEnvironment();', start);
  assert.ok(start >= 0 && end > start);
  const explicit = path.resolve('isolated-main-appdata');
  const processStub = { env: { AILY_APPDATA_PATH: explicit }, platform: 'win32' };
  vm.runInNewContext(main.slice(start, end), {
    process: processStub, resolveAilyAppDataPath, conf: config,
    getBuildProduct: () => 'blockly', os: { homedir: () => 'C:\\Users\\someone' },
    isWin32: true, isDarwin: false,
  });
  assert.equal(processStub.env.AILY_APPDATA_PATH, explicit);
});

test('npm prefix preserves explicit macOS and Windows paths including spaces', () => {
  assert.equal(resolveAilyNpmPrefix({
    env: { AILY_NPM_PREFIX: '/Volumes/Aily Data/npm-global', AILY_APPDATA_PATH: '/Users/test/Library/aily-project' },
    platform: 'darwin',
  }), '/Volumes/Aily Data/npm-global');
  assert.equal(resolveAilyNpmPrefix({
    env: { AILY_NPM_PREFIX: 'D:\\Aily Data\\npm-global', AILY_APPDATA_PATH: 'C:\\Users\\test\\AppData\\Local\\aily-project' },
    platform: 'win32',
  }), 'D:\\Aily Data\\npm-global');
  assert.equal(resolveAilyNpmPrefix({
    env: { AILY_NPM_PREFIX: '\\\\server\\Aily Data\\npm-global' },
    platform: 'win32',
  }), '\\\\server\\Aily Data\\npm-global');
});

test('npm prefix still follows a custom appdata directory when no prefix is set', () => {
  assert.equal(resolveAilyNpmPrefix({
    env: { AILY_APPDATA_PATH: '/tmp/isolated-aily' },
    platform: 'darwin',
  }), '/tmp/isolated-aily/npm-global');
  assert.equal(resolveAilyNpmPrefix({
    env: { AILY_APPDATA_PATH: 'D:\\Portable Aily\\data' },
    platform: 'win32',
  }), 'D:\\Portable Aily\\data\\npm-global');
});
