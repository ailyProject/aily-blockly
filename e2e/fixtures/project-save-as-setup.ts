import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import setup from '../global-setup';
export default async function saveAsSetup() {
  const lock = path.resolve(__dirname, '../.artifacts/project-save-as-build.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  try { await mkdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`另存为套件正在构建或运行；请等待结束。异常退出后请确认进程已停止再清理 ${lock}`); throw error; }
  try { await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await setup(); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  return async () => { await rm(lock, { recursive: true, force: true }); };
}
