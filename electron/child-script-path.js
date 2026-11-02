const path = require('node:path');
const { app } = require('electron');

function childScriptPath(filename) {
  // Preload has no main-process app object. In that realm only this bundled
  // module's own physical package layout can select external resources.
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const packaged = typeof app?.isPackaged === 'boolean' ? app.isPackaged
    : typeof process.resourcesPath === 'string' && ['app.asar', 'app.asar.unpacked']
      .some(name => canonical(path.join(__dirname, '..')) === canonical(path.join(process.resourcesPath, name)));
  const childRoot = packaged
    ? path.join(process.resourcesPath, 'child')
    : path.join(__dirname, '..', 'child');
  return path.join(childRoot, 'scripts', filename);
}

module.exports = { childScriptPath };
