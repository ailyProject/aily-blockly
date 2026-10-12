const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

async function main() {
  const [manifestPath] = process.argv.slice(2);
  if (!manifestPath) throw new Error('Usage: refresh-macos-dmg-manifest.cjs manifest.yml');
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  const dmgFiles = manifest.files.filter(file => file.url.endsWith('.dmg'));
  if (dmgFiles.length === 0) throw new Error(`No DMG entries in ${manifestPath}`);

  // Stapling changes the DMG after electron-builder has written the manifest.
  for (const file of dmgFiles) {
    const filename = path.join(path.dirname(manifestPath), file.url);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty DMG: ${file.url}`);
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    file.sha512 = hash.digest('base64');
    file.size = stat.size;
    if (manifest.path === file.url) manifest.sha512 = file.sha512;
  }

  // Preserve the single-line SHA512 format used by the server sync scripts.
  fs.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
