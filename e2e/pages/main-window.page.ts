import type { Page } from 'playwright';
import { sel } from '../utils/selectors';

/** 主窗口 / 启动页 Page Object */
export class MainWindowPage {
  constructor(public readonly page: Page) {}

  async waitReady(timeout = 30_000) {
    await this.page.waitForLoadState('domcontentloaded', { timeout });
    // 等到 electronAPI 注入
    await this.page.waitForFunction(
      () => !!(window as any).electronAPI?.ipcRenderer,
      undefined,
      { timeout }
    );
  }

  async getCurrentUrl(): Promise<string> {
    return this.page.url();
  }

  async skipGuideIfPresent() {
    const btn = this.page.locator(sel.guideSkipBtn);
    if (await btn.count()) {
      await btn.first().click();
    }
  }

  async gotoNewProject() {
    // 优先走 guide 菜单（真实用户路径，会触发 router.navigate(['/main/project-new'])）
    const menuBtn = this.page.locator(sel.menuNewProject);
    if (await menuBtn.count()) {
      await menuBtn.first().click();
      // 等 URL 进入 /main/project-new
      await this.page.waitForURL(/\/main\/project-new/, { timeout: 15_000 });
      return;
    }
    // fallback：直接改 URL 走内嵌路由（注意 /project-new 是独立子窗口路由，必须用 /main/project-new）
    const url = new URL(this.page.url());
    url.hash = '#/main/project-new';
    await this.page.goto(url.toString());
  }
}
