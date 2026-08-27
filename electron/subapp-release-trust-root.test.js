const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_SUBAPP_RELEASE_TRUST_ROOT_BYTES,
  SubappReleaseTrustRootError,
  loadBundledSubappReleaseTrustRoot,
  loadSubappReleaseTrustRoot,
  resolveBundledSubappReleaseTrustRootPath,
} = require('./subapp-release-trust-root');

function createTemporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-trust-root-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validPolicy() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    schemaVersion: 1,
    kind: 'aily-subapp-release-trusted-inputs',
    subappId: 'fixture-subapp',
    packageName: '@aily-project/fixture-subapp',
    platform: 'win32-x64',
    registryOrigin: 'https://registry.fixture.invalid',
    subappIndexOrigin: 'https://index.fixture.invalid',
    releasePublicKeys: {
      'fixture-release-2026': publicKey.export({ type: 'spki', format: 'pem' }),
    },
  };
}

test('loads the checked-in host trust root from the fixed module resource path', () => {
  const expectedPath = path.join(
    __dirname,
    'resources',
    'subapp-release-trust-root.json',
  );
  assert.equal(resolveBundledSubappReleaseTrustRootPath(__dirname), expectedPath);
  const root = loadBundledSubappReleaseTrustRoot();
  assert.equal(root.schemaVersion, 1);
  assert.equal(root.kind, 'aily-subapp-release-trust-root');
  assert.deepEqual(root.policies, []);
  assert.equal(Object.isFrozen(root), true);
  assert.equal(Object.isFrozen(root.policies), true);
});

test('normalizes and freezes public policies supplied by an explicit test fixture', (t) => {
  const directory = createTemporaryDirectory(t);
  const filePath = path.join(directory, 'trust-root.json');
  writeJson(filePath, {
    schemaVersion: 1,
    kind: 'aily-subapp-release-trust-root',
    policies: [validPolicy()],
  });

  const root = loadBundledSubappReleaseTrustRoot({ filePath });
  assert.equal(root.policies.length, 1);
  assert.equal(root.policies[0].subappId, 'fixture-subapp');
  assert.equal(Object.isFrozen(root.policies[0]), true);
  assert.equal(Object.isFrozen(root.policies[0].releasePublicKeys), true);
});

test('rejects a missing, malformed, unknown-field, or oversized trust root', (t) => {
  const directory = createTemporaryDirectory(t);
  const missingPath = path.join(directory, 'missing.json');
  assert.throws(
    () => loadSubappReleaseTrustRoot(missingPath),
    (error) => error instanceof SubappReleaseTrustRootError
      && error.code === 'SUBAPP_RELEASE_TRUST_ROOT_FAILED',
  );

  const malformedPath = path.join(directory, 'malformed.json');
  fs.writeFileSync(malformedPath, '{');
  assert.throws(() => loadSubappReleaseTrustRoot(malformedPath), SubappReleaseTrustRootError);

  const unknownFieldPath = path.join(directory, 'unknown.json');
  writeJson(unknownFieldPath, {
    schemaVersion: 1,
    kind: 'aily-subapp-release-trust-root',
    policies: [],
    publicKeyFromIndex: 'forbidden',
  });
  assert.throws(
    () => loadSubappReleaseTrustRoot(unknownFieldPath),
    SubappReleaseTrustRootError,
  );

  const oversizedPath = path.join(directory, 'oversized.json');
  fs.writeFileSync(
    oversizedPath,
    Buffer.alloc(MAX_SUBAPP_RELEASE_TRUST_ROOT_BYTES + 1, 0x20),
  );
  assert.throws(
    () => loadSubappReleaseTrustRoot(oversizedPath),
    SubappReleaseTrustRootError,
  );
});

test('rejects a symbolic-link trust root when the platform permits creating one', (t) => {
  const directory = createTemporaryDirectory(t);
  const targetPath = path.join(directory, 'target.json');
  const linkPath = path.join(directory, 'link.json');
  writeJson(targetPath, {
    schemaVersion: 1,
    kind: 'aily-subapp-release-trust-root',
    policies: [],
  });
  try {
    fs.symlinkSync(targetPath, linkPath, 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('File symlinks are not enabled on this Windows host.');
      return;
    }
    throw error;
  }
  assert.throws(() => loadSubappReleaseTrustRoot(linkPath), SubappReleaseTrustRootError);
});

test('Electron packaging includes the fixed trust root inside app.asar', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const electronFilesRule = manifest.build.files.find(
    (rule) => rule && typeof rule === 'object' && rule.from === 'electron',
  );
  assert.ok(electronFilesRule, 'electron build files rule is missing');
  assert.ok(electronFilesRule.filter.includes('**/*'));
  assert.equal(
    electronFilesRule.filter.some((rule) => rule.includes('resources')),
    false,
    'the fixed trust root must not be excluded from app.asar',
  );

  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(mainSource, /loadBundledSubappReleaseTrustRoot\(\)/);
  assert.match(
    mainSource,
    /releaseTrustPolicies:\s*subappReleaseTrustRoot\.policies/,
    'Electron Main must pass only host-bundled policies to the generic manager',
  );
});
