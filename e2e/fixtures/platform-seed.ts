import {constants} from 'node:fs';
import {cp, copyFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {expect} from '@playwright/test';

// Clone installed platform assets, rather than downloading SDKs during an editor
// test or allowing writes into the user's cache. Only opening/generation is tested.
export async function seedPlatform(project: string, target: string, seed = process.env['AILY_E2E_PLATFORM_SEED']): Promise<void> {
  if (!seed) return;
  const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  const board = Object.keys(pkg.dependencies).find(name => name.includes('/board-'))!;
  const dependencies = JSON.parse(await readFile(path.join(project, 'node_modules', board, 'package.json'), 'utf8')).boardDependencies;
  for (const [name, version] of Object.entries(dependencies)) {
    const packageDirectory = path.join('node_modules', name);
    const metadata = path.join(seed, packageDirectory, 'package.json');
    expect(JSON.parse(await readFile(metadata, 'utf8')).version).toBe(version);
    await mkdir(path.join(target, packageDirectory), { recursive: true });
    await copyFile(metadata, path.join(target, packageDirectory, 'package.json'));
    const kind = name.includes('/sdk-') ? 'sdk' : 'tools';
    const short = name.replace(/^@aily-project\/(sdk|compiler|tool)-/, '');
    const assetName = short === 'idf_esp32s3' ? 'esp32-arduino-libs' : short;
    const expected = `${assetName}${kind === 'sdk' ? '_' : '@'}${version}`;
    const directory = (await readdir(path.join(seed, kind))).find(entry => entry === expected || entry.startsWith(`${expected.replace(/\.0$/, '')}-arduino`));
    expect(directory, `Installed platform directory: ${name}`).toBeTruthy();
    await cp(path.join(seed, kind, directory!), path.join(target, kind, directory!), { recursive: true, mode: constants.COPYFILE_FICLONE });
  }
  // The new-project wizard installs its board into this appdata directory.
  // Record seeded packages so npm preserves them instead of removing them as
  // extraneous packages and needlessly downloading their SDKs again.
  const manifestPath = path.join(target, 'package.json');
  let manifest: any;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    manifest = {name: 'aily-e2e-platform-seed', private: true};
  }
  manifest.dependencies = {...manifest.dependencies, ...dependencies};
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
