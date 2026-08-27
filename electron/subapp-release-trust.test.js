const assert = require('node:assert/strict');
const {
  createHash,
  generateKeyPairSync,
  sign,
} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSubappManager } = require('./subapp-manager');
const {
  SUBAPP_RELEASE_SIGNATURE_CONTEXT,
  normalizeSubappReleaseTrustPolicies,
  requiresTrustedSubappDistribution,
  validateSubappDistribution,
  verifyDownloadedSubappDistribution,
} = require('./subapp-release-trust');

const INDEX_URL = 'https://subapps.example.invalid/subapp-index.json';
const REGISTRY_ORIGIN = 'https://registry.example.invalid';

test('leaves unsigned development entries compatible when no trust policy applies', () => {
  assert.equal(requiresTrustedSubappDistribution(
    { id: 'local-tool', package: '@aily-project/local-tool' },
    'http://127.0.0.1:9000/subapp-index.json',
    [],
  ), false);
});

test('verifies the generic signed Subapp entry against exact downloaded bytes', async (t) => {
  const fixture = createSignedFixture(t);
  const policies = normalizeSubappReleaseTrustPolicies([fixture.policy]);
  const result = await verifyDownloadedSubappDistribution({
    entry: fixture.entry,
    indexUrl: INDEX_URL,
    policies,
    tarballPath: fixture.tarballPath,
  });

  assert.equal(result.verified, true);
  assert.equal(result.packageName, '@aily-project/aily-simulator');
  assert.equal(result.signingKeyId, 'fixture-release-v1');
  assert.equal(result.tarballIntegrity, fixture.tarballIntegrity);
  assert.equal(Object.isFrozen(result), true);
});

test('manager verifies a signed tarball before npm and never falls back on tampering', async (t) => {
  const fixture = createSignedFixture(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-signed-install-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let npmCalls = 0;
  let tamperDownload = true;
  const manager = createSubappManager({
    rootDir,
    indexUrl: INDEX_URL,
    releaseTrustPolicies: [fixture.policy],
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ 'aily-simulator': fixture.entry }),
    }),
    downloadFile: async (_url, destination) => {
      fs.copyFileSync(fixture.tarballPath, destination);
      if (tamperDownload) fs.appendFileSync(destination, 'tampered');
    },
    runNpm: async (args) => {
      npmCalls += 1;
      assert.equal(args[0], 'install');
      assert.ok(args.at(-1).endsWith('package.tgz'));
      writeInstalledPackage(rootDir, fixture.entry);
      return { code: 0, stdout: 'installed', stderr: '' };
    },
  });

  await assert.rejects(
    manager.install({ id: 'aily-simulator', locale: 'en' }),
    (error) => error?.code === 'SUBAPP_RELEASE_TRUST_FAILED',
  );
  assert.equal(npmCalls, 0, 'tampered download must not reach npm fallback');

  tamperDownload = false;
  const installed = await manager.install({ id: 'aily-simulator', locale: 'en' });
  assert.equal(npmCalls, 1);
  assert.equal(installed.apps[0].installedVersion, '0.1.0');
});

test('manager rejects stripped or untrusted signed distribution metadata before npm', async (t) => {
  const fixture = createSignedFixture(t);
  for (const testCase of [
    {
      name: 'stripped distribution',
      entry: { ...fixture.entry, distribution: undefined },
      policies: [fixture.policy],
    },
    {
      name: 'untrusted signature policy',
      entry: fixture.entry,
      policies: [],
    },
  ]) {
    await t.test(testCase.name, async (nested) => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-signed-strip-'));
      nested.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
      const entry = JSON.parse(JSON.stringify(testCase.entry));
      if (entry.distribution === undefined) delete entry.distribution;
      let npmCalls = 0;
      let downloads = 0;
      const manager = createSubappManager({
        rootDir,
        indexUrl: INDEX_URL,
        releaseTrustPolicies: testCase.policies,
        fetchImpl: async () => ({
          ok: true,
          text: async () => JSON.stringify({ 'aily-simulator': entry }),
        }),
        downloadFile: async () => { downloads += 1; },
        runNpm: async () => {
          npmCalls += 1;
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      await assert.rejects(
        manager.install({ id: 'aily-simulator', locale: 'en' }),
        (error) => error?.code === 'SUBAPP_RELEASE_TRUST_FAILED',
      );
      assert.equal(downloads, 0);
      assert.equal(npmCalls, 0);
    });
  }
});

function createSignedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-release-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tarballPath = path.join(root, 'aily-simulator-0.1.0.tgz');
  fs.writeFileSync(tarballPath, 'deterministic signed Subapp tarball\n');
  const tarballIntegrity = `sha512-${createHash('sha512')
    .update(fs.readFileSync(tarballPath))
    .digest('base64')}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const tarballUrl = `${REGISTRY_ORIGIN}/@aily-project/aily-simulator/-/aily-simulator-0.1.0.tgz`;
  const statement = {
    schemaVersion: 1,
    kind: 'aily-subapp-release-statement',
    subappId: 'aily-simulator',
    packageName: '@aily-project/aily-simulator',
    packageVersion: '0.1.0',
    platform: 'win32-x64',
    registryOrigin: REGISTRY_ORIGIN,
    tarballUrl,
    tarballIntegrity,
    subappIndexOrigin: 'https://subapps.example.invalid',
    channel: 'stable',
    metadata: {
      entitlementConfigSha256: '0'.repeat(64),
    },
  };
  const payloadBase64Url = Buffer.from(JSON.stringify(statement), 'utf8')
    .toString('base64url');
  const signature = {
    schemaVersion: 1,
    kind: 'aily-subapp-release-signature',
    algorithm: 'Ed25519',
    keyId: 'fixture-release-v1',
    payloadBase64Url,
    signatureBase64Url: sign(
      null,
      Buffer.from(`${SUBAPP_RELEASE_SIGNATURE_CONTEXT}.${payloadBase64Url}`, 'ascii'),
      privateKey,
    ).toString('base64url'),
  };
  const distribution = validateSubappDistribution({
    schemaVersion: 1,
    channel: 'stable',
    platform: 'win32-x64',
    tarballUrl,
    tarballIntegrity,
    releaseSignature: signature,
  });
  return {
    tarballPath,
    tarballIntegrity,
    entry: {
      id: 'aily-simulator',
      titleKey: 'AILY_SIMULATOR.TITLE',
      namespace: 'AILY_SIMULATOR',
      package: '@aily-project/aily-simulator',
      version: '0.1.0',
      app: {
        name: 'Aily Simulator',
        description: 'Signed Subapp fixture',
        enabled: true,
      },
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: { TITLE: 'Aily Simulator', DESCRIPTION: 'Simulator' },
        },
      },
      distribution,
    },
    policy: {
      schemaVersion: 1,
      kind: 'aily-subapp-release-trusted-inputs',
      subappId: 'aily-simulator',
      packageName: '@aily-project/aily-simulator',
      platform: 'win32-x64',
      registryOrigin: REGISTRY_ORIGIN,
      subappIndexOrigin: 'https://subapps.example.invalid',
      releasePublicKeys: {
        'fixture-release-v1': publicKey.export({
          format: 'pem',
          type: 'spki',
        }).toString(),
      },
    },
  };
}

function writeInstalledPackage(rootDir, entry) {
  const packageDir = path.join(
    rootDir,
    'node_modules',
    '@aily-project',
    'aily-simulator',
  );
  fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'index.js'), '');
  fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: entry.package,
    version: entry.version,
    main: 'index.js',
  }));
}
