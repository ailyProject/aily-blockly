'use strict';

function normalizeSubWindowRoutePath(routePath) {
  return String(routePath || '')
    .trim()
    .replace(/^\/+/, '');
}

function buildDevSubWindowRouteUrl(routePath, baseUrl = 'http://localhost:4200') {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/#/${normalizeSubWindowRoutePath(routePath)}`;
}

module.exports = {
  buildDevSubWindowRouteUrl,
  normalizeSubWindowRoutePath,
};
