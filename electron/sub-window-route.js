'use strict';

function normalizeSubWindowRoutePath(routePath) {
  return String(routePath || '')
    .trim()
    .replace(/^\/+/, '');
}

function buildSubWindowRouteUrl(routePath, resolveRendererUrl) {
  if (typeof resolveRendererUrl !== 'function') {
    throw new Error('Renderer URL resolver is unavailable.');
  }
  return resolveRendererUrl(`#/${normalizeSubWindowRoutePath(routePath)}`);
}

module.exports = {
  buildSubWindowRouteUrl,
  normalizeSubWindowRoutePath,
};
