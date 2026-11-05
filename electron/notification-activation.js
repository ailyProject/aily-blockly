// Windows 历史通知通过产品协议回到发起进程，不依赖横幅的临时 COM 回调。
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { getProductAuthConfig } = require('./build-product');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pipePath = (product, instance) => `\\\\.\\pipe\\aily-notification-${product}-${instance}`;

function isNotificationActivationUrl(value, product) {
  try {
    const url = new URL(value);
    return getProductAuthConfig(product).protocols.includes(url.protocol.slice(0, -1))
      && url.hostname === 'notification';
  } catch { return false; }
}

function parseActivationUrl(value, product) {
  if (!isNotificationActivationUrl(value, product)) throw new Error('Invalid notification protocol');
  const url = new URL(value);
  const parts = url.pathname.split('/');
  if (url.username || url.password || url.port || url.search || url.hash
      || parts.length !== 3 || !UUID.test(parts[1]) || !UUID.test(parts[2])) {
    throw new Error('Invalid notification activation');
  }
  return { instance: parts[1], notificationId: parts[2] };
}

function createActivationServer({ product, onActivate, makePipePath = pipePath }) {
  const instance = randomUUID(), clients = new Set();
  let closed = false;
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(2000, () => socket.destroy());
    let input = '', handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 128) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      const id = input.slice(0, input.indexOf('\n'));
      let activated = false;
      try { activated = UUID.test(id) && onActivate(id) === true; } catch { /* reply failure */ }
      socket.end(activated ? 'ok\n' : 'stale\n');
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(makePipePath(product, instance), () => {
      if (closed) server.close();
      resolve();
    });
  });
  server.on('error', () => {});
  return {
    ready,
    url(id) {
      if (!UUID.test(id)) throw new Error('Invalid notification ID');
      return `${getProductAuthConfig(product).protocol}://notification/${instance}/${id}`;
    },
    close() {
      closed = true;
      for (const client of clients) client.destroy();
      if (server.listening) server.close();
    },
  };
}

function forwardNotificationActivation(value, product, { makePipePath = pipePath } = {}) {
  return new Promise((resolve, reject) => {
    let route;
    try { route = parseActivationUrl(value, product); } catch (error) { reject(error); return; }
    const socket = net.createConnection(makePipePath(product, route.instance));
    let reply = '';
    const fail = error => { socket.destroy(); reject(error); };
    socket.on('error', fail);
    socket.setTimeout(2000, () => fail(new Error('Notification owner unavailable')));
    socket.once('connect', () => socket.write(`${route.notificationId}\n`));
    socket.on('data', chunk => {
      reply += chunk.toString('utf8');
      if (reply.length > 16) fail(new Error('Invalid notification reply'));
    });
    socket.once('end', () => {
      socket.destroy();
      if (reply === 'ok\n') resolve();
      else reject(new Error('Notification is no longer active'));
    });
  });
}

const xml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);

function createWindowsToastXml(options, launch) {
  const image = typeof options.icon === 'string' && options.icon
    ? `<image placement="appLogoOverride" src="${xml(pathToFileURL(options.icon).href)}"/>` : '';
  const reminder = options.timeoutType === 'never';
  return `<toast activationType="protocol" launch="${xml(launch)}"${reminder ? ' scenario="reminder"' : ''}>`
    + `<visual><binding template="ToastGeneric"><text>${xml(options.title)}</text><text>${xml(options.body)}</text>${image}</binding></visual>`
    + (options.silent ? '<audio silent="true"/>' : '')
    + (reminder ? '<actions><action content="关闭" arguments="dismiss" activationType="system"/></actions>' : '')
    + '</toast>';
}

module.exports = { createActivationServer, createWindowsToastXml, forwardNotificationActivation, isNotificationActivationUrl, parseActivationUrl };
