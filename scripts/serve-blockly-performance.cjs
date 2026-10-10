const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'e2e/.artifacts/blockly-performance-2026-09-28');
function serve(port = 0, directoryOverride) {
  const servingDirectory = directoryOverride || directory;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const base = url.pathname.startsWith('/fonts/') ? path.join(root, 'public') : url.pathname.startsWith('/media/') ? path.join(root, 'node_modules/blockly') : servingDirectory;
    const file = path.resolve(base, `.${decodeURIComponent(url.pathname === '/' ? '/aily.html' : url.pathname)}`);
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('Content-Type', ({'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2'})[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
module.exports = {serve};
if (require.main === module) serve(Number(process.env.PORT || 8313), process.env.BLOCKLY_PERF_DIRECTORY && path.resolve(process.env.BLOCKLY_PERF_DIRECTORY))
  .then(server => console.log(`http://127.0.0.1:${server.address().port}/aily.html`));
