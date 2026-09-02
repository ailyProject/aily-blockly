const DEFAULT_BUILD_PRODUCT = 'blockly';

function normalizeBuildProduct(product) {
  return String(product || '').trim().toLowerCase() === 'coder'
    ? 'coder'
    : DEFAULT_BUILD_PRODUCT;
}

module.exports = {
  DEFAULT_BUILD_PRODUCT,
  normalizeBuildProduct,
};
