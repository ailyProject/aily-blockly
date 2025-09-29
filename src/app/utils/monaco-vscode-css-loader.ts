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
      'vscode/css/base/browser/ui/actionbar/actionbar.css',
      'vscode/css/base/browser/ui/aria/aria.css',
      'vscode/css/base/browser/ui/button/button.css',
      'vscode/css/base/browser/ui/codicons/codicon/codicon-modifiers.css',
      'vscode/css/base/browser/ui/codicons/codicon/codicon.css',
      'vscode/css/base/browser/ui/contextview/contextview.css',
      'vscode/css/base/browser/ui/countBadge/countBadge.css',
      'vscode/css/base/browser/ui/dnd/dnd.css',
      'vscode/css/base/browser/ui/dropdown/dropdown.css',
      'vscode/css/base/browser/ui/findinput/findInput.css',
      'vscode/css/base/browser/ui/hover/hoverWidget.css',
      'vscode/css/base/browser/ui/iconLabel/iconlabel.css',
      'vscode/css/base/browser/ui/inputbox/inputBox.css',
      'vscode/css/base/browser/ui/keybindingLabel/keybindingLabel.css',
      'vscode/css/base/browser/ui/list/list.css',
      'vscode/css/base/browser/ui/mouseCursor/mouseCursor.css',
      'vscode/css/base/browser/ui/progressbar/progressbar.css',
      'vscode/css/base/browser/ui/sash/sash.css',
      'vscode/css/base/browser/ui/scrollbar/media/scrollbars.css',
      'vscode/css/base/browser/ui/selectBox/selectBox.css',
      'vscode/css/base/browser/ui/selectBox/selectBoxCustom.css',
      'vscode/css/base/browser/ui/severityIcon/media/severityIcon.css',
      'vscode/css/base/browser/ui/splitview/splitview.css',
      'vscode/css/base/browser/ui/table/table.css',
      'vscode/css/base/browser/ui/toggle/toggle.css',
      'vscode/css/base/browser/ui/toolbar/toolbar.css',
      'vscode/css/base/browser/ui/tree/media/tree.css',
      'vscode/css/editor/browser/controller/editContext/native/nativeEditContext.css',
      'vscode/css/editor/browser/controller/editContext/textArea/textAreaEditContext.css',
      'vscode/css/editor/browser/gpu/css/media/decorationCssRuleExtractor.css',
      'vscode/css/editor/browser/services/hoverService/hover.css',
      'vscode/css/editor/browser/viewParts/blockDecorations/blockDecorations.css',
      'vscode/css/editor/browser/viewParts/currentLineHighlight/currentLineHighlight.css',
      'vscode/css/editor/browser/viewParts/decorations/decorations.css',
      'vscode/css/editor/browser/viewParts/glyphMargin/glyphMargin.css',
      'vscode/css/editor/browser/viewParts/gpuMark/gpuMark.css',
      'vscode/css/editor/browser/viewParts/indentGuides/indentGuides.css',
      'vscode/css/editor/browser/viewParts/lineNumbers/lineNumbers.css',
      'vscode/css/editor/browser/viewParts/linesDecorations/linesDecorations.css',
      'vscode/css/editor/browser/viewParts/margin/margin.css',
      'vscode/css/editor/browser/viewParts/marginDecorations/marginDecorations.css',
      'vscode/css/editor/browser/viewParts/minimap/minimap.css',
      'vscode/css/editor/browser/viewParts/overlayWidgets/overlayWidgets.css',
      'vscode/css/editor/browser/viewParts/rulers/rulers.css',
      'vscode/css/editor/browser/viewParts/scrollDecoration/scrollDecoration.css',
      'vscode/css/editor/browser/viewParts/selections/selections.css',
      'vscode/css/editor/browser/viewParts/viewCursors/viewCursors.css',
      'vscode/css/editor/browser/viewParts/viewLines/viewLines.css',
      'vscode/css/editor/browser/viewParts/whitespace/whitespace.css',
      'vscode/css/editor/browser/widget/codeEditor/editor.css',
      'vscode/css/editor/browser/widget/diffEditor/components/accessibleDiffViewer.css',
      'vscode/css/editor/browser/widget/diffEditor/style.css',
      'vscode/css/editor/browser/widget/markdownRenderer/browser/renderedMarkdown.css',
      'vscode/css/editor/contrib/anchorSelect/browser/anchorSelect.css',
      'vscode/css/editor/contrib/bracketMatching/browser/bracketMatching.css',
      'vscode/css/editor/contrib/codeAction/browser/lightBulbWidget.css',
      'vscode/css/editor/contrib/codelens/browser/codelensWidget.css',
      'vscode/css/editor/contrib/colorPicker/browser/colorPicker.css',
      'vscode/css/editor/contrib/dnd/browser/dnd.css',
      'vscode/css/editor/contrib/dropOrPasteInto/browser/postEditWidget.css',
      'vscode/css/editor/contrib/find/browser/findOptionsWidget.css',
      'vscode/css/editor/contrib/find/browser/findWidget.css',
      'vscode/css/editor/contrib/folding/browser/folding.css',
      'vscode/css/editor/contrib/gotoError/browser/media/gotoErrorWidget.css',
      'vscode/css/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.css',
      'vscode/css/editor/contrib/gotoSymbol/browser/peek/referencesWidget.css',
      'vscode/css/editor/contrib/hover/browser/hover.css',
      'vscode/css/editor/contrib/inPlaceReplace/browser/inPlaceReplace.css',
      'vscode/css/editor/contrib/inlineCompletions/browser/hintsWidget/inlineCompletionsHintsWidget.css',
      'vscode/css/editor/contrib/inlineCompletions/browser/view/ghostText/ghostTextView.css',
      'vscode/css/editor/contrib/inlineCompletions/browser/view/inlineEdits/view.css',
      'vscode/css/editor/contrib/inlineProgress/browser/inlineProgressWidget.css',
      'vscode/css/editor/contrib/linkedEditing/browser/linkedEditing.css',
      'vscode/css/editor/contrib/links/browser/links.css',
      'vscode/css/editor/contrib/message/browser/messageController.css',
      'vscode/css/editor/contrib/middleScroll/browser/middleScroll.css',
      'vscode/css/editor/contrib/parameterHints/browser/parameterHints.css',
      'vscode/css/editor/contrib/peekView/browser/media/peekViewWidget.css',
      'vscode/css/editor/contrib/placeholderText/browser/placeholderText.css',
      'vscode/css/editor/contrib/rename/browser/renameWidget.css',
      'vscode/css/editor/contrib/snippet/browser/snippetSession.css',
      'vscode/css/editor/contrib/stickyScroll/browser/stickyScroll.css',
      'vscode/css/editor/contrib/suggest/browser/media/suggest.css',
      'vscode/css/editor/contrib/symbolIcons/browser/symbolIcons.css',
      'vscode/css/editor/contrib/unicodeHighlighter/browser/bannerController.css',
      'vscode/css/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.css',
      'vscode/css/editor/contrib/wordHighlighter/browser/highlightDecorations.css',
      'vscode/css/editor/contrib/zoneWidget/browser/zoneWidget.css',
      'vscode/css/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.css',
      'vscode/css/editor/standalone/browser/quickInput/standaloneQuickInput.css',
      'vscode/css/platform/actionWidget/browser/actionWidget.css',
      'vscode/css/platform/actions/browser/menuEntryActionViewItem.css',
      'vscode/css/platform/opener/browser/link.css',
      'vscode/css/platform/quickinput/browser/media/quickInput.css',
      'vscode/css/workbench/browser/actions/media/actions.css',
      'vscode/css/workbench/contrib/codeEditor/browser/dictation/editorDictation.css'
    ];

    console.log('Loading Monaco VSCode CSS files...');

    const loadPromises = cssFiles.map(cssFile => this.loadCSS(cssFile));
    await Promise.allSettled(loadPromises);

    console.log(`Monaco VSCode CSS loading completed. Loaded ${this.loadedCSSFiles.size} files.`);
  }
}