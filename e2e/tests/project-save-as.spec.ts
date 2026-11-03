import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { SaveAsApp, until } from '../fixtures/project-save-as';

for (const mode of ['blockly', 'coder'] as const) {
  test.describe(`${mode} 另存为`, () => {
    test('干净副本、未保存内容、中文资源、连续另存为及重开', async ({}, info) => {
      const app = new SaveAsApp(mode, info);
      try {
        await app.start();
        const original = app.snapshot(), clean = info.outputPath('workspace', '干净副本 B');
        await test.step('未修改项目另存为，新身份并保留资源', async () => {
          await app.choose(clean); await app.copied(clean); app.assertSnapshot(original);
          expect(JSON.parse(fs.readFileSync(path.join(app.source, 'package.json'), 'utf8')).cloudId).toBe('source-cloud-identity');
        });
        const cleanBaseline = app.snapshot(clean), dirty = info.outputPath('workspace', '中文 副本 C');
        await test.step('未保存编辑进入副本，A 和 B 磁盘逐字不变', async () => {
          await app.edit(757123);
          if (mode === 'coder') await app.edit(757126, '中文.h');
          await app.choose(dirty); await app.copied(dirty);
          app.assertMarker(dirty, 757123);
          if (mode === 'coder') {
            const encoded = fs.readFileSync(path.join(dirty, 'sketch/src/中文.h'));
            expect([...encoded.subarray(0, 2)]).toEqual([0xff, 0xfe]);
            expect(encoded.subarray(2).toString('utf16le')).toContain('757126');
            expect(encoded.subarray(2).toString('utf16le')).toContain('\r\n');
          }
          app.assertSnapshot(original); app.assertSnapshot(cleanBaseline, clean);
        });
        await test.step('副本继续编辑并保存，只更新当前副本', async () => {
          await app.edit(757124); await app.save(); app.assertMarker(dirty, 757124);
          app.assertSnapshot(original); app.assertSnapshot(cleanBaseline, clean);
        });
        const dirtyBaseline = app.snapshot(dirty), next = info.outputPath('workspace', '连续副本 D');
        await test.step('连续另存为保留每一代磁盘内容', async () => {
          await app.edit(757125); await app.choose(next); await app.copied(next); app.assertMarker(next, 757125);
          app.assertSnapshot(dirtyBaseline, dirty); app.assertSnapshot(cleanBaseline, clean); app.assertSnapshot(original);
        });
        await test.step('重开副本仍有未保存时的内容', async () => {
          await app.open(app.source); await app.open(next); app.assertMarker(next, 757125);
          if (mode === 'coder') {
            const frame = await app.coder(); await frame.getByText('main.cpp', { exact: true }).first().dblclick();
            await expect(frame.locator('.monaco-editor .view-lines').first()).toContainText('757125');
          } else {
            expect(await app.page.evaluate(() => JSON.stringify((globalThis as any).blocklyWorkspace.getAllBlocks(false).flatMap((block: any) => block.inputList.flatMap((input: any) => input.fieldRow.map((field: any) => field.getValue())))))).toContain('757125');
          }
          app.assertSnapshot(original);
        });
      } finally { await app.close(); }
    });

    test('取消、路径冲突、嵌套与文件系统失败后重试', async ({}, info) => {
      const app = new SaveAsApp(mode, info);
      try {
        await app.start(); const baseline = app.snapshot(); await app.edit(757201);
        const unchanged = async () => { expect(app.active()).toBe(app.source); app.assertSnapshot(baseline); await expect(app.page.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'true'); };
        await test.step('取消目录选择保留未保存状态', async () => {
          const count = await app.dialogCount(); await app.choose(); await expect.poll(() => app.dialogCount()).toBe(count + 1);
          await app.page.locator('app-header app-menu:not(.ports)').waitFor({ state: 'hidden' });
          await expect(app.page.locator('.ant-message-error')).toHaveCount(0); await unchanged();
        });
        const existing = info.outputPath('workspace', '已存在目录'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'sentinel.txt'), '不可覆盖');
        const file = info.outputPath('workspace', '已存在文件'); fs.writeFileSync(file, '不可覆盖文件');
        for (const [name, target] of [['已有目录', existing], ['已有文件', file], ['当前项目路径', app.source], ['项目子目录', path.join(app.source, 'nested-copy')]] as const) {
          await test.step(`${name}拒绝且原项目和目标不变`, async () => {
            await app.choose(target); await app.warning(/已存在|不能|无法|失败|existing|cannot|failed/i); await unchanged();
            expect(fs.readFileSync(path.join(existing, 'sentinel.txt'), 'utf8')).toBe('不可覆盖'); expect(fs.readFileSync(file, 'utf8')).toBe('不可覆盖文件');
            if (target.endsWith('nested-copy')) expect(fs.existsSync(target)).toBe(false);
          });
        }
        await test.step('经符号链接进入原项目的目标也拒绝', async () => {
          const alias = info.outputPath('workspace', 'source-alias'); fs.symlinkSync(app.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
          await app.choose(path.join(alias, 'linked-copy')); await app.warning(/不能|无法|失败|cannot|failed/i); await unchanged();
          expect(fs.existsSync(path.join(app.source, 'linked-copy'))).toBe(false);
        });
        await test.step('父路径为文件的真实文件系统错误不损坏源项目', async () => {
          await app.choose(path.join(file, 'copy')); await app.warning(/不能|无法|失败|ENOTDIR|cannot|failed/i); await unchanged(); expect(fs.readFileSync(file, 'utf8')).toBe('不可覆盖文件');
        });
        if (mode === 'coder') await test.step('无效的未保存清单导致副本回滚，修正后可重试', async () => {
          await app.edit(757299, 'package.json');
          const target = info.outputPath('workspace', '无效清单副本');
          await app.choose(target); await app.warning(/失败|JSON|failed/i);
          expect(fs.existsSync(target)).toBe(false); await unchanged();
          const frame = await app.coder(); await frame.locator('.monaco-editor .view-lines').first().click();
          await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
          const saved = fs.readFileSync(path.join(app.source, 'package.json'), 'utf8');
          await app.page.keyboard.insertText(saved);
          const readEditor = async () => (await frame.locator('.monaco-editor .view-lines .view-line').allTextContents()).join('\n').replace(/\u00a0/g, ' ').trimEnd();
          const entered = await readEditor();
          // Native EditContext can leave the automatically inserted closing brace after bulk input.
          // Correct that visible extra character with normal editor keys, then verify the entire JSON.
          try { JSON.parse(entered); }
          catch {
            expect(JSON.parse(entered.slice(0, -1))).toEqual(JSON.parse(saved));
            await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
            await app.page.keyboard.press('Backspace');
          }
          await expect.poll(async () => JSON.parse(await readEditor())).toEqual(JSON.parse(saved));
        });
        await test.step('错误后重试可正常另存为', async () => {
          const target = info.outputPath('workspace', '重试副本'); await app.choose(target); await app.copied(target); app.assertMarker(target, 757201); app.assertSnapshot(baseline);
        });
      } finally { await app.close(); }
    });

    test('真实 Chat 生成中、工具运行中、停止及目录选择竞态', async ({}, info) => {
      const app = new SaveAsApp(mode, info);
      try {
        await app.start(true); const baseline = app.snapshot(); const chat = await app.chat();
        const busy = async () => {
          const calls = await app.dialogCount(); await app.menu('fa-copy'); await app.warning(/AI 任务正在运行/);
          expect(await app.dialogCount()).toBe(calls); expect(app.active()).toBe(app.source); app.assertSnapshot(baseline);
        };
        await test.step('模型实际流式生成时立即提示，原生目录框未打开', async () => {
          await chat.send('HOLD_GENERATION_1 请保持此轮生成以验证另存为保护');
          await until(() => Boolean(app.model.held), '本地模型流开始');
          await expect.poll(async () => (await chat.snapshot()).isStreaming).toBe(true);
          await busy(); await busy();
          await app.page.screenshot({ path: info.outputPath('ai-generating.png') });
        });
        await test.step('点击真实停止按钮后恢复另存为入口', async () => {
          await chat.stop(); app.model.release();
          await until(async () => { const state = await chat.snapshot(); return state.isIdle && !state.isStreaming; }, '真实 AI 停止');
          const count = await app.dialogCount(); await app.choose(); await expect.poll(() => app.dialogCount()).toBe(count + 1);
        });
        await test.step('真实 bash 工具执行期间拦截，工具完成后恢复', async () => {
          fs.rmSync(app.model.releaseFile, { force: true }); await chat.send('HOLD_TOOL 请执行受控等待工具以验证另存为保护');
          await until(async () => (await chat.snapshot()).toolExecutions.some((tool: any) => tool.toolName === 'bash' && tool.status === 'pending'), '真实 bash 工具运行', 90_000);
          await busy(); await app.page.screenshot({ path: info.outputPath('ai-tool-running.png') }); app.model.release();
          const snapshot = await until(async () => { const state = await chat.snapshot(); return state.isIdle && !state.isStreaming && state; }, '工具完成');
          expect(snapshot.toolExecutions.some((tool: any) => tool.toolName === 'bash' && tool.status === 'success')).toBe(true);
          app.evidence['toolExecutions'] = snapshot.toolExecutions;
        });
        await test.step('选目录期间 AI 启动，返回目录后仍会阻止复制', async () => {
          const target = info.outputPath('workspace', '竞态副本'); await app.choose(undefined, true);
          await until(() => app.app.evaluate(() => Boolean((globalThis as any).__saveAsDialog.pending)), '原生目录框等待');
          const count = await app.dialogCount(); await app.menu('fa-copy'); expect(await app.dialogCount()).toBe(count);
          await chat.send('HOLD_GENERATION_2 请保持生成以验证选择目录期间启动 AI'); await until(() => Boolean(app.model.held), '第二轮流开始');
          await expect.poll(async () => (await chat.snapshot()).isStreaming).toBe(true);
          await app.resolveDialog(target); await app.warning(/AI 任务正在运行/); expect(fs.existsSync(target)).toBe(false); app.assertSnapshot(baseline);
          app.model.release(); await until(async () => { const state = await chat.snapshot(); return state.isIdle && !state.isStreaming; }, '模型自然完成');
        });
        await test.step('AI 自然完成后另存为成功', async () => {
          const target = info.outputPath('workspace', 'AI 完成后副本'); await app.choose(target); await app.copied(target); app.assertSnapshot(baseline);
        });
      } finally { await app.close(); }
    });
  });
}
