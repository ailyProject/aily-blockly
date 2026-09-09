const manifest = require('./child-resources.lock.json');

const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
if (new URL(manifest.baseUrl).protocol !== 'https:' || !manifest.baseUrl.endsWith('/')) {
  throw new Error('Child resource baseUrl must be an HTTPS directory URL');
}
for (const resource of [...Object.values(manifest.platforms).flatMap(Object.values), ...manifest.coder]) {
  if (!safeName.test(resource.file)
    || !resource.key.split('/').every(part => safeName.test(part))
    || !/^[a-f0-9]{64}$/.test(resource.sha256)) {
    throw new Error('Invalid child resource filename, key or SHA-256');
  }
}

function getPlatformResources(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const resources = manifest.platforms[target];
  if (!resources) {
    throw new Error(`No child resources for ${target}. Available: ${Object.keys(manifest.platforms).join(', ')}`);
  }
  return resources;
}

function getChildResources({ platform, arch, includeCoder = false } = {}) {
  return [
    ...Object.values(getPlatformResources(platform, arch)),
    ...(includeCoder ? manifest.coder : []),
  ];
}

module.exports = {
  baseUrl: manifest.baseUrl,
  getPlatformResources,
  getChildResources,
};
