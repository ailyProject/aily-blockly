import type { Page } from 'playwright';
import { sel } from '../utils/selectors';

export interface BuildResult {
  success: boolean;
  durationMs: number;
  log: string;
  artifacts?: string[];
}

export class BlocklyEditorPage {
  constructor(public readonly page: Page) {}

  /** 等待 Blockly workspace DOM 就绪 */
  async waitReady(timeout = 30_000) {
    await this.page.waitForSelector(sel.blocklyWorkspace, { timeout });
    // 等待 Blockly 全局对象
    await this.page.waitForFunction(
      () => !!(window as any).Blockly?.getMainWorkspace?.(),
      undefined,
      { timeout }
    );
  }

  /** 通过 Blockly API 直接加载一段 workspace XML */
  async loadWorkspaceXml(xml: string): Promise<void> {
    await this.page.evaluate((xmlText: string) => {
      const Blockly = (window as any).Blockly;
      if (!Blockly) throw new Error('Blockly not loaded');
      const ws = Blockly.getMainWorkspace();
      ws.clear();
      const dom = Blockly.utils.xml.textToDom(xmlText);
      Blockly.Xml.domToWorkspace(dom, ws);
    }, xml);
  }

  /** 读当前生成代码（若渲染端暴露了 code-preview） */
  async getGeneratedCode(): Promise<string> {
    const el = this.page.locator(sel.codePreview);
    if (!(await el.count())) return '';
    return (await el.first().textContent()) || '';
  }

  /**
   * 触发编译并等待完成。
   * 策略：点按钮 → 轮询 build-status data 属性 或 textContent。
   * 约定 data-build-status="idle|running|success|error"
   */
  async build(opts: { timeout?: number } = {}): Promise<BuildResult> {
    const timeout = opts.timeout ?? 180_000;
    const start = Date.now();

    await this.page.locator(sel.btnBuild).first().click();

    const statusLoc = this.page.locator(sel.buildStatus);
    await statusLoc.waitFor({ timeout: 10_000 });

    // 等待到非 idle/running
    const finalStatus = await this.page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const s = el.getAttribute('data-build-status') || '';
        return s === 'success' || s === 'error' || s === 'failed';
      },
      sel.buildStatus,
      { timeout }
    );

    const status = await statusLoc.getAttribute('data-build-status');
    const log = (await statusLoc.textContent()) || '';

    return {
      success: status === 'success',
      durationMs: Date.now() - start,
      log,
    };
  }

  /**
   * 触发上传/烧录，等待 data-upload-status 变为 success/error。
   * 注意：真实硬件烧录会阻塞，建议设置 MOCK_HARDWARE=1。
   */
  async upload(opts: { timeout?: number } = {}): Promise<BuildResult> {
    const timeout = opts.timeout ?? 180_000;
    const start = Date.now();

    const btn = this.page.locator(sel.btnUpload).first();
    await btn.waitFor({ timeout: 15_000 });
    await btn.click();

    await this.page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const s = el.getAttribute('data-upload-status') || '';
        return s === 'success' || s === 'error' || s === 'failed';
      },
      sel.uploadStatus,
      { timeout }
    );

    const status = await this.page.locator(sel.uploadStatus).getAttribute('data-upload-status');
    const log = (await this.page.locator(sel.uploadStatus).textContent()) || '';

    return {
      success: status === 'success',
      durationMs: Date.now() - start,
      log,
    };
  }
}
