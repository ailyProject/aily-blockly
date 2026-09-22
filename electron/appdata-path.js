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

function resolveAilyNpmPrefix(options = {}) {
  const env = options.env || process.env;
  const platformPath = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  const explicit = String(env.AILY_NPM_PREFIX || '').trim();
  if (explicit) return platformPath.resolve(explicit);
  const appDataPath = String(options.appDataPath || env.AILY_APPDATA_PATH || '').trim();
  if (!appDataPath) throw new Error('AILY_APPDATA_PATH is not configured');
  return platformPath.resolve(appDataPath, 'npm-global');
}

module.exports = {
  resolveAilyAppDataPath,
  resolveAilyNpmPrefix,
};
