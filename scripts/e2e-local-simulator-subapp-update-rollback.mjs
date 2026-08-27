import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  createSubappManager,
  verifyInstalledSubappStartup,
} = require('../electron/subapp-manager.js');

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const blocklyRoot = path.resolve(scriptRoot, '..');
const simulatorRoot = path.resolve(
  process.env.AILY_SIMULATOR_REPOSITORY_ROOT
    || path.join(blocklyRoot, '..', 'aily-simulator'),
);
const packageName = '@aily-project/aily-simulator';
const baseVersion = '0.1.0';
const candidateVersion = '0.1.1';
const indexUrl = 'https://subapps.example.invalid/subapp-index.json';
const registryOrigin = 'https://registry.example.invalid';
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-simulator-update-rollback-'));
const sourceBundle = path.join(temporaryRoot, 'source-bundle');
const candidateRoot = path.join(temporaryRoot, 'candidate');
const tarballRoot = path.join(temporaryRoot, 'tarballs');
const installRoot = path.join(temporaryRoot, 'install-root');

try {
  const entitlementConfigPath = path.join(temporaryRoot, 'entitlement-trust.json');
  await writeFile(
    entitlementConfigPath,
    `${JSON.stringify(createEntitlementConfig(), null, 2)}\n`,
    'utf8',
  );
  await run(process.execPath, [
    path.join(simulatorRoot, 'scripts', 'package-aily-simulator-runtime.mjs'),
    '--entitlement-config',
    entitlementConfigPath,
    '--output',
    sourceBundle,
  ], simulatorRoot);
  assert.equal(existsSync(sourceBundle), true, 'Packaged Simulator Runtime is missing.');
  await cp(sourceBundle, candidateRoot, { recursive: true });
  await mkdir(tarballRoot, { recursive: true });
  await patchCandidate(candidateRoot, baseVersion, { invalidEntitlement: false });
  await verifyBundle(candidateRoot);
  const baseEntitlementSha256 = await sha256(
    path.join(candidateRoot, 'config', 'entitlement-trust.json'),
  );
  const baseTarball = await packCandidate(candidateRoot, tarballRoot);

  await patchCandidate(candidateRoot, candidateVersion, { invalidEntitlement: true });
  await verifyBundle(candidateRoot);
  const candidateEntitlementSha256 = await sha256(
    path.join(candidateRoot, 'config', 'entitlement-trust.json'),
  );
  const candidateTarball = await packCandidate(candidateRoot, tarballRoot);
  const releaseSigningKeys = generateKeyPairSync('ed25519');
  const releases = new Map([
    [baseVersion, await createSignedRelease(
      baseVersion,
      baseTarball,
      baseEntitlementSha256,
      releaseSigningKeys.privateKey,
    )],
    [candidateVersion, await createSignedRelease(
      candidateVersion,
      candidateTarball,
      candidateEntitlementSha256,
      releaseSigningKeys.privateKey,
    )],
  ]);

  let catalogVersion = baseVersion;
  let runtimeInUse = false;
  const healthPhases = [];
  const mutationGuards = [];
  const downloadObservations = [];
  let tamperNextDownload = true;
  let npmInstallCalls = 0;
  const manager = createSubappManager({
    rootDir: installRoot,
    indexUrl,
    releaseTrustPolicies: [createReleaseTrustPolicy(releaseSigningKeys.publicKey)],
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(simulatorIndex(catalogVersion, releases)),
    }),
    downloadFile: async (url, destination, onProgress) => {
      const release = [...releases.values()].find((item) => item.tarballUrl === url);
      assert.ok(release, `Unknown signed release URL: ${url}`);
      downloadObservations.push({
        version: release.version,
        installedPackagePresent: existsSync(packagePathForInstall(installRoot)),
        tampered: tamperNextDownload,
      });
      await cp(release.tarballPath, destination);
      if (tamperNextDownload) {
        await writeFile(destination, Buffer.concat([
          await readFile(destination),
          Buffer.from('tampered'),
        ]));
        tamperNextDownload = false;
      }
      onProgress?.(100);
    },
    runNpm: createLocalTarballNpmRunner(installRoot, () => {
      npmInstallCalls += 1;
    }),
    beforePackageMutation: async (context) => {
      mutationGuards.push({
        action: context.action,
        id: context.id,
        toolId: context.toolId,
        runtimeInUse,
      });
      if (runtimeInUse) {
        const error = new Error('Simulator is still owned by an active surface.');
        error.code = 'SUBAPP_UPDATE_IN_USE';
        throw error;
      }
    },
    verifyInstalledPackage: async (context) => {
      healthPhases.push({
        phase: context.phase,
        version: context.installedState.installedVersion,
      });
      return await verifyInstalledSubappStartup(context);
    },
  });

  await assert.rejects(
    manager.install({ id: 'aily-simulator', locale: 'en' }),
    (error) => error?.code === 'SUBAPP_RELEASE_TRUST_FAILED',
  );
  assert.equal(npmInstallCalls, 0);
  assert.equal(existsSync(packagePathForInstall(installRoot)), false);

  const installed = await manager.install({ id: 'aily-simulator', locale: 'en' });
  assert.equal(installed.apps[0].installedVersion, baseVersion);
  const installedPackageRoot = installed.apps[0].installPath;
  assert.equal((await lstat(installedPackageRoot)).isSymbolicLink(), false);
  await verifyInstalledSubappStartup({
    packagePath: installedPackageRoot,
    entry: { package: packageName },
    phase: 'base-installed',
  });
  const packageJsonBefore = await readFile(path.join(installRoot, 'package.json'));
  const packageLockBefore = await readFile(path.join(installRoot, 'package-lock.json'));
  const baseIndexSha256 = await sha256(path.join(installedPackageRoot, 'index.js'));

  catalogVersion = candidateVersion;
  await manager.list({ refresh: true, locale: 'en' });
  runtimeInUse = true;
  await assert.rejects(
    manager.update({ id: 'aily-simulator', locale: 'en' }),
    (error) => error?.code === 'SUBAPP_UPDATE_IN_USE',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(installedPackageRoot, 'package.json'), 'utf8')).version,
    baseVersion,
  );

  runtimeInUse = false;
  tamperNextDownload = true;
  await assert.rejects(
    manager.update({ id: 'aily-simulator', locale: 'en' }),
    (error) => error?.code === 'SUBAPP_RELEASE_TRUST_FAILED',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(installedPackageRoot, 'package.json'), 'utf8')).version,
    baseVersion,
  );
  assert.deepEqual(await readFile(path.join(installRoot, 'package.json')), packageJsonBefore);
  assert.deepEqual(await readFile(path.join(installRoot, 'package-lock.json')), packageLockBefore);

  tamperNextDownload = false;
  await assert.rejects(
    manager.update({ id: 'aily-simulator', locale: 'en' }),
    /entitlement configuration is invalid/i,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(installedPackageRoot, 'package.json'), 'utf8')).version,
    baseVersion,
  );
  assert.deepEqual(await readFile(path.join(installRoot, 'package.json')), packageJsonBefore);
  assert.deepEqual(await readFile(path.join(installRoot, 'package-lock.json')), packageLockBefore);
  assert.equal(await sha256(path.join(installedPackageRoot, 'index.js')), baseIndexSha256);
  assert.equal(
    (await readdir(installRoot)).some((name) => name.startsWith('.subapp-update-')),
    false,
  );
  await verifyInstalledSubappStartup({
    packagePath: installedPackageRoot,
    entry: { package: packageName },
    phase: 'rollback-final',
  });
  const finalState = await manager.list({ refresh: false, locale: 'en' });
  assert.equal(finalState.apps[0].installedVersion, baseVersion);
  assert.equal(finalState.apps[0].updateAvailable, true);
  assert.deepEqual(healthPhases, [
    { phase: 'candidate', version: candidateVersion },
    { phase: 'restored', version: baseVersion },
  ]);
  assert.deepEqual(
    mutationGuards.map(({ runtimeInUse: value }) => value),
    [true, false, false],
  );
  assert.ok(mutationGuards.every(({ toolId }) => toolId === 'simulator'));
  assert.equal(
    downloadObservations.find((item) => (
      item.version === candidateVersion && item.tampered
    ))?.installedPackagePresent,
    true,
    'signed update must be downloaded and rejected before the installed package is moved',
  );

  console.log(JSON.stringify({
    status: 'passed',
    packageName,
    baseVersion,
    candidateVersion,
    localTarballs: 2,
    realNpmInstall: true,
    signedIndexEntryVerifiedBeforeNpm: true,
    tamperedInitialInstallRejectedBeforeNpm: true,
    tamperedUpdateRejectedBeforePackageMutation: true,
    runningUpdateRejectedBeforeNpm: true,
    candidateStaticBundleVerified: true,
    candidateStartupFailedClosed: true,
    packageDirectoryRestored: true,
    npmMetadataRestoredByteExact: true,
    restoredPackageStartupHealthy: true,
    updateStagingRemoved: true,
  }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function patchCandidate(root, version, { invalidEntitlement }) {
  const packageJsonPath = path.join(root, 'package.json');
  const runtimeManifestPath = path.join(root, 'aily-simulator-runtime.json');
  const entitlementPath = path.join(root, 'config', 'entitlement-trust.json');
  const packageManifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
  assert.equal(packageManifest.name, packageName);
  packageManifest.version = version;
  await writeFile(packageJsonPath, `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8');
  if (invalidEntitlement) {
    await writeFile(
      entitlementPath,
      '{"schemaVersion":999,"kind":"invalid-update-candidate"}\n',
      'utf8',
    );
  }
  runtimeManifest.packageVersion = version;
  await refreshManifestFile(runtimeManifest, root, 'package.json');
  await refreshManifestFile(runtimeManifest, root, 'config/entitlement-trust.json');
  await writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, 'utf8');
}

async function refreshManifestFile(manifest, root, relativePath) {
  const filePath = path.join(root, ...relativePath.split('/'));
  const content = await readFile(filePath);
  manifest.files[relativePath] = {
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function verifyBundle(root) {
  await run(process.execPath, [
    path.join(simulatorRoot, 'scripts', 'package-aily-simulator-runtime.mjs'),
    '--verify',
    root,
  ], simulatorRoot);
}

async function packCandidate(root, destination) {
  const output = await captureNpm([
    'pack',
    root,
    '--json',
    '--pack-destination',
    destination,
  ], blocklyRoot);
  const result = JSON.parse(output);
  assert.equal(result.length, 1);
  const tarballPath = path.join(destination, result[0].filename);
  assert.equal(existsSync(tarballPath), true);
  return tarballPath;
}

function simulatorIndex(version, releases) {
  const release = releases.get(version);
  assert.ok(release, `Missing signed release ${version}`);
  return {
    'aily-simulator': {
      id: 'aily-simulator',
      titleKey: 'AILY_SIMULATOR.TITLE',
      namespace: 'AILY_SIMULATOR',
      package: packageName,
      version,
      distribution: release.distribution,
      app: {
        name: 'Aily Simulator',
        description: 'Local update/rollback fixture',
        enabled: true,
      },
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: { TITLE: 'Aily Simulator', DESCRIPTION: 'Simulator' },
        },
      },
    },
  };
}

function createEntitlementConfig() {
  const leaseKeys = generateKeyPairSync('ed25519');
  const revocationKeys = generateKeyPairSync('ed25519');
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-production-entitlement-config',
    refreshEndpoint: 'https://api.example.test/v1/simulator/entitlements/refresh',
    credentialService: 'pro.aily.simulator.update-rollback-test',
    credentialAccount: 'refresh-v1',
    leasePublicKeys: {
      'lease-update-test-1': leaseKeys.publicKey.export({
        format: 'pem',
        type: 'spki',
      }).toString(),
    },
    revocationPublicKeys: {
      'revocation-update-test-1': revocationKeys.publicKey.export({
        format: 'pem',
        type: 'spki',
      }).toString(),
    },
    bundledCapabilities: { 'simulation.basic': true },
    runtimeCapabilities: { 'simulation.basic': true },
  };
}

function createLocalTarballNpmRunner(cwd, onInstall) {
  return async (args) => {
    if (args[0] === 'view') throw new Error('Signed releases must not call npm view.');
    if (args[0] === 'install') onInstall?.();
    return await captureNpmResult(args, cwd);
  };
}

async function createSignedRelease(
  version,
  tarballPath,
  entitlementConfigSha256,
  privateKey,
) {
  const tarballIntegrity = await sha512Integrity(tarballPath);
  const tarballUrl = `${registryOrigin}/@aily-project/aily-simulator/-/aily-simulator-${version}.tgz`;
  const statement = {
    schemaVersion: 1,
    kind: 'aily-subapp-release-statement',
    subappId: 'aily-simulator',
    packageName,
    packageVersion: version,
    platform: 'win32-x64',
    registryOrigin,
    tarballUrl,
    tarballIntegrity,
    subappIndexOrigin: 'https://subapps.example.invalid',
    channel: 'stable',
    metadata: { entitlementConfigSha256 },
  };
  const payloadBase64Url = Buffer.from(JSON.stringify(statement), 'utf8')
    .toString('base64url');
  const signatureBase64Url = sign(
    null,
    Buffer.from(`aily-subapp-release-statement:v1.${payloadBase64Url}`, 'ascii'),
    privateKey,
  ).toString('base64url');
  return {
    version,
    tarballPath,
    tarballUrl,
    distribution: {
      schemaVersion: 1,
      channel: 'stable',
      platform: 'win32-x64',
      tarballUrl,
      tarballIntegrity,
      releaseSignature: {
        schemaVersion: 1,
        kind: 'aily-subapp-release-signature',
        algorithm: 'Ed25519',
        keyId: 'local-e2e-release-v1',
        payloadBase64Url,
        signatureBase64Url,
      },
    },
  };
}

function createReleaseTrustPolicy(publicKey) {
  return {
    schemaVersion: 1,
    kind: 'aily-subapp-release-trusted-inputs',
    subappId: 'aily-simulator',
    packageName,
    platform: 'win32-x64',
    registryOrigin,
    subappIndexOrigin: 'https://subapps.example.invalid',
    releasePublicKeys: {
      'local-e2e-release-v1': publicKey.export({
        format: 'pem',
        type: 'spki',
      }).toString(),
    },
  };
}

function packagePathForInstall(rootDir) {
  return path.join(rootDir, 'node_modules', '@aily-project', 'aily-simulator');
}

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error('npm_execpath is required for the local update/rollback E2E.');
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

async function captureNpm(args, cwd) {
  const result = await captureNpmResult(args, cwd);
  return result.stdout;
}

function captureNpmResult(args, cwd) {
  const invocation = npmInvocation(args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`npm ${args[0]} failed: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function sha512Integrity(filePath) {
  return `sha512-${createHash('sha512').update(await readFile(filePath)).digest('base64')}`;
}
