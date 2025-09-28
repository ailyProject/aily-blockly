/**
 * Monaco VSCode CSS加载器
 * 在生产模式下手动加载Monaco VSCode API所需的CSS文件
 */
export class MonacoVSCodeCSSLoader {
  private static loadedCSSFiles = new Set<string>();

  /**
   * 加载指定的CSS文件
   * @param cssPath CSS文件路径
   */
  public static async loadCSS(cssPath: string): Promise<void> {
    if (this.loadedCSSFiles.has(cssPath)) {
      return; // 已加载，避免重复加载
    }

    try {
      const response = await fetch(cssPath);
      if (!response.ok) {
        console.warn(`Failed to load CSS: ${cssPath}, status: ${response.status}`);
        return;
      }

      const cssContent = await response.text();
      const style = document.createElement('style');
      style.textContent = cssContent;
      style.setAttribute('data-source', cssPath);
      document.head.appendChild(style);
      
      this.loadedCSSFiles.add(cssPath);
      console.log(`Successfully loaded CSS: ${cssPath}`);
    } catch (error) {
      console.warn(`Error loading CSS: ${cssPath}`, error);
    }
  }

  /**
   * 批量加载所有Monaco VSCode相关的CSS文件
   */
  public static async loadAllMonacoCSS(): Promise<void> {
    // Monaco VSCode API基础UI CSS文件列表
    const cssFiles = [
      // 基础UI组件
      'monaco-vscode/css/base/browser/ui/actionbar/actionbar.css',
      'monaco-vscode/css/base/browser/ui/aria/aria.css',
      'monaco-vscode/css/base/browser/ui/button/button.css',
      'monaco-vscode/css/base/browser/ui/codicons/codicon/codicon.css',
      'monaco-vscode/css/base/browser/ui/codicons/codicon/codicon-modifiers.css',
      'monaco-vscode/css/base/browser/ui/contextview/contextview.css',
      'monaco-vscode/css/base/browser/ui/countBadge/countBadge.css',
      'monaco-vscode/css/base/browser/ui/dnd/dnd.css',
      'monaco-vscode/css/base/browser/ui/dropdown/dropdown.css',
      'monaco-vscode/css/base/browser/ui/findinput/findInput.css',
      'monaco-vscode/css/base/browser/ui/hover/hoverWidget.css',
      'monaco-vscode/css/base/browser/ui/iconLabel/iconlabel.css',
      'monaco-vscode/css/base/browser/ui/inputbox/inputBox.css',
      'monaco-vscode/css/base/browser/ui/keybindingLabel/keybindingLabel.css',
      'monaco-vscode/css/base/browser/ui/list/list.css',
      'monaco-vscode/css/base/browser/ui/mouseCursor/mouseCursor.css',
      'monaco-vscode/css/base/browser/ui/progressbar/progressbar.css',
      'monaco-vscode/css/base/browser/ui/sash/sash.css',
      'monaco-vscode/css/base/browser/ui/scrollbar/media/scrollbars.css',
      'monaco-vscode/css/base/browser/ui/selectBox/selectBox.css',
      'monaco-vscode/css/base/browser/ui/splitview/splitview.css',
      'monaco-vscode/css/base/browser/ui/table/table.css',
      'monaco-vscode/css/base/browser/ui/toggle/toggle.css',
      'monaco-vscode/css/base/browser/ui/tree/media/tree.css',
      'monaco-vscode/css/base/browser/ui/widget/widget.css',
      
      // Editor相关CSS
      'monaco-vscode/css/editor/browser/widget/codeEditorWidget.css',
      'monaco-vscode/css/editor/browser/widget/diffEditorWidget.css',
      'monaco-vscode/css/editor/browser/widget/diffReview.css',
      'monaco-vscode/css/editor/browser/widget/media/editor.css',
      'monaco-vscode/css/editor/browser/widget/media/diffEditor.css',
      'monaco-vscode/css/editor/contrib/anchorSelect/anchorSelect.css',
      'monaco-vscode/css/editor/contrib/bracketMatching/bracketMatching.css',
      'monaco-vscode/css/editor/contrib/caretOperations/caretOperations.css',
      'monaco-vscode/css/editor/contrib/clipboard/clipboard.css',
      'monaco-vscode/css/editor/contrib/codeAction/media/lightbulb.css',
      'monaco-vscode/css/editor/contrib/codelens/codelens.css',
      'monaco-vscode/css/editor/contrib/colorPicker/colorPicker.css',
      'monaco-vscode/css/editor/contrib/comment/comment.css',
      'monaco-vscode/css/editor/contrib/contextmenu/contextmenu.css',
      'monaco-vscode/css/editor/contrib/cursorUndo/cursorUndo.css',
      'monaco-vscode/css/editor/contrib/dnd/dnd.css',
      'monaco-vscode/css/editor/contrib/find/findWidget.css',
      'monaco-vscode/css/editor/contrib/folding/folding.css',
      'monaco-vscode/css/editor/contrib/fontZoom/fontZoom.css',
      'monaco-vscode/css/editor/contrib/format/format.css',
      'monaco-vscode/css/editor/contrib/gotoError/media/gotoErrorWidget.css',
      'monaco-vscode/css/editor/contrib/gotoSymbol/goToCommands.css',
      'monaco-vscode/css/editor/contrib/gotoSymbol/link/goToDefinitionAtPosition.css',
      'monaco-vscode/css/editor/contrib/hover/hover.css',
      'monaco-vscode/css/editor/contrib/inPlaceReplace/inPlaceReplace.css',
      'monaco-vscode/css/editor/contrib/linesOperations/linesOperations.css',
      'monaco-vscode/css/editor/contrib/links/links.css',
      'monaco-vscode/css/editor/contrib/multicursor/multicursor.css',
      'monaco-vscode/css/editor/contrib/parameterHints/parameterHints.css',
      'monaco-vscode/css/editor/contrib/peekView/media/peekViewWidget.css',
      'monaco-vscode/css/editor/contrib/rename/rename.css',
      'monaco-vscode/css/editor/contrib/snippet/snippetSession.css',
      'monaco-vscode/css/editor/contrib/suggest/media/suggest.css',
      'monaco-vscode/css/editor/contrib/toggleTabFocusMode/toggleTabFocusMode.css',
      'monaco-vscode/css/editor/contrib/wordHighlighter/wordHighlighter.css',
      'monaco-vscode/css/editor/contrib/zoneWidget/zoneWidget.css',
      
      // Platform和其他CSS
      'monaco-vscode/css/platform/theme/browser/iconRegistry.css',
      'monaco-vscode/css/workbench/browser/media/workbench.css'
    ];

    console.log('Loading Monaco VSCode CSS files...');
    
    const loadPromises = cssFiles.map(cssFile => this.loadCSS(cssFile));
    await Promise.allSettled(loadPromises);
    
    console.log(`Monaco VSCode CSS loading completed. Loaded ${this.loadedCSSFiles.size} files.`);
  }
}