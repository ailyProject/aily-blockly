const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = process.env.AILY_PROJECT_FILE_TEST_ROOT;
app.setPath('userData', path.join(root, 'electron-profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false,
    preload: path.join(__dirname, 'project-file-writer-preload.cjs') } });
  try {
    await window.loadURL('data:text/html,<title>Project file bridge test</title>');
    assert.equal(await window.webContents.executeJavaScript('window.projectFiles.projectFilePublicationVersion'), 2);
    const request = { projectPath: root, fileName: 'project.abi', content: '桥接 😀\r\n',
      expectedHash: 'sha256:' + createHash('sha256').update('before').digest('hex') };
    const cancelled = await window.webContents.executeJavaScript(`(async()=>{
      window.current = true;
      const pending = window.projectFiles.replaceProjectText(${JSON.stringify(request)}, () => { if (!window.current) throw new Error('stale renderer'); });
      window.current = false;
      return pending;
    })()`);
    assert.equal(cancelled.status, 'NOT_COMMITTED');
    assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), 'before');
    const result = await window.webContents.executeJavaScript(`window.projectFiles.replaceProjectText(${JSON.stringify(request)}, () => {})`);
    assert.equal(result.status, 'COMMITTED');
    assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), request.content);
    const migration = { ...request, content: '{"normalized":true}', backup: 'project-data',
      expectedHash: 'sha256:' + createHash('sha256').update(request.content).digest('hex') };
    const migrated = await window.webContents.executeJavaScript(`window.projectFiles.replaceProjectText(${JSON.stringify(migration)}, () => {})`);
    assert.equal(migrated.status, 'COMMITTED'); assert.equal(migrated.backupHash, migration.expectedHash);
    assert.equal(fs.readFileSync(path.join(root, '.aily/project-data-backups', migration.expectedHash.slice(7) + '.abi'), 'utf8'), request.content);
    const copySource = path.join(root, 'source'); const copyTarget = path.join(root, 'copy');
    fs.mkdirSync(path.join(copySource, '.aily'), { recursive: true }); fs.mkdirSync(copyTarget);
    fs.writeFileSync(path.join(copySource, 'project.abi'), migration.content);
    fs.writeFileSync(path.join(copySource, '.aily/project-files.write.lock'), 'source owner');
    await window.webContents.executeJavaScript(`window.projectFiles.copyProjectDirectory(${JSON.stringify(copySource)}, ${JSON.stringify(copyTarget)})`);
    assert.equal(fs.readFileSync(path.join(copyTarget, 'project.abi'), 'utf8'), migration.content);
    assert.equal(fs.existsSync(path.join(copyTarget, '.aily/project-files.write.lock')), false);
    process.stdout.write('PROJECT_FILE_BRIDGE_OK\n');
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window.destroy(); app.exit(1); }
});
