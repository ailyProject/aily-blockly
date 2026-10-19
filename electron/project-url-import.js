const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { importProjectPackage } = require('./project-package-import');

const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];

function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('工程包下载链接无效。'); }
  if (url.username || url.password || url.hash
    || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.includes(url.hostname))) {
    throw new Error('工程包必须使用 HTTPS 下载链接。');
  }
  return url;
}

function parseProjectImportUrl(value, product) {
  let url;
  try { url = new URL(value); } catch { throw new Error('工程导入链接无效。'); }
  const protocols = product === 'coder' ? ['acis:', 'ailycoder:'] : ['abis:', 'ailyblockly:'];
  if (!['blockly', 'coder'].includes(product) || !protocols.includes(url.protocol)
    || url.hostname !== 'project' || url.pathname !== '/import'
    || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].some(key => key !== 'url')
    || url.searchParams.getAll('url').length !== 1) throw new Error('工程导入链接无效。');
  return downloadUrl(url.searchParams.get('url')).href;
}

async function anonymousResponse(initialUrl) {
  let url = initialUrl;
  const signal = AbortSignal.timeout(120000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { credentials: 'omit', redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('工程包下载失败，请检查下载链接。');
      }
      return response;
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error('工程包下载重定向无效或次数过多。');
    url = downloadUrl(new URL(location, url).href);
    if (initialUrl.protocol === 'https:' && url.protocol !== 'https:') throw new Error('工程包重定向必须使用 HTTPS。');
  }
}

async function importProjectUrl({ url, product, projectRoot, sevenZipPath, tempRoot = os.tmpdir() }) {
  const target = downloadUrl(url);
  if (!['blockly', 'coder'].includes(product) || !path.isAbsolute(projectRoot)
    || typeof sevenZipPath !== 'string' || !fs.existsSync(sevenZipPath)) {
    throw new Error('本地工程目录或解压工具未就绪，请重启或更新桌面应用。');
  }
  const working = fs.mkdtempSync(path.join(tempRoot, 'aily-url-import-'));
  try {
    const archivePath = path.join(working, 'project.7z');
    const response = await anonymousResponse(target);
    if (Number(response.headers.get('content-length')) > MAX_ARCHIVE_SIZE) {
      await response.body?.cancel();
      throw new Error('下载工程大小超过限制。');
    }
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_ARCHIVE_SIZE ? new Error('下载工程大小超过限制。') : null, chunk);
    } }), fs.createWriteStream(archivePath, { flags: 'wx' }));
    return await importProjectPackage({ archivePath, destination: path.join(projectRoot, `Import_${randomUUID()}`),
      product, sevenZipPath, tempRoot });
  } finally {
    // This directory belongs to this download, never to URL/archive input.
    fs.rmSync(working, { recursive: true, force: true });
  }
}

module.exports = { parseProjectImportUrl, importProjectUrl };
