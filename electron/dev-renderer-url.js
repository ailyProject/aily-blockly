'use strict';

const DEFAULT_DEV_RENDERER_ORIGIN = 'http://localhost:4200';

function resolveDevRendererUrl(hash = '', origin = DEFAULT_DEV_RENDERER_ORIGIN) {
  const match = typeof origin === 'string'
    && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/.exec(origin);
  if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
    throw new TypeError('Development renderer origin must be an HTTP loopback origin.');
  }
  if (hash === undefined || hash === null || hash === '') {
    return origin;
  }
  if (
    typeof hash !== 'string'
    || hash.length > 16 * 1024
    || /[\u0000-\u001f\u007f]/.test(hash)
  ) {
    throw new TypeError('Renderer hash is invalid.');
  }
  return `${origin}/${hash.startsWith('#') ? hash : `#${hash}`}`;
}

module.exports = { resolveDevRendererUrl };
