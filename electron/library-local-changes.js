const fs = require('node:fs/promises');
const path = require('node:path');

/** Local Coder libraries have no npm archive to reinstall. Keep their bytes in
 * the main process until save/discard, just like an unsaved editor buffer. */
class LocalLibraryChanges {
  constructor({ trash = target => require('electron').shell.trashItem(target) } = {}) {
    this.projects = new Map();
    this.trash = trash;
  }
  snapshot(root) { return new Map(this.projects.get(root)); }
  dirty(root) { return Boolean(this.projects.get(root)?.size); }

  async target(root, folder) {
    if (typeof folder !== 'string' || !folder || folder.startsWith('.') || /[/\\\0]/u.test(folder)) {
      throw new Error('Invalid local library folder');
    }
    let directory = root;
    for (const segment of ['sketch', 'libraries']) {
      directory = path.join(directory, segment);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Local library path must stay inside the project');
    }
    return path.join(directory, folder);
  }

  async remove(root, folder) {
    const target = await this.target(root, folder);
    const entries = [];
    let bytes = 0;
    const collect = async (relative = '') => {
      const file = path.join(target, relative), stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error('Local libraries containing links or special files cannot be removed');
      }
      if (stat.isDirectory()) {
        entries.push({ relative, directory: true, mode: stat.mode });
        for (const child of await fs.readdir(file)) await collect(path.join(relative, child));
      } else {
        bytes += stat.size;
        if (bytes > 256 * 1024 * 1024) throw new Error('Local library exceeds the 256 MB unsaved removal limit');
        entries.push({ relative, content: await fs.readFile(file), mode: stat.mode });
      }
    };
    await collect();
    const pending = this.projects.get(root) || new Map();
    if (pending.has(folder)) throw new Error('请先保存或放弃该本地库之前的卸载操作。');
    pending.set(folder, entries);
    this.projects.set(root, pending);
    // The system trash remains a recovery path even if the main process crashes.
    // No project-local draft or manifest backup is created.
    try { await this.trash(target); }
    catch (error) {
      await this.restoreEntry(root, folder, entries, true);
      pending.delete(folder);
      if (!pending.size) this.projects.delete(root);
      throw error;
    }
  }

  async restoreEntry(root, folder, entries, merge = false) {
    const target = await this.target(root, folder);
    // A history restore/external writer may have already reinstated this root.
    // Its current bytes take precedence over the old editor snapshot.
    merge ||= entries.restoring === true;
    if (!merge && await fs.lstat(target).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) return;
    entries.restoring = true;
    for (const entry of entries) {
      const file = path.join(target, entry.relative);
      if (entry.directory) {
        await fs.mkdir(file, { recursive: true, mode: entry.mode });
        const stat = await fs.lstat(file);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Local library restore path changed');
      }
      else await fs.writeFile(file, entry.content, { flag: 'wx', mode: entry.mode }).catch(error => {
        if (!merge || error.code !== 'EEXIST') throw error;
      });
    }
    delete entries.restoring;
  }

  async restore(root, baseline = new Map()) {
    const pending = this.projects.get(root);
    if (!pending) return;
    for (const [folder, entries] of pending) {
      if (baseline.has(folder)) continue;
      await this.restoreEntry(root, folder, entries);
      pending.delete(folder);
    }
    if (!pending.size) this.projects.delete(root);
  }

  save(root) { this.projects.delete(root); }
}

module.exports = { LocalLibraryChanges };
