import { valid } from 'semver';

interface TemplatePathApi {
  join(...parts: string[]): string;
}

interface TemplateReadApi {
  lstatSync(path: string): { _isDirectory: boolean; _isFile: boolean };
  readFileSync(path: string): string;
}

function readObject(file: string, fs: TemplateReadApi): Record<string, unknown> | undefined {
  if (!fs.lstatSync(file)._isFile) return undefined;
  const value = JSON.parse(fs.readFileSync(file));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** Reuse only the selected installed version and its complete Blockly template.
 * Project libraries and versioned SDK resources retain their normal lifecycle. */
export function findReusableBlocklyBoardTemplate(
  boardPath: string,
  board: { name: string; version: string },
  path: TemplatePathApi,
  fs: TemplateReadApi,
): { templatePath: string; useDefaultSource: false } | undefined {
  const version = String(board.version || '').trim();
  if (!valid(version)) return undefined;
  try {
    if (!fs.lstatSync(boardPath)._isDirectory) return undefined;
    const installed = readObject(path.join(boardPath, 'package.json'), fs);
    if (installed?.['name'] !== board.name || installed['version'] !== version) return undefined;
    if (!readObject(path.join(boardPath, 'board.json'), fs)) return undefined;
    const templatePath = path.join(boardPath, 'template');
    if (!fs.lstatSync(templatePath)._isDirectory) return undefined;
    const manifest = readObject(path.join(templatePath, 'package.json'), fs);
    if (!manifest || manifest['type'] === 'coder') return undefined;
    const dependencies = manifest['dependencies'];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return undefined;
    const requested = (dependencies as Record<string, unknown>)[board.name];
    if (requested !== version) return undefined;
    const workspace = readObject(path.join(templatePath, 'project.abi'), fs);
    const blocks = workspace?.['blocks'];
    if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)
      || !Array.isArray((blocks as Record<string, unknown>)['blocks'])) return undefined;
    return { templatePath, useDefaultSource: false };
  } catch {
    // Missing, unreadable or malformed cache entries use the original install.
    return undefined;
  }
}
