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
  'lex-root': { type: 'string' }, appdata: { type: 'string' }, output: { type: 'string' },
  'reuse-angular': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('npm --prefix e2e run test:chat-attachments -- --lex-root <Aily Lex 仓库> --appdata <已登录主软件 AppData> [--reuse-angular] [--output <证据目录>]');
  process.exit(0);
}
const lex = values['lex-root'] || process.env.AILY_E2E_LEX_ROOT;
const account = values.appdata || process.env.AILY_E2E_ACCOUNT_APPDATA;
if (!lex || !account) throw new Error('必须提供 --lex-root 和 --appdata；测试会创建私有账号副本，不使用真实用户工程');
const lexRoot = path.resolve(lex);
const directory = path.resolve(values.output || path.join(root, 'e2e/.artifacts/chat-attachments'));
const server = path.join(lexRoot, 'packages/aily-eval/server');
const entry = path.join(server, 'tests/chat-attachments.test.ts');
if (!existsSync(entry)) throw new Error('Lex 仓库缺少 Eval 附件生命周期测试');
await mkdir(path.join(directory, 'eval-state'), { recursive: true });
const require = createRequire(path.join(server, 'package.json'));
const child = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', entry], {
  cwd: server, stdio: 'inherit', env: { ...process.env,
    AILY_EVAL_LIVE_ATTACHMENTS: '1', AILY_EVAL_ATTACHMENTS_SOURCE: root,
    AILY_EVAL_ATTACHMENTS_APPDATA: path.resolve(account), AILY_EVAL_ATTACHMENTS_OUTPUT: directory,
    AILY_EVAL_DATA_DIR: path.join(directory, 'eval-state'), AILY_EVAL_REPO_ROOT: lexRoot,
    ...(values['reuse-angular'] ? { AILY_EVAL_REUSE_ANGULAR_ROOT: root } : {}),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
