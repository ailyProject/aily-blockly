const path = require('path');
const { spawnSync } = require('child_process');
const { getProductAuthConfig } = require('../electron/build-product');

const BUILD_PRODUCTS = Object.freeze({
  blockly: Object.freeze({
    id: 'blockly',
    appId: 'blockly.aily.pro',
    productName: 'aily blockly',
    appUserModelId: 'pro.aily.blockly',
    outputDirectory: 'dist/aily-blockly/',
    artifactBase: 'aily-blockly',
    artifactBaseCn: 'aily-blockly-CN',
    installerInclude: 'build/installer.nsh',
    shortcutName: 'aily blockly',
  }),
  coder: Object.freeze({
    id: 'coder',
    appId: 'coder.aily.pro',
    productName: 'aily coder',
    appUserModelId: 'pro.aily.coder',
    outputDirectory: 'dist/aily-coder/',
    artifactBase: 'aily-coder',
    artifactBaseCn: 'aily-coder-CN',
    installerInclude: 'build/installer-coder.nsh',
    shortcutName: 'aily coder',
  }),
});

function readOption(args, option, fallback) {
  const index = args.indexOf(option);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function normalizeFlavor(value) {
  return value === 'global' ? 'global' : 'cn';
}

function normalizeProduct(value) {
  return value === 'coder' ? 'coder' : 'blockly';
}

function resolveProductUpdaterUrl(baseUrl, product) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (product !== 'coder') return normalized;
  return /\/blockly$/i.test(normalized)
    ? normalized.replace(/\/blockly$/i, '/coder')
    : `${normalized}/coder`;
}

function withoutFileAssociations(options = {}) {
  const { fileAssociations: _fileAssociations, ...rest } = options;
  return rest;
}

function createBuilderConfig(plan, baseConfig) {
  const product = plan.product;
  return {
    ...baseConfig,
    appId: product.appId,
    productName: product.productName,
    extraMetadata: {
      ...(baseConfig.extraMetadata || {}),
      ...(plan.buildProduct === 'coder'
        ? { name: 'aily-coder', productName: product.productName, description: product.productName }
        : {}),
      ailyBuildFlavor: plan.buildFlavor,
      ailyBuildProduct: plan.buildProduct,
      ailyAppUserModelId: product.appUserModelId,
    },
    directories: {
      ...(baseConfig.directories || {}),
      output: product.outputDirectory,
    },
    extraResources: (baseConfig.extraResources || []).filter(
      (resource) => resource?.to !== 'app-update.yml',
    ),
    publish: [{
      provider: 'generic',
      url: plan.updateBaseUrl,
    }],
    protocols: (baseConfig.protocols || []).map((protocol) => ({
      ...protocol,
      ...(protocol?.name === 'Aily Blockly OAuth'
        ? {
          name: plan.buildProduct === 'coder' ? 'Aily Coder OAuth' : protocol.name,
          schemes: getProductAuthConfig(plan.buildProduct).protocols,
        }
        : {}),
    })),
    win: {
      ...withoutFileAssociations(baseConfig.win),
      artifactName: `${plan.artifactPrefix}-\${version}.\${ext}`,
    },
    mac: {
      ...withoutFileAssociations(baseConfig.mac),
      artifactName: `${plan.artifactPrefix}-macos-\${version}-\${arch}.\${ext}`,
    },
    linux: {
      ...withoutFileAssociations(baseConfig.linux),
      artifactName: `${plan.artifactPrefix}-linux-\${version}-\${arch}.\${ext}`,
    },
    nsis: {
      ...(baseConfig.nsis || {}),
      artifactName: `${plan.artifactPrefix}-Setup-\${version}.\${ext}`,
      include: product.installerInclude,
      shortcutName: product.shortcutName,
    },
  };
}

function createBuildPlan(args, appConfig) {
  const buildFlavor = normalizeFlavor(readOption(args, '--flavor', 'cn'));
  const buildProduct = normalizeProduct(readOption(args, '--product', 'blockly'));
  const product = BUILD_PRODUCTS[buildProduct];
  const artifactPrefix = buildFlavor === 'cn'
    ? product.artifactBaseCn
    : product.artifactBase;
  const officialRegionKey = buildFlavor === 'global' ? 'eu' : 'cn';
  const configuredUpdateBaseUrl = appConfig?.regions?.[officialRegionKey]?.updater;
  const updateBaseUrl = resolveProductUpdaterUrl(configuredUpdateBaseUrl, buildProduct);

  if (!configuredUpdateBaseUrl) {
    throw new Error(`Missing updater URL for flavor "${buildFlavor}" (region: ${officialRegionKey})`);
  }

  const builderArgs = buildProduct === 'coder'
    ? ['build', '--config', 'build/electron-builder.coder.js']
    : [
      'build',
      `-c.extraMetadata.ailyBuildFlavor=${buildFlavor}`,
      `-c.extraMetadata.ailyBuildProduct=${buildProduct}`,
      `-c.extraMetadata.ailyAppUserModelId=${product.appUserModelId}`,
      '-c.publish.provider=generic',
      `-c.publish.url=${updateBaseUrl}`,
      `-c.win.artifactName=${artifactPrefix}-\${version}.\${ext}`,
      `-c.nsis.artifactName=${artifactPrefix}-Setup-\${version}.\${ext}`,
      `-c.mac.artifactName=${artifactPrefix}-macos-\${version}-\${arch}.\${ext}`,
    ];

  if (args.includes('--dir')) {
    builderArgs.push('--dir');
  }

  return {
    buildFlavor,
    buildProduct,
    product,
    artifactPrefix,
    officialRegionKey,
    updateBaseUrl,
    builderArgs,
  };
}

function run(commandArgs, workspaceRoot, environment) {
  const result = spawnSync(process.execPath, commandArgs, {
    stdio: 'inherit',
    cwd: workspaceRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ...environment,
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const error = new Error(`Build command failed with exit code ${result.status || 1}`);
    error.exitCode = result.status || 1;
    throw error;
  }
}

function main(args = process.argv.slice(2)) {
  const workspaceRoot = path.resolve(__dirname, '..');
  const appConfig = require(path.join(workspaceRoot, 'electron', 'config', 'config.json'));
  const plan = createBuildPlan(args, appConfig);
  const environment = {
    AILY_BUILD_FLAVOR: plan.buildFlavor,
    AILY_BUILD_PRODUCT: plan.buildProduct,
    AILY_BUILD_ARTIFACT_PREFIX: plan.artifactPrefix,
    AILY_BUILD_UPDATER_URL: plan.updateBaseUrl,
  };

  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ ...plan, environment }, null, 2));
    return;
  }

  const simulatorRuntimePrepareScript = path.join(
    workspaceRoot,
    'scripts',
    'prepare-simulator-runtime.js',
  );
  const ngCliPath = path.join(workspaceRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
  const electronBuilderCliPath = path.join(workspaceRoot, 'node_modules', 'electron-builder', 'cli.js');

  run([simulatorRuntimePrepareScript], workspaceRoot, environment);
  run([ngCliPath, 'build', '--base-href', './'], workspaceRoot, environment);
  run([electronBuilderCliPath, ...plan.builderArgs], workspaceRoot, environment);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exit(error?.exitCode || 1);
  }
}

module.exports = {
  BUILD_PRODUCTS,
  createBuilderConfig,
  createBuildPlan,
  normalizeFlavor,
  normalizeProduct,
  resolveProductUpdaterUrl,
};
