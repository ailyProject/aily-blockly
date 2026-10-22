const { validateSubappDistribution } = require('./subapp-release-trust');

function validateDistribution(value, id) {
  if (value === undefined) return null;

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${id} dist must be an object`);
  }

  const tarball = typeof value.tarball === 'string' ? value.tarball.trim() : '';
  const integrity = typeof value.integrity === 'string' ? value.integrity.trim() : '';

  if (!/^https?:\/\//i.test(tarball)) throw new Error(`${id} dist.tarball must be an HTTP(S) URL`);

  if (!/^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${id} dist.integrity must be a supported SRI digest`);
  }

  return { tarball, integrity };
}

/** Each platform supplies transport metadata only; identity and app policy remain shared. */
function validatePlatformDistributions(value, id) {
  if (value === undefined) return undefined;

  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length === 0 || Object.keys(value).length > 32) {
    throw new Error(`${id} platforms must be a non-empty platform distribution map`);
  }

  return Object.fromEntries(Object.entries(value).map(([platform, candidate]) => {
    if (!/^(darwin|win32|linux)-(arm64|x64|ia32|arm)$/.test(platform)
      || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).some(key => !['dist', 'distribution'].includes(key))) {
      throw new Error(`${id} has an invalid platform distribution: ${platform}`);
    }

    const dist = validateDistribution(candidate.dist, id);

    const distribution = candidate.distribution === undefined
      ? undefined : validateSubappDistribution(candidate.distribution);

    if (!dist && !distribution) throw new Error(`${id} platform ${platform} has no distribution`);

    if (distribution && (distribution.platform !== platform
      || dist && (dist.tarball !== distribution.tarballUrl || dist.integrity !== distribution.tarballIntegrity))) {
      throw new Error(`${id} platform ${platform} does not match its signed distribution`);
    }

    return [platform, { ...(dist ? { dist } : {}), ...(distribution ? { distribution } : {}) }];
  }));
}

function selectSubappPlatformEntry(entry, { platform = process.platform, arch = process.arch } = {}) {
  if (entry.platforms === undefined) return entry;

  const selected = entry.platforms[`${platform}-${arch}`];

  if (!selected) return null;

  const { dist, distribution, ...shared } = entry;

  return { ...shared, ...selected };
}

/** Keep the cached catalog complete; project only at the application boundary. */
function selectSubappPlatformIndex(index, options) {
  return Object.fromEntries(Object.entries(index).flatMap(([id, entry]) => {
    if (id === 'dev') return [[id, entry]];

    const selected = selectSubappPlatformEntry(entry, options);

    return selected ? [[id, selected]] : [];
  }));
}

function assertPackagePlatform(manifest, { platform = process.platform, arch = process.arch } = {}) {
  for (const [field, actual] of [['os', platform], ['cpu', arch]]) {
    const declared = manifest[field];

    if (declared === undefined) continue;

    if (!Array.isArray(declared) || !declared.every(value => typeof value === 'string')) {
      throw new Error(`Invalid package ${field} declaration`);
    }

    const included = declared.filter(value => !value.startsWith('!'));

    if (declared.includes(`!${actual}`)
      || included.length > 0 && !included.includes(actual) && !included.includes('any')) {
      throw new Error(`Subapp package does not support ${platform}-${arch}`);
    }
  }
}

module.exports = { validateDistribution, validatePlatformDistributions, selectSubappPlatformEntry,
  selectSubappPlatformIndex, assertPackagePlatform };
