'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { crc32 } = require('node:zlib');
const yauzl = require('yauzl');
const { isProjectWriterTransient, publishStagedProjectDirectory } = require('./project-file-copy');

const MAX_ENTRIES = 100_000;
const MAX_EXPANDED_BYTES = 8 * 1024 ** 3;

function validPart(part) {
  if (!part || part === '.' || part === '..' || /[\u0000-\u001f]/.test(part)) return false;
  return process.platform !== 'win32' || (!/[<>:"|?*]|[. ]$/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:\.|$)/i.test(part));
}

async function readProjectEntries(zip) {
  if (zip.entryCount > MAX_ENTRIES) throw new Error('Project ZIP contains too many entries.');
  const entries = [];
  const paths = new Map();
  const top = new Set();
  let size = 0;
  for await (const entry of zip.eachEntry()) {
    if (!Number.isSafeInteger(entry.uncompressedSize) || (size += entry.uncompressedSize) > MAX_EXPANDED_BYTES) {
      throw new Error('Project ZIP exceeds the expanded size limit.');
    }
    if (entry.fileName.length > 4096) throw new Error('Project ZIP entry path is too long.');
    const directory = entry.fileName.endsWith('/');
    // Windows tar includes "./" as the root and prefixes its member names.
    if (entry.fileName === './') continue;
    const filename = entry.fileName.replace(/^\.\//, '');
    const parts = (directory ? filename.slice(0, -1) : filename).split('/');
    // Finder adds a second tree containing AppleDouble metadata beside the project.
    if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') continue;
    if (parts.length > 128 || !parts.every(validPart)) throw new Error('Project ZIP contains an invalid entry path.');
    top.add(parts[0]);
    let member = '';
    for (const [index, part] of parts.entries()) {
      member = member ? `${member}/${part}` : part;
      const leaf = index === parts.length - 1;
      const folder = !leaf || directory;
      const key = member.normalize('NFC').toLowerCase();
      const previous = paths.get(key);
      if (previous && (previous.name !== member || !previous.directory || !folder || leaf && previous.explicit)) {
        throw new Error('Project ZIP contains conflicting entry paths.');
      }
      if (!previous || leaf) paths.set(key, { name: member, directory: folder, explicit: leaf });
    }
    const mode = (entry.versionMadeBy >>> 8) === 3 ? entry.externalFileAttributes >>> 16 : 0;
    entries.push({ entry, directory, member, mode, fileType: mode & 0o170000 });
  }

  const manifest = name => entries.some(item => item.member === name && !item.directory && (!item.fileType || item.fileType === 0o100000));
  if (manifest('package.json')) return { entries, prefix: '' };
  const [wrapper] = top;
  if (top.size === 1 && manifest(`${wrapper}/package.json`)) return { entries, prefix: `${wrapper}/` };
  throw new Error('Project ZIP must contain package.json at its root or inside one project folder.');
}

async function extractProjectEntries(zip, stage) {
  const { entries, prefix } = await readProjectEntries(zip);
  for (const { entry, directory, member, mode, fileType } of entries) {
    if (!member.startsWith(prefix)) continue;
    const relative = member.slice(prefix.length);
    const parts = relative.split('/');
    // Skip a runtime directory and its descendants before any extraction.
    if (parts.some((_, index) => isProjectWriterTransient(parts.slice(0, index + 1).join('/')))) continue;
    if (fileType && fileType !== (directory ? 0o040000 : 0o100000)) {
      // npm recreates dependency links from the imported package and local library sources.
      if (fileType === 0o120000 && parts[0] === 'node_modules') continue;
      throw new Error('Project ZIP contains an unsupported linked or special entry.');
    }
    const output = path.join(stage, ...parts);
    if (directory) {
      await fs.promises.mkdir(output, { recursive: true });
      continue;
    }
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    let crc = 0;
    const checksum = new Transform({
      transform(chunk, _encoding, callback) { crc = crc32(chunk, crc); callback(null, chunk); },
      flush(callback) { callback(crc === entry.crc32 ? null : new Error('Project ZIP entry checksum failed.')); },
    });
    await pipeline(await zip.openReadStreamPromise(entry), checksum,
      fs.createWriteStream(output, { flags: 'wx', mode: 0o600 | (mode & 0o111) }));
  }
}

async function importProjectArchive(archivePath, destination) {
  if (typeof archivePath !== 'string' || typeof destination !== 'string' || !path.isAbsolute(archivePath)
      || !path.isAbsolute(destination) || path.extname(archivePath).toLowerCase() !== '.zip') {
    throw new Error('Project ZIP import requires absolute archive and destination paths.');
  }
  if (!(await fs.promises.stat(archivePath)).isFile()) throw new Error('Project ZIP must be a regular file.');
  const parent = path.dirname(destination);
  await fs.promises.mkdir(parent, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(await fs.promises.realpath(parent), '.aily-zip-import-'));
  const staged = fs.lstatSync(stage, { bigint: true });
  let zip;
  try {
    zip = await yauzl.openPromise(archivePath, { autoClose: false });
    await extractProjectEntries(zip, stage);
    return publishStagedProjectDirectory(stage, destination);
  } finally {
    zip?.close();
    try {
      const current = fs.lstatSync(stage, { bigint: true, throwIfNoEntry: false });
      if (current?.isDirectory() && current.dev === staged.dev && current.ino === staged.ino && current.birthtimeNs === staged.birthtimeNs) {
        await fs.promises.rm(stage, { recursive: true, force: true });
      }
    }
    catch (error) { console.warn('Could not clean project ZIP staging directory:', stage, error); }
  }
}

module.exports = { importProjectArchive };
