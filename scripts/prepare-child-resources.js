const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { baseUrl, getChildResources, getPlatformResources } = require('../electron/child-resources');

const pendingCaches = new Map();

async function matchesHash(file, expected) {
  const hash = createHash('sha256');
  try {
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removePart(file) {
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function requestResource(url, redirects = 0) {
  if (url.protocol !== 'https:') throw new Error('Child resource downloads require HTTPS');
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 30_000 }, (response) => {
      clearTimeout(connectionTimeout);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location || redirects >= 5) {
          reject(new Error(`Invalid or excessive redirect for ${url}`));
          return;
        }
        try {
          resolve(requestResource(new URL(response.headers.location, url), redirects + 1));
        } catch (error) {
          reject(error);
        }
      } else if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
      } else {
        resolve(response);
      }
    });
    // Socket inactivity timeout does not cover DNS and connection setup.
    const connectionTimeout = setTimeout(() => {
      request.destroy(new Error(`Timed out connecting to ${url}`));
    }, 30_000);
    request.on('timeout', () => request.destroy(new Error(`Timed out downloading ${url}`)));
    request.on('error', (error) => {
      clearTimeout(connectionTimeout);
      reject(error);
    });
  });
}

async function writeAndHash(source, destination) {
  const hash = createHash('sha256');
  await pipeline(source, new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }), fs.createWriteStream(destination, { flags: 'wx' }));
  return hash.digest('hex');
}

async function commitPart(part, destination, sha256) {
  try {
    await fsp.rename(part, destination);
  } catch (error) {
    // Another process may have committed the same resource on Windows.
    if (!['EEXIST', 'EPERM'].includes(error.code) || !await matchesHash(destination, sha256)) {
      throw error;
    }
  }
}

async function populateCache(resource, workspaceRoot, cacheFile) {
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  if (await matchesHash(cacheFile, resource.sha256)) return cacheFile;

  const part = `${cacheFile}.${randomUUID()}.part`;
  try {
    let seeded = false;
    try {
      seeded = await writeAndHash(
        fs.createReadStream(path.join(workspaceRoot, 'child', resource.key)), part,
      ) === resource.sha256;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!seeded) {
      await removePart(part);
      const response = await requestResource(new URL(resource.key, baseUrl));
      if (await writeAndHash(response, part) !== resource.sha256) {
        throw new Error(`SHA-256 mismatch for child resource ${resource.key}`);
      }
    }
    await commitPart(part, cacheFile, resource.sha256);
    return cacheFile;
  } finally {
    await removePart(part);
  }
}

async function ensureCache(resource, workspaceRoot) {
  const cacheFile = path.join(workspaceRoot, '.aily', 'child-cache', resource.sha256, resource.file);
  let pending = pendingCaches.get(cacheFile);
  if (!pending) {
    pending = populateCache(resource, workspaceRoot, cacheFile);
    pendingCaches.set(cacheFile, pending);
  }
  try {
    return await pending;
  } finally {
    if (pendingCaches.get(cacheFile) === pending) pendingCaches.delete(cacheFile);
  }
}

async function copyIfNeeded(source, destination, sha256) {
  if (await matchesHash(destination, sha256)) return;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const part = `${destination}.${randomUUID()}.part`;
  try {
    await fsp.copyFile(source, part, fs.constants.COPYFILE_EXCL);
    await commitPart(part, destination, sha256);
  } finally {
    await removePart(part);
  }
}

async function prepareChildResources({
  workspaceRoot = path.resolve(__dirname, '..'),
  platform = process.platform,
  arch = process.arch,
  destination = path.join(workspaceRoot, 'child'),
  includeCoder = false,
  development = false,
} = {}) {
  const resources = getChildResources({ platform, arch, includeCoder });
  const platformResources = getPlatformResources(platform, arch);
  const rawFiles = new Set([platformResources['7zip'].file, platformResources.ripgrep.file]);
  let next = 0;
  // Await every worker even after a failure so no writes outlive preparation.
  const results = await Promise.allSettled(Array.from({ length: Math.min(3, resources.length) }, async () => {
    while (next < resources.length) {
      const resource = resources[next++];
      const cached = await ensureCache(resource, workspaceRoot);
      const target = path.join(destination, development ? resource.key : resource.file);
      await copyIfNeeded(cached, target, resource.sha256);
      if (platform === 'darwin' && rawFiles.has(resource.file)) await fsp.chmod(target, 0o755);
      if (development && rawFiles.has(resource.file)) {
        const rawTarget = path.join(destination, resource.file);
        await copyIfNeeded(cached, rawTarget, resource.sha256);
        if (platform === 'darwin') await fsp.chmod(rawTarget, 0o755);
      }
    }
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function main(args) {
  const options = { development: true };
  const seen = new Set();
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--platform' || flag === '--arch') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (dryRun) {
    console.log(JSON.stringify(getChildResources(options), null, 2));
  } else {
    await prepareChildResources(options);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[child] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { prepareChildResources };
