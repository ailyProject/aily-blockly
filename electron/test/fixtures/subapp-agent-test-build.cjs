'use strict';
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../../..');

async function bundleAgentBridge(browser = false) {
    const result = await esbuild.build({
        stdin: { contents: [
            "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service.ts';",
            "export { replaceChildToolConfigs } from './src/app/configs/tool.config.ts';",
        ].join('\n'), resolveDir: root, loader: 'ts' },
        bundle: true, platform: browser ? 'browser' : 'node', format: browser ? 'iife' : 'cjs',
        ...(browser ? { globalName: 'AgentBridgeFixture' } : {}), write: false,
        plugins: [{ name: 'angular-decorator-stub', setup(build) {
            build.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents:
                'export const Injectable = () => target => target; export const Inject = () => () => {}; export class InjectionToken {}', loader: 'js' }));
        } }],
    });
    return result.outputFiles[0].text;
}

async function loadAgentBridge() {
    const record = { exports: {} };
    new Function('require', 'module', 'exports', await bundleAgentBridge())(require, record, record.exports);
    return record.exports;
}

async function loadAgentClient(lexRoot) {
    const result = await esbuild.build({ stdin: { contents: [
        `export {SubappAgentSession} from ${JSON.stringify(path.join(lexRoot, 'packages/aily-agent/src/blockly/subapp-agent-session.ts'))};`,
        `export {discoverInstalledSubappAgentCatalog} from ${JSON.stringify(path.join(lexRoot, 'packages/aily-agent/src/blockly/subapp-agent-manifest.ts'))};`,
    ].join('\n'), resolveDir: lexRoot, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'explicit-test-transport', setup(build) {
        build.onResolve({ filter: /services\/app\/command$/ }, () => ({ path: 'transport', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export function appCommand(){throw new Error("Use the explicit acceptance transport");}', loader: 'js' }));
    } }] });
    const record = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, record, record.exports);
    return record.exports;
}

module.exports = { bundleAgentBridge, loadAgentBridge, loadAgentClient };
