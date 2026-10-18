import { satisfies, validRange } from 'semver';

export interface CloudDependencyPackage {
  readonly name: string;
  readonly packageRoot: string;
}

export interface CloudDependencyInventory {
  readonly root: string;
  readonly libraries: readonly CloudDependencyPackage[];
}

interface InventoryApis {
  path: {
    resolve(value: string): string;
    relative(from: string, to: string): string;
    join(...parts: string[]): string;
    dirname(value: string): string;
    isAbsolute(value: string): boolean;
  };
  fs: {
    readFile(file: string, encoding: string): Promise<string>;
    realpathAsync(file: string): Promise<string>;
    existsSync(file: string): boolean;
  };
  assertCurrent: () => void;
}

const MANAGED_PREFIX = /^@aily-project(?:-coder|-linux)?\/(?:lib|board|coder)-/;
const MANAGED_PACKAGE = /^@aily-project(?:-coder|-linux)?\/(?:lib|board|coder)-[\w.-]+$/;
const PACKAGE_NAME = /^(?:@[\w-][\w.-]*\/)?[\w-][\w.-]*$/;
// 源码扫描策略只属于依赖模块：core 库由服务器 SDK 提供，不作为项目库展开。
const isCloudLibraryPackageName = (value: string) => /^@aily-project(?:-coder|-linux)?\/lib-[\w.-]+$/.test(value)
  && !/^@aily-project(?:-coder|-linux)?\/lib-core/.test(value);

/**
 * 一次扫描同时提供依赖完整性检查和待展开的库源码清单，避免两条流程重复遍历。
 * 独立保留此模块，使 npm 安装流程与依赖解析规则分离，便于复用及验证。
 */
export async function scanCloudDependencyInventory(
  projectPath: string, { path, fs, assertCurrent }: InventoryApis,
): Promise<CloudDependencyInventory> {
  const root = path.resolve(projectPath);
  const inside = (base: string, candidate: string) => {
    const relative = path.relative(base, candidate);
    return relative !== '..' && !relative.startsWith('../') && !relative.startsWith('..\\') && !path.isAbsolute(relative);
  };
  const readManifest = async (directory: string) => {
    assertCurrent();
    const file = path.join(directory, 'package.json');
    if (!inside(rootReal, await fs.realpathAsync(file))) throw new Error('Cloud dependency manifest escapes the project.');
    const text = await fs.readFile(file, 'utf8');
    assertCurrent();
    const manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid cloud dependency manifest.');
    return manifest;
  };
  const declarations = (dependencies: any): Array<[string, string]> => {
    if (dependencies === undefined) return [];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error('Invalid cloud dependency declarations.');
    return Object.entries(dependencies).map(([name, version]): [string, string] => {
      if (typeof version !== 'string' || !version.trim()) throw new Error('Invalid cloud dependency version.');
      return [name, version];
    });
  };
  const managed = (name: string) => {
    const supported = MANAGED_PACKAGE.test(name);
    if (MANAGED_PREFIX.test(name) && !supported) throw new Error('Unsafe cloud library package name.');
    return supported;
  };
  const validatePackage = (manifest: any, name: string, declaration: string) => {
    const alias = declaration.startsWith('npm:')
      ? /^npm:((?:@[\w-][\w.-]*\/)?[\w-][\w.-]*)(?:@(.+))?$/.exec(declaration) : undefined;
    if (declaration.startsWith('npm:') && !alias) throw new Error('Invalid cloud dependency alias.');
    if (manifest.name !== (alias?.[1] || name)) throw new Error(`Cloud dependency package identity differs: ${name}`);
    // 标签、本地路径和 Git 声明由 npm 解析；版本范围则在本地验证，防止误用其他版本的库。
    const range = validRange(alias ? alias[2] || '*' : declaration);
    if (range && (typeof manifest.version !== 'string' || !satisfies(manifest.version, range))) {
      throw new Error(`Cloud dependency version differs: ${name}`);
    }
  };
  const rootReal = await fs.realpathAsync(root);
  assertCurrent();
  const manifest = await readManifest(root);
  const pending = [...new Map([...declarations(manifest.dependencies), ...declarations(manifest.devDependencies)])]
    .map(([name, version]) => ({ name, version, from: root }));
  const checked = new Set<string>();
  const packagesByRoot = new Map<string, { manifest?: any; requirements: Array<{ name: string; version: string }> }>();
  const libraries: CloudDependencyPackage[] = [];
  // 按 Node 的逐级 node_modules 规则定位依赖，同时限制在当前工程内，避免上传工程外文件。
  const resolve = (name: string, from: string): string => {
    if (!PACKAGE_NAME.test(name)) throw new Error('Unsafe cloud dependency package name.');
    for (let cursor = from; inside(root, cursor); cursor = path.dirname(cursor)) {
      const candidate = path.join(cursor, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (cursor === root || path.dirname(cursor) === cursor) break;
    }
    throw new Error(`Cloud library package is missing: ${name}`);
  };
  while (pending.length) {
    assertCurrent();
    // 每批最多读取 8 个清单，降低 IPC 开销，并限制扫描规模，避免长时间占用编辑器。
    const batch: CloudDependencyPackage[] = [];
    while (pending.length && batch.length < 8) {
      const { name, version, from } = pending.shift()!;
      const isManaged = managed(name);
      const packageRoot = resolve(name, from);
      if (isManaged) {
        let entry = packagesByRoot.get(packageRoot);
        if (!entry) packagesByRoot.set(packageRoot, entry = { requirements: [] });
        entry.requirements.push({ name, version });
        if (entry.manifest) validatePackage(entry.manifest, name, version);
      }
      if (checked.has(packageRoot)) continue;
      checked.add(packageRoot);
      if (checked.size > 512) throw new Error('Cloud library dependency inventory exceeds its limit.');
      if (isManaged) batch.push({ name, packageRoot });
    }
    const packages = await Promise.all(batch.map(async item => {
      if (!inside(rootReal, await fs.realpathAsync(item.packageRoot))) {
        throw new Error(`Cloud library package escapes the project: ${item.name}`);
      }
      assertCurrent();
      return { item, manifest: await readManifest(item.packageRoot) };
    }));
    assertCurrent();
    for (const { item, manifest: pkg } of packages) {
      const entry = packagesByRoot.get(item.packageRoot)!;
      entry.manifest = pkg;
      for (const { name, version } of entry.requirements) validatePackage(pkg, name, version);
      if (isCloudLibraryPackageName(item.name)) libraries.push(item);
      for (const [name, version] of declarations(pkg.dependencies)) {
        if (managed(name)) pending.push({ name, version, from: item.packageRoot });
      }
    }
  }
  assertCurrent();
  return { root, libraries };
}
