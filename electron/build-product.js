const DEFAULT_BUILD_PRODUCT = 'blockly';

function normalizeBuildProduct(product) {
  return String(product || '').trim().toLowerCase() === 'coder'
    ? 'coder'
    : DEFAULT_BUILD_PRODUCT;
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
  isProductProtocolUrl,
  getProductAuthConfig,
  DEFAULT_BUILD_PRODUCT,
  normalizeBuildProduct,
};
