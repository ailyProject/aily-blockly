const zlib = require('zlib');

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function header(name, size, type = '0', mode = 0o644, linkName = '') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'ascii');
  if (linkName) block.write(linkName, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function npmTarball(files, extraEntries = []) {
  const blocks = [];
  const entries = [
    ...Object.entries(files).map(([name, value]) => ({ name: `package/${name}`, value })),
    ...extraEntries,
  ];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(String(entry.value || ''));
    const type = entry.type || '0';
    blocks.push(header(entry.name, type === '0' ? content.length : 0, type, entry.mode, entry.linkName));
    if (type === '0') {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function portableSubappTarball({ packageName, version, id = 'aily-chat', dependencies = {}, scripts = {} }) {
  return npmTarball({
    'package.json': JSON.stringify({
      name: packageName,
      version,
      main: 'server/index.js',
      aily: { uiIndex: 'ui/index.html' },
      ailySubapp: { id },
      ailyPortable: {
        version: 1,
        format: 'js',
        platforms: ['darwin', 'win32', 'linux'],
        architectures: ['arm64', 'x64'],
      },
      dependencies,
      scripts,
    }),
    'server/index.js': `module.exports = ${JSON.stringify(version)};\n`,
    'ui/index.html': `<h1>${version}</h1>`,
  });
}

module.exports = { npmTarball, portableSubappTarball };
