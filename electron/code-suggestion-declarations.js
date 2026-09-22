const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Read only installed, host-resolved declarations. Never use a model path or a workspace hint as an allowed root. */
async function readCodeDeclaration(candidate, roots) {
  if (typeof candidate !== 'string' || candidate.length > 4096 || !/\.(?:h|hh|hpp|hxx|d\.ts)$/i.test(candidate) || !Array.isArray(roots) || roots.length > 32) return null;
  const canonical = await fs.realpath(candidate);
  if (!/\.(?:h|hh|hpp|hxx|d\.ts)$/i.test(canonical)) return null;
  for (const root of roots) {
    const base = await fs.realpath(root.absolutePath).catch(() => null);
    if (!base) continue;
    const relative = path.relative(base, canonical);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    const file = await fs.open(canonical, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 300_000) return null;
      const text = await file.readFile('utf8');
      if (Buffer.byteLength(text) > 300_000 || text.includes('\0')) return null;
      return { text, relativePath: `@sdk/${String(root.id).replace(/[^a-zA-Z0-9_.@-]/g, '_')}/${relative.split(path.sep).join('/')}`,
        snapshotId: createHash('sha256').update(String(root.version)).update(text).digest('hex') };
    } finally { await file.close(); }
  }
  return null;
}
module.exports = { readCodeDeclaration };
