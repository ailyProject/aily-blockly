const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const GENERIC_HOST_TARGETS = [
  'electron/subapp-manager.js',
  'src/app/services/subapp-activity.service.ts',
  'src/app/services/subapp-agent-bridge.service.ts',
  'src/app/tools/child-tool-surface-host',
  'src/app/tools/aily-chat/components/subapp-activity',
];
const FORBIDDEN_DOMAIN_PATTERNS = [
  /serial-debugger/i,
  /subapp-serial-debugger/i,
  /\bserial_session_/i,
  /\bbaudRate\b/,
  /\bportPath\b/,
  /\bDTR\b/,
  /\bRTS\b/,
  /\bESP32\b/i,
];

test('generic Subapp host contains no Serial Debugger domain coupling', () => {
  const violations = [];
  for (const target of GENERIC_HOST_TARGETS) {
    const absoluteTarget = path.join(WORKSPACE_ROOT, target);
    for (const filePath of collectSourceFiles(absoluteTarget)) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const pattern of FORBIDDEN_DOMAIN_PATTERNS) {
        if (pattern.test(source)) {
          violations.push({
            file: path.relative(WORKSPACE_ROOT, filePath).replaceAll('\\', '/'),
            pattern: String(pattern),
          });
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});

function collectSourceFiles(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];

  return fs.readdirSync(targetPath, { withFileTypes: true })
    .flatMap(entry => {
      const childPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(childPath);
      return /\.(?:ts|html|scss|js|mjs)$/.test(entry.name) ? [childPath] : [];
    });
}
