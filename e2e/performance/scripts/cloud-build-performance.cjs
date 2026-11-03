const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { launchAilyElectron, getMainWindow, openBlocklyProject } = require('../../fixtures/electron-app.ts');
const protocol = require('../../../electron/cloud-build/protocol');
const { CloudBuildBroker } = require('../../../electron/cloud-build/broker');
// Opt in with real, installed Blockly project paths. Each source is copied;
// account state is a local Pro fixture, while compilation uses the real gateway.
const root = path.resolve(__dirname, '../../.artifacts/cloud-build-performance'), phase = process.env.PERF_PHASE || 'after';
fs.mkdirSync(root, { recursive: true });
const sources = JSON.parse(process.env.AILY_CLOUD_PERF_PROJECTS || '[]');
if (!Array.isArray(sources) || !sources.length || sources.some(p => typeof p !== 'string' || !path.isAbsolute(p)))
    throw new Error('AILY_CLOUD_PERF_PROJECTS must be a JSON array of absolute project paths');
const projects = sources.map((source, index) => ['project-' + (index + 1), source]);
const results = [];
let current;
function record(kind, data) { fs.appendFileSync(path.join(root, phase + '.jsonl'), JSON.stringify({ time: Date.now(), project: current?.name, iteration: current?.iteration, kind, data }) + '\n'); if (kind !== 'progress' || !data.log)
    console.log(kind, JSON.stringify(data).slice(0, 1000)); }
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    const settings = await new CloudBuildBroker().configuration();
    for (const [name, source] of projects) {
        const copyName = name + '-' + crypto.createHash('sha256').update(source).digest('hex').slice(0, 10);
        const project = path.join(root, 'projects', copyName);
        if (!fs.existsSync(project))
            fs.cpSync(source, project, { recursive: true, filter: file => !['.build', '.log', '.aily', '.temp', '.workspace-history', 'tests'].includes(path.relative(source, file).split(path.sep)[0]) });
        current = { name, iteration: 0 };
        process.env.AILY_E2E_DEV_URL ||= 'http://localhost:4200';
        const launch = await launchAilyElectron({ environment: { AILY_BUILD_PRODUCT: 'blockly', PI_CODING_AGENT_DIR: path.join(root, 'agent-' + phase + '-' + name) }, config: { selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: { backend: 'cloud' }, devmode: { enabled: true, autoSave: false } } });
        record('launch', { pid: launch.app.process().pid, userDataDir: launch.userDataDir, project });
        try {
            const main = await getMainWindow(launch.app);
            await main.exposeFunction('__cloudPerf', event => { record('progress', event); if (current)
                current.events.push({ time: Date.now(), ...event }); });
            current.events = [];
            await main.evaluate(() => window.cloudBuild.onProgress(event => window.__cloudPerf(event)));
            await main.addLocatorHandler(main.locator('app-login .login-close'), b => b.click());
            await main.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-main-window'))?.authService?.getAuthInitializationState() === 'signed_out');
            await main.evaluate(() => { const a = window.ng.getComponent(document.querySelector('app-main-window')).authService; a.isLoggedInSubject.next(true); a.setCurrentUserInfo({ id: 'cloud-performance-fixture', subscription_plan: { name: 'pro' } }); });
            await main.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).configService.getCompileBackend() === 'cloud');
            await openBlocklyProject(main, project);
            await main.waitForFunction(project => { const p = window.ng.getComponent(document.querySelector('app-header')).projectService; const s = p.getBlocklyProjectLoadStatus(project); if (s?.state === 'error')
                throw new Error(JSON.stringify(s)); return p.currentProjectPath === project && s?.ready === true; }, project, { timeout: 240000 });
            record('loaded', { project });
            for (let iteration = 1; iteration <= Number(process.env.PERF_REPEATS || 2) + (process.env.PERF_MUTATION_PROJECT === name ? 1 : 0); iteration++) {
                current = { name, iteration, events: [] };
                if (process.env.PERF_MUTATION_PROJECT === name && iteration === 3) {
                    const probe = path.join(project, 'src/cloud-cache-probe-' + Date.now() + '.h');
                    fs.mkdirSync(path.dirname(probe), { recursive: true });
                    fs.writeFileSync(probe, '#pragma once\n#define CLOUD_CACHE_PROBE 1\n');
                    record('mutation', { kind: 'source-file' });
                }
                const start = Date.now();
                await main.locator('app-header app-act-btn[data-action="compile"]').click();
                record('clicked', { start });
                let pkg, done = false;
                while (Date.now() - start < 600000) {
                    pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
                    if (Date.parse(pkg.buildInfo?.lastBuildTime || '') >= start) {
                        done = true;
                        break;
                    }
                    const failed = current.events.find(e => e.stage === 'failed');
                    if (failed)
                        throw new Error(JSON.stringify(failed));
                    await delay(1000);
                }
                const end = Date.now();
                if (!done || pkg.buildInfo.lastBuildStatus !== 'success')
                    throw new Error('Compilation did not succeed: ' + JSON.stringify(pkg.buildInfo));
                const artifact = await main.evaluate(project => window.cloudBuild.artifactPath({ projectPath: project }), project);
                const signed = JSON.parse(fs.readFileSync(path.join(artifact, 'aily-cloud-result.json')));
                protocol.verifyManifest(signed.manifest, signed.signature, settings.publicKey);
                for (const file of signed.manifest.artifacts) {
                    const bytes = fs.readFileSync(path.join(artifact, file.path));
                    if (bytes.length !== file.sizeBytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256)
                        throw new Error('Artifact verification failed: ' + file.path);
                }
                fs.writeFileSync(path.join(root, `${phase}-${name}-${iteration}-result.json`), JSON.stringify(signed, null, 2));
                const stages = current.events.filter(e => !e.log).reduce((list, e) => { if (list.at(-1)?.stage !== e.stage)
                    list.push({ stage: e.stage, ms: e.time - start, progress: e.progress, serverStage: e.serverStage }); return list; }, []);
                const reused = current.events.some(e => e.stage === 'complete' && e.reused === true);
                if (phase.startsWith('after') && iteration === 2 && (!reused || current.events.some(e => e.stage === 'queued') || signed.manifest.jobId !== results.at(-1)?.jobId))
                    throw new Error('Unchanged project did not reuse its verified result');
                if (process.env.PERF_MUTATION_PROJECT === name && iteration === 3 && (reused || signed.manifest.jobId === results.at(-1)?.jobId))
                    throw new Error('Edited project incorrectly reused stale output');
                const result = { phase, name, iteration, reused, wallMs: end - start, buildInfo: pkg.buildInfo, jobId: signed.manifest.jobId, profileDigest: signed.manifest.profileDigest, artifactsVerified: true, stages };
                results.push(result);
                record('result', result);
                fs.writeFileSync(path.join(root, phase + '-summary.json'), JSON.stringify(results, null, 2));
                try {
                    const status = await fetch(settings.gatewayUrl + '/api/v1/build/jobs/' + signed.manifest.jobId).then(r => r.json());
                    fs.writeFileSync(path.join(root, `${phase}-${name}-${iteration}-status.json`), JSON.stringify(status, null, 2));
                }
                catch (error) {
                    record('status-error', error.message);
                }
                await main.screenshot({ path: path.join(root, `${phase}-${name}-${iteration}.png`) });
            }
        }
        catch (error) {
            process.exitCode = 1;
            record('failure', { message: error.message, stack: error.stack });
            results.push({ phase, name, error: error.message });
            fs.writeFileSync(path.join(root, phase + '-summary.json'), JSON.stringify(results, null, 2));
        }
        finally {
            await launch.close();
            record('closed', name);
        }
    }
})().catch(error => { record('fatal', error.stack); process.exitCode = 1; });
