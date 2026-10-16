const fs = require('node:fs');
const path = require('node:path');

// Backport aily-npm-blockly 3746c9d02 to the pinned 1.0.5 distribution.
// Zelos adds a selected outline during onNodeFocus. Viewport paint-order
// refresh must not restore the previous node inside that focus transaction.
// Apply before both Angular and native-candidate bundling, for npm and pnpm.
// Remove this backport when upgrading to a core that includes the source fix.
function patchBlocklyFocus(packageDir = path.dirname(require.resolve('blockly'))) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (metadata.name !== 'aily-project-blockly' || metadata.version !== '1.0.5') {
    throw new Error('Review the Blockly focus backport before changing the pinned core version.');
  }
  const runtime = [
    ['refresh(){if(!this.disposed&&!this.refreshDepth', 'refresh(preserveFocus=!0){if(!this.disposed&&!this.refreshDepth'],
    ['c=document.activeElement,d=(b==null?void 0:b.contains(c))', 'c=document.activeElement,d=preserveFocus&&(b==null?void 0:b.contains(c))'],
    ['bringToFront(a,b){this.refresh();', 'bringToFront(a,b){this.refresh(!1);'],
  ];
  const files = [
    ['blockly_compressed.js', runtime],
    ['blockly.min.js', runtime],
    ['core/viewport_renderer.d.ts', [['refresh(): void;', 'refresh(preserveFocus?: boolean): void;']]],
  ];
  // Validate every file before writing, and accept an already applied patch.
  const changes = files.map(([name, replacements]) => {
    const file = path.join(packageDir, name), original = fs.readFileSync(file, 'utf8');
    let updated = original;
    for (const [before, after] of replacements) {
      const oldCount = updated.split(before).length - 1;
      const newCount = updated.split(after).length - 1;
      if (oldCount === 1 && newCount === 0) updated = updated.replace(before, after);
      else if (oldCount !== 0 || newCount !== 1) throw new Error(`Unexpected Blockly focus patch target: ${name}`);
    }
    return {file, original, updated};
  });
  for (const {file, original, updated} of changes) {
    if (updated === original) continue;
    // Replace the file, so package-manager hard links cannot modify its store
    // or another checkout sharing the original distribution.
    const temporary = `${file}.aily-focus-${process.pid}`;
    try {
      fs.writeFileSync(temporary, updated, {mode: fs.statSync(file).mode});
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, {force: true});
    }
  }
}

module.exports = {patchBlocklyFocus};
