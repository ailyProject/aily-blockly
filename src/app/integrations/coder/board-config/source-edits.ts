/** Source equivalents of the host's CDC restoration and board dropdown fallback. */
export interface BoardSourceEdit { path: string; before: string; after: string }
type Board = Record<string, any>;

function values(board: Board, key: string): string[] {
  return (Array.isArray(board?.[key]) ? board[key] : []).map((entry: any) => String(entry[1]));
}

/** Keep offsets while excluding comments, strings, raw strings and include directives. */
export function cppCodeMask(source: string): string {
  return source.replace(
    /(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|\/\/(?:\\(?:\r\n|\n|.)|[^\\\r\n])*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|^[ \t]*#[ \t]*include[^\r\n]*/gm,
    text => text.replace(/[^\r\n]/g, ' '),
  );
}

export function updateBoardSource(source: string, key: string, previous: Board, next: Board): string {
  const replacements = new Map<string, string>();
  if (key === 'CDCOnBoot' && previous?.['_cdcEnabled'] === true && next?.['_cdcEnabled'] === false) {
    const target = values(next, 'cdcSerialPort')[0];
    if (target && target !== 'Serial0') replacements.set('Serial0', target);
  }
  const pinKeys = ['digitalPins', 'analogPins', 'pwmPins', 'servoPins', 'interruptPins'];
  if (key === 'pnum') {
    const available = new Set(pinKeys.flatMap(group => values(next, group)));
    const fallback = values(next, 'digitalPins')[0];
    if (fallback) for (const pin of pinKeys.flatMap(group => values(previous, group))) {
      // Numeric literals have no pin identity outside a known API argument.
      if (!available.has(pin) && /^[A-Za-z_]\w*$/.test(pin)) replacements.set(pin, fallback);
    }
  }
  const mask = cppCodeMask(source);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const add = (start: number, value: string, old: string) => {
    if (value !== old && !edits.some(edit => edit.start === start)) edits.push({ start, end: start + old.length, value });
  };
  if (key === 'pnum') {
    const calls: Record<string, string> = {
      pinMode: 'digitalPins', digitalRead: 'digitalPins', digitalWrite: 'digitalPins',
      analogRead: 'analogPins', analogWrite: 'pwmPins', digitalPinToInterrupt: 'interruptPins',
    };
    for (const match of mask.matchAll(/\b(pinMode|digitalRead|digitalWrite|analogRead|analogWrite|digitalPinToInterrupt)\s*\(\s*([A-Za-z_]\w*|\d+)\s*(?=[,)])/g)) {
      if (/(?:\.|->|::)\s*$/.test(mask.slice(0, match.index))) continue;
      const group = calls[match[1]], pin = match[2], available = values(next, group);
      if (available.length && values(previous, group).includes(pin) && !available.includes(pin)) {
        add(match.index! + match[0].lastIndexOf(pin), available[0], pin);
      }
    }
  }
  for (const match of mask.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const value = replacements.get(match[0]);
    if (!value) continue;
    const prefix = mask.slice(0, match.index).trimEnd();
    if (/(?:\.|->|::)$/.test(prefix)) continue;
    // User-defined objects/macros cannot be distinguished from board symbols by
    // spelling alone. Refuse the change rather than rename a local declaration.
    const name = match[0];
    if (new RegExp(`^\\s*#\\s*(?:define|undef)\\s+${name}\\b`, 'm').test(source)
      || new RegExp(`\\b(?!return\\b|throw\\b|case\\b|co_return\\b)[A-Za-z_]\\w*(?:::\\w+)*(?:\\s*<[^;{}]*>)?(?:\\s+|\\s*[*&]\\s*)[*&]*\\s*${name}\\s*(?=[=;,(){}\\[])`).test(mask)) {
      throw new Error(`源码自定义了 ${name}，请先重命名该标识符再切换主板配置。`);
    }
    add(match.index!, value, name);
  }
  return edits.sort((a, b) => b.start - a.start).reduce((text, edit) =>
    text.slice(0, edit.start) + edit.value + text.slice(edit.end), source);
}

/** Scan project-owned source only; never traverse dependency or symlink trees. */
export function planBoardSourceEdits(project: string, manifest: any, key: string, previous: Board, next: Board): BoardSourceEdit[] {
  if (key !== 'CDCOnBoot' && key !== 'pnum') return [];
  const fs = window['fs'], path = window['path'];
  const roots = manifest.arduinoSketch === true ? ['.'] : ['sketch', ...(manifest.sourceRoots || [])];
  const visited = new Set<string>(), edits: BoardSourceEdit[] = [];
  const visit = (directory: string) => {
    if (visited.has(directory) || !fs.existsSync(directory)) return;
    visited.add(directory);
    for (const entry of fs.readDirSync(directory)) {
      if (/^(?:node_modules|libraries|build|dist|\.git|\.aily|\.temp)$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry._isDirectory) visit(file);
      else if (entry._isFile && /\.(?:ino|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(entry.name)) {
        const before = fs.readFileSync(file, 'utf8');
        const after = updateBoardSource(before, key, previous, next);
        if (before !== after) edits.push({ path: file, before, after });
      }
    }
  };
  for (const root of roots) {
    if (typeof root !== 'string' || root.split(/[/\\]/).some(part => /^(?:node_modules|libraries|build|dist|\.git|\.aily|\.temp)$/.test(part)) || /^(?:\/|\\|[A-Za-z]:)/.test(root) || root.split(/[/\\]/).includes('..')) continue;
    // readDirSync exposes symlinks as neither files nor directories. Check roots too.
    const directory = path.join(project, root);
    let current = project;
    const safe = root.split(/[/\\]/).filter(part => part && part !== '.').every(part => {
      current = path.join(current, part);
      return fs.existsSync(current) && !fs.lstatSync(current)._isSymbolicLink;
    });
    if (safe && fs.existsSync(directory) && !fs.lstatSync(directory)._isSymbolicLink) visit(directory);
  }
  return edits;
}

export function writeBoardSourceEdits(edits: BoardSourceEdit[]): void {
  const fs = window['fs'];
  for (const edit of edits) if (fs.readFileSync(edit.path, 'utf8') !== edit.before) {
    throw new Error(`源码已变化，请重新选择配置：${edit.path}`);
  }
  const written: BoardSourceEdit[] = [];
  try {
    for (const edit of edits) {
      written.push(edit);
      fs.writeFileSync(edit.path, edit.after);
    }
  } catch (error) {
    for (const edit of written.reverse()) fs.writeFileSync(edit.path, edit.before);
    throw error;
  }
}
