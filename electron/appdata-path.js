const path = require('path');

function resolveAilyAppDataPath(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.AILY_APPDATA_PATH || '').trim();
  if (explicit) return path.resolve(explicit);

  const platform = options.platform || process.platform;
  const home = options.home || require('os').homedir();
  const configured = options.config?.appdata_path || {};
  if (platform === 'win32') {
    return path.resolve(String(configured.win32 || '').replace('%HOMEPATH%', home));
  }
  if (platform === 'darwin') {
    return path.resolve(String(configured.darwin || '').replace(/^~/, home));
  }
  return path.resolve(String(configured.linux || '').replace(/^~/, home));
}

module.exports = {
  resolveAilyAppDataPath,
};
