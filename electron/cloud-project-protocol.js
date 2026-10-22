const { isProductProtocolUrl } = require('./build-product');

function parseCloudProjectOpen(url, product) {
  try {
    if (!isProductProtocolUrl(product, url)) return null;
    const parsed = new URL(url);
    if (parsed.hostname !== 'project' || parsed.pathname !== '/open'
      || parsed.username || parsed.password || parsed.port || parsed.hash
      || [...parsed.searchParams.keys()].some(key => !['cloudProject', 'apiOrigin'].includes(key))
      || parsed.searchParams.getAll('cloudProject').length !== 1
      || parsed.searchParams.getAll('apiOrigin').length > 1) return null;
    const cloudProject = parsed.searchParams.get('cloudProject');
    if (!/^(?:[1-9]\d{0,35}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(cloudProject || '')) return null;
    let apiOrigin;
    if (parsed.searchParams.has('apiOrigin')) {
      const value = parsed.searchParams.get('apiOrigin');
      if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) return null;
      const hint = new URL(value);
      if (!['http:', 'https:'].includes(hint.protocol) || hint.username || hint.password
        || hint.pathname !== '/' || hint.search || hint.hash) return null;
      apiOrigin = hint.origin;
    }
    return { cloudProject, ...(apiOrigin ? { apiOrigin } : {}) };
  } catch { return null; }
}

function createCloudProjectOpenQueue(isReady, send) {
  const pending = new Map();
  return {
    receive(url, product) {
      const request = parseCloudProjectOpen(url, product);
      if (!request) return false;
      pending.set(`${request.apiOrigin || ''}:${request.cloudProject}`, request);
      this.flush();
      return true;
    },
    flush() {
      if (!isReady()) return;
      for (const [id, request] of pending) {
        send(request);
        pending.delete(id);
      }
    },
  };
}

module.exports = { parseCloudProjectOpen, createCloudProjectOpenQueue };
