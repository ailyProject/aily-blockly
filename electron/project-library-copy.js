const fs = require('node:fs');
const path = require('node:path');

/** Local Blockly libraries are directory links. Retarget project-owned links
 * after copying, using junctions on Windows (no file-symlink privilege needed). */
function copyProjectLibraryLink(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative), target = path.join(targetRoot, relative);
  const resolved = fs.realpathSync(source);
  const name = relative.split(path.sep).slice(-2).join('/');
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'));
  if (!fs.statSync(resolved).isDirectory() || manifest.name !== name) throw new Error('Linked library identity does not match its project package.');
  const child = path.relative(sourceRoot, resolved);
  if (child && !path.isAbsolute(child) && child !== '..' && !child.startsWith(`..${path.sep}`)) {
    const destination = path.join(targetRoot, child);
    const stat = fs.lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The copied local-library source is unavailable.');
    fs.symlinkSync(destination, target, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  // Older projects may link an external source. Copy only this package, never
  // follow nested links or unbounded source trees into unrelated directories.
  let bytes = 0, files = 0;
  const collect = (directory, relativePath = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const from = path.join(directory, entry.name), item = path.join(relativePath, entry.name);
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('External linked libraries must contain regular files and directories only.');
      if (++files > 16384 || (bytes += stat.isFile() ? stat.size : 0) > 256 * 1024 * 1024) {
        throw new Error('External linked library exceeds the bounded project-copy limit.');
      }
      if (stat.isDirectory()) collect(from, item);
    }
  };
  collect(resolved);
  let copiedBytes = 0, copiedFiles = 0;
  fs.cpSync(resolved, target, { recursive: true, force: false, errorOnExist: true,
    filter: file => {
      if (path.basename(file) === '.git') return false;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('External library changed during copying.');
      if (++copiedFiles > 16384 || (copiedBytes += stat.isFile() ? stat.size : 0) > 256 * 1024 * 1024) {
        throw new Error('External linked library changed beyond the bounded project-copy limit.');
      }
      return true;
    } });
}

module.exports = { copyProjectLibraryLink };
