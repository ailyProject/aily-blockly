// Mechanical snapshot refresh. Keep the selected definitions and copy the real
// installed-library script verbatim; no handwritten test-only producer contract.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const target = path.join(root, 'src/app/integrations/blockly/abs/abs-native-pid-model.fixture.ts');
const previous = fs.readFileSync(target, 'utf8');
const prefix = previous.slice(0, previous.indexOf('export const pidModelFixture = ') + 'export const pidModelFixture = '.length);
const fixture = JSON.parse(previous.slice(prefix.length).trim().replace(/;$/, ''));
fixture.source = fs.readFileSync(path.resolve(root, '../aily-blockly-libraries/pid/generator.js'), 'utf8');
fs.writeFileSync(target, prefix + JSON.stringify(fixture, null, 2) + ';\n');
