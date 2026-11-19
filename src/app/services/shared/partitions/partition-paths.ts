export function resolvePartitionPaths(projectPath: string, pkg: any, isCoder: boolean, path: any) {
  const root = path.resolve(projectPath);
  const source = isCoder ? path.dirname(path.join(root, pkg.arduinoSketch === true ? '.' : 'sketch', pkg.entry || 'src/main.cpp')) : path.join(root, 'src');
  const filePath = path.join(source, 'partitions.csv');
  const relative = path.relative(root, filePath);
  if (!relative || relative === '..' || relative.startsWith('../') || relative.startsWith('..\\') || path.isAbsolute(relative)) {
    throw new Error('项目入口路径超出当前项目，无法保存分区。');
  }
  return { filePath, legacyPath: path.join(root, 'partitions.csv') };
}
