const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseFiles, verifyManifest } = require('./coder-release-manifest.cjs');

async function digest(stream) {
  const hash = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha512: hash.digest('base64') };
}

async function verifyPublishedRelease(directory, version, [globalBaseUrl, cnBaseUrl]) {
  const globalFiles = new Map();
  const cnFiles = new Map();
  for (const platform of ['windows', 'macos']) {
    for (const flavor of ['cn', 'global']) {
      const manifest = await verifyManifest(directory, platform, flavor, version);
      for (const file of manifest.files) {
        globalFiles.set(file.url, file);
        if (flavor === 'cn') cnFiles.set(file.url, file);
      }
      const name = releaseFiles(platform, flavor, version).manifest;
      const info = await digest(fs.createReadStream(path.join(directory, name)));
      globalFiles.set(name, info);
      if (flavor === 'cn') cnFiles.set(releaseFiles(platform, 'global', version).manifest, info);
    }
  }
  for (const name of ['CHANGELOG_CODER.md', 'CHANGELOG_CODER_ZH.md']) {
    const info = await digest(fs.createReadStream(path.join(directory, name)));
    if (!info.size) throw new Error(`Missing or empty release file: ${name}`);
    globalFiles.set(name, info);
    cnFiles.set(name, info);
  }

  for (const [baseUrl, expected] of [[globalBaseUrl, globalFiles], [cnBaseUrl, cnFiles]]) {
    for (const [name, local] of expected) {
      const url = `${baseUrl.replace(/\/+$/, '')}/${name}`;
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Published file unavailable: ${url} (HTTP ${response.status})`);
      }
      const remote = await digest(response.body);
      if (remote.size !== local.size || remote.sha512 !== local.sha512) {
        throw new Error(`Published file size or SHA512 mismatch: ${url}`);
      }
    }
  }
}

if (require.main === module) {
  const [directory, version] = process.argv.slice(2);
  if (!directory || !version) {
    console.error('Usage: verify-coder-release.cjs release-directory version');
    process.exitCode = 1;
  } else {
    const config = require('../electron/config/config.json');
    verifyPublishedRelease(directory, version, [config.regions.eu.updater, config.regions.cn.updater])
      .then(() => console.log('Verified all Coder release files on Global and CN download sources.'))
      .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}

module.exports = { verifyPublishedRelease };
