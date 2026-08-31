import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const appRoot = path.join(repositoryRoot, 'src', 'app');
const servicesRoot = path.join(appRoot, 'services');
const baselinePath = path.join(scriptDirectory, 'angular-service-architecture-baseline.json');
const inventoryPath = path.join(
  repositoryRoot,
  'docs',
  '2026-08-24',
  'angular-service-inventory.json',
);
const architectureRoots = [
  path.join(servicesRoot, 'core'),
  path.join(servicesRoot, 'domains'),
  path.join(servicesRoot, 'integrations'),
  path.join(servicesRoot, 'shared'),
];
const aliasRoots = new Map([
  ['@core/', path.join(servicesRoot, 'core')],
  ['@domain/', path.join(servicesRoot, 'domains')],
  ['@integration/', path.join(servicesRoot, 'integrations')],
  ['@shared/', path.join(servicesRoot, 'shared')],
]);
const uiDirectoryNames = new Set([
  'components',
  'editors',
  'main-window',
  'pages',
  'tools',
  'windows',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function relativeToRepository(filePath) {
  return toPosix(path.relative(repositoryRoot, filePath));
}

function listTypeScriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const result = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listTypeScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push(path.resolve(entryPath));
    }
  }
  return result.sort();
}

function architectureDomain(filePath) {
  const relativePath = toPosix(path.relative(servicesRoot, filePath));
  const segments = relativePath.split('/');
  if (segments[0] === 'core' && segments[1]) {
    return `core/${segments[1]}`;
  }
  if (segments[0] === 'domains' && segments[1]) {
    return `domains/${segments[1]}`;
  }
  if (segments[0] === 'integrations' && segments[1]) {
    return `integrations/${segments[1]}`;
  }
  if (segments[0] === 'shared') {
    return 'shared';
  }
  return null;
}

function architectureLayer(filePath) {
  const domain = architectureDomain(filePath);
  if (!domain) {
    return 'application';
  }
  if (domain === 'shared') {
    return 'shared';
  }
  if (domain === 'core/platform') {
    return 'platform';
  }
  if (domain === 'core/app-shell') {
    return 'app-shell';
  }
  if (domain.startsWith('core/')) {
    return 'core';
  }
  if (domain.startsWith('domains/')) {
    return 'domain';
  }
  return 'integration';
}

function isUiFile(filePath) {
  const relativePath = toPosix(path.relative(appRoot, filePath));
  return uiDirectoryNames.has(relativePath.split('/')[0]);
}

function resolvePathCandidate(candidate) {
  const candidates = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    path.join(candidate, 'index.ts'),
    path.join(candidate, 'public-api.ts'),
  ];
  return candidates.find((current) => fs.existsSync(current) && fs.statSync(current).isFile()) ?? null;
}

function resolveModule(sourcePath, specifier) {
  if (specifier.startsWith('.')) {
    return resolvePathCandidate(path.resolve(path.dirname(sourcePath), specifier));
  }
  for (const [prefix, root] of aliasRoots) {
    if (specifier.startsWith(prefix)) {
      return resolvePathCandidate(path.join(root, specifier.slice(prefix.length)));
    }
  }
  return null;
}

function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

const allAppFiles = listTypeScriptFiles(appRoot);
const architectureFiles = uniqueSorted(architectureRoots.flatMap(listTypeScriptFiles));
const architectureFileSet = new Set(architectureFiles);
const moduleGraph = new Map(architectureFiles.map((filePath) => [filePath, []]));
const importedBy = new Map(architectureFiles.map((filePath) => [filePath, new Set()]));
const violations = [];

function addViolation(rule, sourcePath, specifier, targetPath, detail) {
  const source = sourcePath ? relativeToRepository(sourcePath) : '-';
  const target = targetPath ? relativeToRepository(targetPath) : '-';
  violations.push({
    key: `${rule}|${source}|${specifier ?? '-'}|${target}`,
    rule,
    source,
    specifier: specifier ?? null,
    target,
    detail,
  });
}

const looseServiceFiles = fs.existsSync(servicesRoot)
  ? fs.readdirSync(servicesRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(servicesRoot, entry.name))
    .sort()
  : [];
for (const filePath of looseServiceFiles) {
  addViolation(
    'loose-services-root-file',
    filePath,
    null,
    null,
    'TypeScript files must live in a named domain below src/app/services.',
  );
}

for (const sourcePath of allAppFiles) {
  const content = fs.readFileSync(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sourceDomain = architectureDomain(sourcePath);
  const sourceLayer = architectureLayer(sourcePath);
  for (const specifier of collectModuleSpecifiers(sourceFile)) {
    const targetPath = resolveModule(sourcePath, specifier);
    if (!targetPath || !targetPath.startsWith(appRoot + path.sep)) {
      continue;
    }
    if (architectureFileSet.has(targetPath)) {
      importedBy.get(targetPath)?.add(sourcePath);
    }
    if (architectureFileSet.has(sourcePath) && architectureFileSet.has(targetPath)) {
      moduleGraph.get(sourcePath).push(targetPath);
    }

    const targetDomain = architectureDomain(targetPath);
    const targetLayer = architectureLayer(targetPath);
    if (!sourceDomain && targetDomain && !specifier.endsWith('/public-api')) {
      addViolation(
        'external-deep-import',
        sourcePath,
        specifier,
        targetPath,
        'Application UI must consume an architecture domain through public-api.',
      );
    }
    if (
      sourceDomain
      && targetDomain
      && sourceDomain !== targetDomain
      && !specifier.endsWith('/public-api')
    ) {
      addViolation(
        'cross-domain-deep-import',
        sourcePath,
        specifier,
        targetPath,
        'Cross-domain imports must use the target public-api.',
      );
    }
    if (sourceLayer === 'shared' && targetLayer !== 'shared') {
      addViolation(
        'shared-upward-import',
        sourcePath,
        specifier,
        targetPath,
        'shared cannot depend on core, domains, integrations, or application UI.',
      );
    }
    if (sourceLayer === 'platform' && (isUiFile(targetPath) || targetLayer === 'app-shell')) {
      addViolation(
        'platform-ui-import',
        sourcePath,
        specifier,
        targetPath,
        'core/platform cannot depend on UI or app-shell orchestration.',
      );
    }
    if (sourceLayer === 'domain' && (isUiFile(targetPath) || targetLayer === 'app-shell')) {
      addViolation(
        'domain-ui-import',
        sourcePath,
        specifier,
        targetPath,
        'Domain code cannot depend on UI or app-shell orchestration.',
      );
    }
    if (sourceLayer === 'integration' && isUiFile(targetPath)) {
      addViolation(
        'integration-ui-import',
        sourcePath,
        specifier,
        targetPath,
        'Integration code should use a host/domain port instead of importing UI implementation.',
      );
    }
  }
}

function findCycles(graph) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const cycles = [];

  function visit(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dependency)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) {
      return;
    }
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1) {
      cycles.push(component.map(relativeToRepository).sort());
    }
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) {
      visit(node);
    }
  }
  return cycles.sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

const cycles = findCycles(moduleGraph);
const violationKeys = uniqueSorted(violations.map(({ key }) => key));
const cycleKeys = cycles.map((cycle) => cycle.join('::'));
const inventory = architectureFiles
  .filter((filePath) => !filePath.endsWith('/public-api.ts'))
  .map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const imports = collectModuleSpecifiers(sourceFile)
      .map((specifier) => resolveModule(filePath, specifier))
      .filter((targetPath) => targetPath?.startsWith(appRoot + path.sep))
      .map(relativeToRepository);
    return {
      path: relativeToRepository(filePath),
      domain: architectureDomain(filePath),
      kind: /@Injectable\b/.test(content) ? 'injectable' : 'module',
      providedInRoot: /providedIn\s*:\s*['"]root['"]/.test(content),
      lines: content.split(/\r?\n/).length,
      imports: uniqueSorted(imports),
      importedByCount: importedBy.get(filePath)?.size ?? 0,
    };
  });

const argumentsSet = new Set(process.argv.slice(2));
if (argumentsSet.has('--write-inventory')) {
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`Wrote ${path.relative(repositoryRoot, inventoryPath)} (${inventory.length} entries).`);
}
if (argumentsSet.has('--inventory')) {
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  process.exit(0);
}
if (argumentsSet.has('--write-baseline')) {
  if (looseServiceFiles.length > 0) {
    console.error(
      'Refusing to baseline loose TypeScript files in src/app/services. '
        + 'Move them into core, domains, integrations, or shared first.',
    );
    process.exit(1);
  }
  const baseline = {
    schemaVersion: 1,
    violations: violationKeys,
    cycles: cycleKeys,
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `Wrote ${path.relative(repositoryRoot, baselinePath)} `
      + `(${violationKeys.length} violations, ${cycleKeys.length} cycles).`,
  );
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error(
    'Architecture baseline is missing. After the directory migration, run '
      + '`node scripts/check-angular-service-architecture.mjs --write-baseline --write-inventory`.',
  );
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const allowedViolations = new Set(baseline.violations ?? []);
const allowedCycleNodeSets = (baseline.cycles ?? []).map(
  (cycle) => new Set(cycle.split('::')),
);
const newViolationKeys = violationKeys.filter((key) => !allowedViolations.has(key));
const newCycleKeys = cycleKeys.filter((key) => {
  const currentNodes = key.split('::');
  return !allowedCycleNodeSets.some(
    (allowedNodes) => currentNodes.every((node) => allowedNodes.has(node)),
  );
});

const violationCountsByRule = violationKeys.reduce((counts, key) => {
  const rule = key.split('|')[0];
  counts[rule] = (counts[rule] ?? 0) + 1;
  return counts;
}, {});

console.log(
  `Angular service architecture: ${inventory.length} files, `
    + `${violationKeys.length} baseline violations, ${cycleKeys.length} cycles.`,
);
if (violationKeys.length > 0) {
  console.log(
    `Baseline debt: ${Object.entries(violationCountsByRule)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rule, count]) => `${rule}=${count}`)
      .join(', ')}.`,
  );
}
if (argumentsSet.has('--report') && violationKeys.length > 0) {
  console.log('\nCurrent architecture violations:');
  const violationByKey = new Map(violations.map((violation) => [violation.key, violation]));
  for (const key of violationKeys) {
    const violation = violationByKey.get(key);
    console.log(`- [${violation.rule}] ${violation.source}`);
    console.log(`  ${violation.specifier ?? '-'} -> ${violation.target}`);
  }
}
if (argumentsSet.has('--report') && cycleKeys.length > 0) {
  console.log('\nCurrent architecture cycles:');
  for (const cycle of cycleKeys) {
    console.log(`- ${cycle}`);
  }
}
if (newViolationKeys.length === 0 && newCycleKeys.length === 0) {
  console.log('No new architecture debt detected.');
  process.exit(0);
}

if (newViolationKeys.length > 0) {
  console.error('\nNew architecture violations:');
  for (const key of newViolationKeys) {
    const violation = violations.find((candidate) => candidate.key === key);
    console.error(`- [${violation?.rule}] ${violation?.source} -> ${violation?.target}`);
    console.error(`  ${violation?.detail}`);
  }
}
if (newCycleKeys.length > 0) {
  console.error('\nNew architecture cycles:');
  for (const cycle of newCycleKeys) {
    console.error(`- ${cycle}`);
  }
}
process.exit(1);
