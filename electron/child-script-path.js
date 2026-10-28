const path = require('node:path');
const { app } = require('electron');

function childScriptPath(filename) {
  const childRoot = app?.isPackaged
    ? path.join(process.resourcesPath, 'child')
    : path.join(__dirname, '..', 'child');
  return path.join(childRoot, 'scripts', filename);
}

module.exports = { childScriptPath };
