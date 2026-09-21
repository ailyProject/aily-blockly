const DEFAULT_BUILD_PRODUCT = 'blockly';

function normalizeBuildProduct(product) {
  return String(product || '').trim().toLowerCase() === 'coder'
    ? 'coder'
    : DEFAULT_BUILD_PRODUCT;
}

function resolveBuildProduct({ environment = {}, packagedProduct, argv = [] } = {}) {
  const prefix = '--aily-build-product=';
  const launchProduct = argv.find(arg => typeof arg === 'string' && arg.startsWith(prefix))?.slice(prefix.length);
  return normalizeBuildProduct(environment.AILY_BUILD_PRODUCT || packagedProduct || launchProduct);
}

function createDevelopmentProtocolArgs({ appEntry, product, serve = false }) {
  // A browser-launched process does not inherit the development launcher's env.
  return [appEntry, `--aily-build-product=${normalizeBuildProduct(product)}`, ...(serve ? ['--serve'] : [])];
}

function getProductAuthConfig(product) {
  const id = normalizeBuildProduct(product);
  const protocol = id === 'coder' ? 'acis' : 'abis';
  const protocols = [protocol, id === 'coder' ? 'ailycoder' : 'ailyblockly'];
  return { product: id, deviceId: `pc:${id}`, protocol, protocols, redirectUri: `${protocol}://auth/callback` };
}

function isProductProtocolUrl(product, url) {
  return typeof url === 'string' && getProductAuthConfig(product).protocols.some(
    protocol => url.toLowerCase().startsWith(`${protocol}://`),
  );
}

module.exports = {
  createDevelopmentProtocolArgs,
  isProductProtocolUrl,
  getProductAuthConfig,
  DEFAULT_BUILD_PRODUCT,
  normalizeBuildProduct,
  resolveBuildProduct,
};
