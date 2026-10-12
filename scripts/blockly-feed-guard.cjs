const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const semver = require('semver');

const MANIFESTS = ['latest.yml', 'latest-cn.yml', 'latest-mac.yml', 'latest-mac-cn.yml'];

function manifestVersion(content, name) {
  let version;
  try {
    version = yaml.load(content.toString('utf8'))?.version;
  } catch {
    throw new Error(`Invalid manifest YAML: ${name}`);
  }
  if (typeof version !== 'string' || semver.valid(version) !== version) {
    throw new Error(`Invalid manifest version: ${name}`);
  }
  return version;
}

function guardBlocklyFeed(directory, version) {
  if (typeof version !== 'string' || semver.valid(version) !== version) throw new Error('A complete SemVer release version is required');
  const local = MANIFESTS.map(name => {
    const content = fs.readFileSync(path.join(directory, name));
    if (manifestVersion(content, name) !== version) throw new Error(`Local manifest version mismatch: ${name}`);
    return { name, content };
  });
  const { R2_ACCOUNT_ID: account, R2_BUCKET_NAME: bucket, R2_UPLOAD_PATH: prefix = '', RUNNER_TEMP: runnerTemp } = process.env;
  if (!account || !bucket || !runnerTemp) throw new Error('R2_ACCOUNT_ID, R2_BUCKET_NAME and RUNNER_TEMP are required');
  const temporary = fs.mkdtempSync(path.join(path.resolve(runnerTemp), 'blockly-feed-guard-'));
  try {
    for (const { name, content } of local) {
      const downloaded = path.join(temporary, name);
      try {
        // Match s3://BUCKET/UPLOAD_PATH/NAME exactly, including empty or repeated slashes.
        execFileSync('aws', ['s3api', 'get-object', '--bucket', bucket, '--key', `${prefix}/${name}`,
          '--endpoint-url', `https://${account}.r2.cloudflarestorage.com`, '--region', 'auto',
          '--no-cli-pager', downloaded], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      } catch (error) {
        if (/(?:^|\n)An error occurred \((?:NoSuchKey|404)\) when calling the GetObject operation:/.test(String(error.stderr || ''))) continue;
        // AWS errors may contain command arguments or credential diagnostics.
        throw new Error(`Cannot read current R2 manifest: ${name}`);
      }
      const remote = fs.readFileSync(downloaded);
      const previous = manifestVersion(remote, name);
      if (semver.gt(previous, version)) throw new Error(`Refusing Blockly feed rollback: ${name} at ${previous}`);
      if (semver.eq(previous, version) && !remote.equals(content)) {
        throw new Error(`Refusing different bytes for existing Blockly version: ${name}`);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const [directory, version] = process.argv.slice(2);
    if (!directory || !version) throw new Error('Usage: blockly-feed-guard.cjs manifest-directory version');
    guardBlocklyFeed(directory, version);
    console.log('All four Blockly manifests passed the R2 rollback guard.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { guardBlocklyFeed };
