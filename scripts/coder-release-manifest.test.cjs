const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const asar = require('@electron/asar');
const yaml = require('js-yaml');
const { releaseFiles, writeManifest, verifyManifest } = require('./coder-release-manifest.cjs');

async function fixture(t, platform, flavor, version = '0.1.7') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-manifest-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'app');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    version, ailyBuildProduct: 'coder', ailyBuildFlavor: flavor,
  }));
  const names = releaseFiles(platform, flavor, version);
  const archives = [];
  for (const name of names.packages) {
    const archive = path.join(directory, `${name}.asar`);
    await asar.createPackage(source, archive);
    archives.push(archive);
  }
  for (const name of names.packages) fs.writeFileSync(path.join(directory, name), `final signed ${name}`);
  await writeManifest(directory, platform, flavor, version, ...archives);
  return { directory, archives, names };
}

test('four platform/flavor manifests reference complete final artifacts, including Beta versions', async t => {
  const manifestNames = {
    windows: { cn: 'latest-coder-cn.yml', global: 'latest-coder.yml' },
    macos: { cn: 'latest-coder-mac-cn.yml', global: 'latest-coder-mac.yml' },
  };
  for (const platform of ['windows', 'macos']) {
    for (const flavor of ['cn', 'global']) {
      const version = '0.1.7-beta.1';
      const { directory, names } = await fixture(t, platform, flavor, version);
      const manifest = await verifyManifest(directory, platform, flavor, version);
      assert.deepEqual(manifest.files.map(file => file.url), names.packages);
      assert.equal(names.manifest, manifestNames[platform][flavor]);
      assert.ok(manifest.files.every(file => Buffer.from(file.sha512, 'base64').length === 64));
      const text = fs.readFileSync(path.join(directory, names.manifest), 'utf8');
      assert.deepEqual([...text.matchAll(/^[ \t]*sha512:[ \t]*(.+)$/gm)].map(match => match[1].trim()),
        [...manifest.files.map(file => file.sha512), manifest.sha512]);
    }
  }
});

test('rejects changed final bytes, missing payloads and renamed manifest entries', async t => {
  const { directory, names, archives } = await fixture(t, 'macos', 'cn');
  const zip = path.join(directory, names.packages[0]);
  fs.appendFileSync(zip, 'changed after notarization');
  await assert.rejects(verifyManifest(directory, 'macos', 'cn', '0.1.7'), /mismatch/);
  await writeManifest(directory, 'macos', 'cn', '0.1.7', ...archives);
  const manifestPath = path.join(directory, names.manifest);
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files[0].url = '../old.zip';
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  await assert.rejects(verifyManifest(directory, 'macos', 'cn', '0.1.7'), /mismatch/);
  fs.unlinkSync(zip);
  await assert.rejects(writeManifest(directory, 'macos', 'cn', '0.1.7', ...archives), /ENOENT/);
});

test('rejects a release version/flavor that differs from embedded package metadata', async t => {
  const { directory, archives } = await fixture(t, 'windows', 'cn');
  await assert.rejects(writeManifest(directory, 'windows', 'cn', '0.1.8', ...archives), /Embedded/);
  await assert.rejects(writeManifest(directory, 'windows', 'global', '0.1.7', ...archives), /Embedded/);
  const manifestPath = path.join(directory, 'latest-coder-cn.yml');
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = '0.1.6';
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  await assert.rejects(verifyManifest(directory, 'windows', 'cn', '0.1.7'), /Invalid version/);
});

test('macOS requires final metadata from both ZIP and DMG before writing the manifest', async t => {
  const { directory, archives, names } = await fixture(t, 'macos', 'cn');
  const manifestPath = path.join(directory, names.manifest);
  const originalManifest = fs.readFileSync(manifestPath, 'utf8');
  await assert.rejects(writeManifest(directory, 'macos', 'cn', '0.1.7', archives[0]), /each release package/);
  const wrongFlavor = await fixture(t, 'macos', 'global');
  await assert.rejects(writeManifest(directory, 'macos', 'cn', '0.1.7', archives[0], wrongFlavor.archives[1]), /Embedded/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), originalManifest);
});
