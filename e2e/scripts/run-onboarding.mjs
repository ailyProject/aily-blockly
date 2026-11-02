#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { values } = parseArgs({ options: {
  'lex-root': { type: 'string' }, project: { type: 'string' }, 'chat-root': { type: 'string' },
  output: { type: 'string' }, 'reuse-angular': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('npm --prefix e2e run test:onboarding -- --lex-root <Aily Lex 仓库> --project <已安装依赖的 Blockly 项目> [--chat-root <Aily Chat 便携包>] [--reuse-angular] [--output <证据目录>]');
  process.exit(0);
}
const lex = values['lex-root'] || process.env.AILY_E2E_LEX_ROOT;
const project = values.project || process.env.AILY_E2E_PROJECT;
if (!lex || !project) throw new Error('必须提供 --lex-root 和 --project；测试复制项目到私有目录，不使用真实用户配置');
const lexRoot = path.resolve(lex);
const directory = path.resolve(values.output || path.join(root, 'e2e/.artifacts/onboarding'));
const server = path.join(lexRoot, 'packages/aily-eval/server');
const entry = path.join(server, 'tests/onboarding.test.ts');
if (!existsSync(entry)) throw new Error('Lex 仓库缺少 Eval 引导验证');
await mkdir(path.join(directory, 'eval-state'), { recursive: true });
const require = createRequire(path.join(server, 'package.json'));
const child = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', entry], {
  cwd: server, stdio: 'inherit', env: { ...process.env,
    AILY_EVAL_LIVE_ONBOARDING: '1', AILY_EVAL_ONBOARDING_SOURCE: root,
    AILY_EVAL_ONBOARDING_PROJECT: path.resolve(project), AILY_EVAL_ONBOARDING_OUTPUT: directory,
    AILY_EVAL_DATA_DIR: path.join(directory, 'eval-state'), AILY_EVAL_REPO_ROOT: lexRoot,
    ...(values['chat-root'] ? { AILY_EVAL_ONBOARDING_CHAT: path.resolve(values['chat-root']) } : {}),
    ...(values['reuse-angular'] ? { AILY_EVAL_REUSE_ANGULAR_ROOT: root } : {}),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
