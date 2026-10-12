const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const semver = require('semver');
const asar = require('@electron/asar');

function releaseFiles(platform, flavor, version) {
  if (!['windows', 'macos'].includes(platform) || !['cn', 'global'].includes(flavor) || semver.valid(version) !== version) {
    throw new Error('Expected windows/macos, cn/global and a complete SemVer version');
  }
  const prefix = flavor === 'cn' ? 'aily-coder-CN' : 'aily-coder';
  return {
    manifest: `latest-coder${platform === 'macos' ? '-mac' : ''}${flavor === 'cn' ? '-cn' : ''}.yml`,
    packages: platform === 'windows'
      ? [`${prefix}-Setup-${version}.exe`]
      : [`${prefix}-macos-${version}-arm64.zip`, `${prefix}-macos-${version}-arm64.dmg`],
  };
}

async function fileInfo(directory, name) {
  const filename = path.join(directory, name);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty release file: ${name}`);
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return { url: name, sha512: hash.digest('base64'), size: stat.size };
}

async function writeManifest(directory, platform, flavor, version, ...archives) {
  const names = releaseFiles(platform, flavor, version);
  if (archives.length !== names.packages.length) {
    throw new Error(`Expected one final app.asar for each release package: ${names.packages.join(', ')}`);
  }
  for (const archive of archives) {
    const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
    if (metadata.version !== version || metadata.ailyBuildProduct !== 'coder' || metadata.ailyBuildFlavor !== flavor) {
      throw new Error(`Embedded Coder version/product/flavor does not match the release: ${archive}`);
    }
  }
  const files = await Promise.all(names.packages.map(name => fileInfo(directory, name)));
  const manifest = {
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: new Date().toISOString(),
  };
  // The server sync scripts read SHA512 values from the same line as the key.
  fs.writeFileSync(path.join(directory, names.manifest), yaml.dump(manifest, { lineWidth: -1 }));
  await verifyManifest(directory, platform, flavor, version);
}

async function verifyManifest(directory, platform, flavor, version) {
  const names = releaseFiles(platform, flavor, version);
  const manifest = yaml.load(fs.readFileSync(path.join(directory, names.manifest), 'utf8'));
  if (manifest?.version !== version || !Array.isArray(manifest.files) || manifest.files.length !== names.packages.length) {
    throw new Error(`Invalid version or file list in ${names.manifest}`);
  }
  for (const [index, name] of names.packages.entries()) {
    const expected = await fileInfo(directory, name);
    const actual = manifest.files[index];
    if (actual?.url !== name || actual.sha512 !== expected.sha512 || actual.size !== expected.size) {
      throw new Error(`Filename, SHA512 or size mismatch: ${name}`);
    }
  }
  if (manifest.path !== manifest.files[0].url || manifest.sha512 !== manifest.files[0].sha512) {
    throw new Error(`Legacy path/SHA512 mismatch in ${names.manifest}`);
  }
  return manifest;
}

if (require.main === module) {
  const [command, directory, platform, flavor, version, ...archives] = process.argv.slice(2);
  const operation = command === 'write' ? writeManifest : command === 'verify' ? verifyManifest : null;
  if (!operation) {
    console.error('Usage: coder-release-manifest.cjs write|verify directory windows|macos cn|global version [final-app.asar ...]');
    process.exitCode = 1;
  } else {
    operation(directory, platform, flavor, version, ...archives).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { releaseFiles, writeManifest, verifyManifest };
