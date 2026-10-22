const { spawnSync } = require('node:child_process');
const path = require('node:path');
const config = require('../tsconfig.cloud-build.spec.json');

const root = path.resolve(__dirname, '../..');
const result = spawnSync(process.execPath, [
  'scripts/run-angular.cjs', 'test', '--watch=false', '--browsers=ChromeHeadless',
  '--ts-config=tests/tsconfig.cloud-build.spec.json',
  ...config.include.filter(file => file.endsWith('.spec.ts')).map(file => `--include=${file.replace('../src/', 'src/')}`),
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
