import {cp, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {expect, getMainWindow, openBlocklyProject, test} from '../fixtures/electron-app';

const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];

test.describe('Blockly iframe focus boundary', () => {
  test.skip(!PROJECT_PATH, '需设置 AILY_E2E_PROJECT 才能验证 Blockly 工作区焦点。');

  test('hover preserves child iframe focus and keeps ordinary workspace autofocus', async ({electronApp}) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-blockly-focus-'));
    const projectPath = path.join(tempRoot, 'project');
    await cp(PROJECT_PATH!, projectPath, {recursive: true});

    const win = await getMainWindow(electronApp);

    try {
      await openBlocklyProject(win, projectPath);
      await expect(win.locator('app-blockly-editor .blocklyBox')).toBeVisible({timeout: 30_000});
      await expect.poll(() => win.evaluate(() => {
        const workspace = (window as any).blocklyWorkspace;
        return Boolean(
          workspace?.getInjectionDiv?.() &&
          workspace?.svgGroup_?.parentElement,
        );
      }), {timeout: 60_000}).toBe(true);

      await win.evaluate(() => {
        const workspace = (window as any).blocklyWorkspace;
        const injectionDiv = workspace?.getInjectionDiv?.() as HTMLElement | undefined;
        const focusTarget = workspace?.svgGroup_?.parentElement as HTMLElement | undefined;
        if (!injectionDiv || !focusTarget) {
          throw new Error('Blockly focus elements are unavailable');
        }
        injectionDiv.dataset['e2eWorkspaceInjection'] = 'true';
        focusTarget.dataset['e2eWorkspaceFocusTarget'] = 'true';

        const iframe = document.createElement('iframe');
        iframe.id = 'e2e-child-focus-probe';
        iframe.srcdoc = '<input aria-label="child focus probe">';
        iframe.style.position = 'fixed';
        iframe.style.left = '8px';
        iframe.style.bottom = '8px';
        iframe.style.width = '48px';
        iframe.style.height = '48px';
        iframe.style.zIndex = '2147483647';
        document.body.appendChild(iframe);

        const button = document.createElement('button');
        button.id = 'e2e-host-focus-probe';
        button.textContent = 'host focus probe';
        button.style.position = 'fixed';
        button.style.left = '64px';
        button.style.bottom = '8px';
        button.style.zIndex = '2147483647';
        document.body.appendChild(button);
      });

      const iframe = win.locator('#e2e-child-focus-probe');
      const childInput = win.frameLocator('#e2e-child-focus-probe').locator('input');
      const hostButton = win.locator('#e2e-host-focus-probe');
      const workspaceInjection = win.locator('[data-e2e-workspace-injection="true"]');

      await expect(childInput).toBeVisible();
      await iframe.hover();
      await childInput.focus();
      await expect.poll(() => win.evaluate(() => document.activeElement?.id))
        .toBe('e2e-child-focus-probe');

      await workspaceInjection.hover();
      await expect.poll(() => win.evaluate(() => document.activeElement?.id))
        .toBe('e2e-child-focus-probe');
      await expect.poll(() => childInput.evaluate((input) => input === input.ownerDocument.activeElement))
        .toBe(true);

      await iframe.hover();
      await hostButton.focus();
      await workspaceInjection.hover();
      await expect.poll(() => win.evaluate(() =>
        document.activeElement?.getAttribute('data-e2e-workspace-focus-target')))
        .toBe('true');
    } finally {
      await win.evaluate(() => {
        document.querySelector('#e2e-child-focus-probe')?.remove();
        document.querySelector('#e2e-host-focus-probe')?.remove();
        document.querySelector('[data-e2e-workspace-injection="true"]')
          ?.removeAttribute('data-e2e-workspace-injection');
        document.querySelector('[data-e2e-workspace-focus-target="true"]')
          ?.removeAttribute('data-e2e-workspace-focus-target');
      }).catch(() => {});
      await rm(tempRoot, {recursive: true, force: true});
    }
  });
});
