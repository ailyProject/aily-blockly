import type { Page } from 'playwright';
import { sel } from '../utils/selectors';

export interface NewProjectOptions {
  /** 项目名（保证唯一，避免 showIsExist=true 阻塞提交） */
  name: string;
  /**
   * 可选：搜索框关键字（fuzzy 命中 nickname/keywords）。
   * 缺省则不搜索，使用列表里 ngOnInit 默认选中的第一块板。
   */
  boardKeyword?: string;
  /** 可选：精确匹配 data-board-id（即 npm 包名） */
  boardId?: string;
}

/**
 * 新建项目向导（两步流程）：
 *  step 0: [搜索 →] 选板卡 → "使用此板卡"
 *  step 1: 填名称 → 创建（默认保存路径已自动生成，无需手选目录）
 *
 * 关键：boardList 通过 configService 异步加载（首次启动需读取本地缓存
 *       或拉远程），必须先等候选 DOM 就绪再操作。
 */
export class ProjectNewPage {
  constructor(public readonly page: Page) {}

  async create(opts: NewProjectOptions): Promise<void> {
    // ---- step 0: 选板卡 ----
    // 等 board list 渲染（无论网络快慢，都给一段时间）
    await this.page
      .locator(sel.newProjectBoardOptionAny)
      .first()
      .waitFor({ timeout: 60_000 });

    if (opts.boardKeyword) {
      const searchInput = this.page.locator(sel.newProjectBoardInput);
      await searchInput.fill(opts.boardKeyword);
      // search() 内部 debounceTime(200ms)
      await this.page.waitForTimeout(400);
    }

    // 选板卡：优先精确 data-board-id，其次首张候选
    let boardLoc = opts.boardId
      ? this.page.locator(sel.newProjectBoardOption(opts.boardId))
      : null;

    if (!boardLoc || (await boardLoc.count()) === 0) {
      boardLoc = this.page.locator(sel.newProjectBoardOptionAny);
    }
    const cnt = await boardLoc.count();
    if (cnt === 0) {
      throw new Error(
        `[ProjectNewPage] 没有匹配的板卡候选（keyword="${opts.boardKeyword ?? ''}", id="${opts.boardId ?? ''}"）`
      );
    }
    await boardLoc.first().click();

    // ngOnInit 也会自动 selectBoard(boardList[0])，所以"使用此板卡"按钮立刻可见。
    const useThis = this.page.locator(sel.newProjectUseThis);
    await useThis.waitFor({ timeout: 15_000 });
    await useThis.click();

    // ---- step 1: 名称/路径/创建 ----
    const nameInput = this.page.locator(sel.newProjectName);
    await nameInput.waitFor({ timeout: 15_000 });
    // 清空再写入（默认会有 project_N 自动名）
    await nameInput.fill('');
    await nameInput.fill(opts.name);

    // 默认保存路径已是 ~/Documents/aily-project/，不点 selectFolder 避免触发 dialog
    const submit = this.page.locator(sel.newProjectSubmit);
    await submit.waitFor({ timeout: 10_000 });

    // 等到按钮可点（disabled 取决于 showIsExist / showIsPathPassed）
    await this.page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector) as HTMLButtonElement | null;
        return !!el && !el.disabled;
      },
      sel.newProjectSubmit,
      { timeout: 10_000 }
    );
    await submit.click();

    // 等待项目创建完成 → 主窗口收到 open-project IPC → 跳转到 /main/blockly-editor。
    // 首次创建会触发 npm install boardPackage，可能耗时较长。
    await this.page.waitForURL(/\/main\/(blockly-editor|code-editor)/, {
      timeout: 300_000,
    });
  }
}
