const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = process.env.AILY_PROJECT_SYNC_TEST_ROOT;
app.setPath('userData', path.join(root, 'electron-profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // Renderer restart must not terminate this isolated host.

app.whenReady().then(async () => {
  let window;
  try {
    const bundle = buildSync({ entryPoints: [path.join(__dirname, 'abs-generation-kernel.ts')], bundle: true,
      platform: 'browser', format: 'iife', globalName: 'AbsKernel', write: false, logLevel: 'error' }).outputFiles[0].text;
    const open = async () => {
      window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false,
        preload: path.join(__dirname, '../preload.js') } });
      await window.loadFile(path.join(__dirname, 'abs-generation.html'));
      await window.webContents.executeJavaScript(bundle);
      await window.webContents.executeJavaScript(`(async () => {
        window.scope = { projectKey: ${JSON.stringify(root)}, pageId: 'main' };
        window.storage = await AbsKernel.openAbsHostStorage(${JSON.stringify(root)}, () => {}, window.electronAPI.fs);
        window.store = new AbsKernel.AbsBaselineStore(window.storage, window.scope);
      })()`);
    };
    await open();
    const zoneResult = await window.webContents.executeJavaScript(`(async () => {
      if (Promise.name !== 'ZoneAwarePromise') throw new Error('Angular promise boundary was not exercised');
      return window.storage.withLock(locked => Promise.resolve().then(async () => {
        await locked.replace('baselines/zone-boundary.json', null, 'native settlement');
        return { settled: await locked.read('baselines/zone-boundary.json') };
      }));
    })()`);
    assert.deepEqual(zoneResult, { settled: 'native settlement' });
    const staged = await window.webContents.executeJavaScript(`(async () => {
      const { createAbsProjection, absBaselineKey, absJson, hashAbsText, reconcileAbs } = AbsKernel;
      const workspace = { blocks: { blocks: [{ type: 'any_root', id: 'root-keep', deletable: false,
        movable: false, collapsed: true, data: 'opaque metadata', fields: { LABEL: 'before' },
        inputs: { VALUE: { shadow: { type: 'text', id: 'dormant-keep', fields: { TEXT: 'fallback' } },
          block: { type: 'text', id: 'child-keep', fields: { TEXT: 'child' } } } } }] } };
      const original = await createAbsProjection(workspace, { document: workspace, generation: 'g1',
        baselineRef: absBaselineKey('g1'), scope: window.scope, savedAbiHash: null });
      await window.store.stage({ mode: 'export', inputAbs: null, abi: null,
        expected: await window.store.captureDisk(), projection: original });
      const exported = await window.store.commit('g1', () => {}, async () => { throw new Error('export must not save ABI'); });
      const source = original.abs.replace('LABEL="before"', 'LABEL="after"') + '\\r\\n# exact input 中文😀';
      const merged = await reconcileAbs(original, source);
      const abi = JSON.stringify(merged.workspace, null, 2);
      const projection = await createAbsProjection(merged.workspace, { document: merged.workspace, generation: 'g2',
        baselineRef: absBaselineKey('g2'), scope: window.scope, savedAbiHash: await hashAbsText(absJson(merged.workspace)) });
      await window.store.stage({ mode: 'import', inputAbs: source, abi,
        expected: await window.store.captureDisk(), projection });
      const pending = await window.store.commit('g2', () => {}, async (text, expected, locked) => {
        if (!await locked.replace('project.abi', expected, text)) throw new Error('ABI CAS conflict');
        throw new Error('simulated interruption after ABI commit');
      });
      const blocked = await window.electronAPI.fs.replaceProjectText({ projectPath: ${JSON.stringify(root)},
        fileName: 'project.abi', expectedHash: await hashAbsText(abi), content: abi }, () => {});
      return { exported, pending, blocked, source, abi, projection };
    })()`);
    assert.equal(staged.exported.status, 'COMMITTED'); assert.equal(staged.exported.abiSaved, false);
    assert.equal(staged.pending.status, 'MIRROR_PENDING'); assert.equal(staged.pending.abiSaved, true);
    assert.equal(staged.blocked.code, 'ABS_TRANSACTION_PENDING');
    assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), staged.abi);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.aily/abs-sync/baselines/g2.json'), 'utf8')).inputAbs, staged.source);
    window.destroy();
    await open(); // Lose every renderer object, then recover solely from host files.
    const recovered = await window.webContents.executeJavaScript(`(async () => ({
      result: await window.store.recover(() => {}), loaded: await window.store.load('g2'),
      repeated: await window.store.recover(() => {})
    }))()`);
    assert.equal(recovered.result.status, 'COMMITTED'); assert.equal(recovered.repeated, null);
    assert.deepEqual(recovered.loaded, staged.projection);
    assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), staged.abi, 'Recovery must not replay ABI save');
    assert.equal(fs.readFileSync(path.join(root, 'project.abs'), 'utf8'), staged.projection.abs);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'project.abs.map.json'), 'utf8')), staged.projection.map);
    const block = JSON.parse(staged.abi).blocks.blocks[0];
    assert.equal(block.id, 'root-keep'); assert.equal(block.deletable, false); assert.equal(block.movable, false);
    assert.equal(block.collapsed, true); assert.equal(block.data, 'opaque metadata'); assert.equal(block.fields.LABEL, 'after');
    assert.equal(block.inputs.VALUE.shadow.id, 'dormant-keep'); assert.equal(block.inputs.VALUE.block.id, 'child-keep');
    const escaped = await window.webContents.executeJavaScript(`(async () => {
      let saved;
      await window.storage.withLock(async locked => { saved = locked; });
      try { await saved.replace('prepared.json', null, 'late'); return false; } catch { return true; }
    })()`);
    assert.equal(escaped, true);
    process.stdout.write('PROJECT_SYNC_BRIDGE_OK\n');
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); app.exit(1); }
});
