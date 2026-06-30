import { Component, ElementRef, ViewChild, effect, inject } from '@angular/core';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { ElectronService } from '../../services/electron.service';
import { UiService } from '../../services/ui.service';
import { ProjectService } from '../../services/project.service';
import { TerminalService } from './terminal.service';
import { ThemeService } from '../../services/theme.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-terminal',
  imports: [CommonModule],
  templateUrl: './terminal.component.html',
  styleUrl: './terminal.component.scss',
})
export class TerminalComponent {
  @ViewChild('terminal') terminalEl: ElementRef;

  terminal: Terminal;
  fitAddon;
  clipboardAddon;

  private readonly themeService = inject(ThemeService);
  private readonly sizeCommandPrefix = 'SIZE>';
  private terminalInputLine = '';
  private sizeCommandBuffer = '';
  private isCapturingSizeCommand = false;

  constructor(
    private electronService: ElectronService,
    private uiService: UiService,
    private projectService: ProjectService,
    private terminalService: TerminalService,
  ) {
    effect(() => {
      this.themeService.theme();
      if (this.terminal) {
        this.terminal.options.theme = this.readTerminalThemeFromCss();
      }
    });
  }

  close() {
    this.uiService.closeTool('terminal');
  }

  clear() {
    this.terminal.write('\x1bc');
    if (this.electronService.isElectron) {
      this.terminalService.send('clear\r');
    }
  }

  async ngAfterViewInit() {
    this.terminal = new Terminal({
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      scrollback: 1000,
      cursorBlink: true,
      convertEol: true,
      theme: this.readTerminalThemeFromCss(),
    });
    this.terminal.open(this.terminalEl.nativeElement);

    if (this.electronService.isElectron) {
      await this.nodePtyInit();
    } else {
      await this.cloudPtyInit();
    }

    this.fitContainer();
    this.listenRightClick();

    this.terminal.onData(input => {
      void this.handleTerminalInput(input);
    });

    window['terminal'].onData((data) => {
      this.terminal.write(data);
    })
  }

  ngOnDestroy(): void {
    this.closeNodePty();
    this.terminalEl.nativeElement.removeEventListener('contextmenu', this.contextMenuListener);
    this.resizeObserver?.disconnect();
    this.terminal.dispose();
  }

  /** 背景 / 文本 + 光标、选区、ANSI 配色变量 */
  private readTerminalThemeFromCss(): ITheme {
    const styles = getComputedStyle(document.documentElement);
    const g = (name: string) => styles.getPropertyValue(name).trim() || undefined;
    return {
      background: g('--aily-editor-bg'),
      foreground: g('--aily-text-primary'),
      cursor: g('--aily-terminal-cursor'),
      cursorAccent: g('--aily-terminal-cursor-accent'),
      selectionBackground: g('--aily-terminal-selection-bg'),
      black: g('--aily-terminal-black'),
      red: g('--aily-terminal-red'),
      green: g('--aily-terminal-green'),
      yellow: g('--aily-terminal-yellow'),
      blue: g('--aily-terminal-blue'),
      magenta: g('--aily-terminal-magenta'),
      cyan: g('--aily-terminal-cyan'),
      white: g('--aily-terminal-white'),
      brightBlack: g('--aily-terminal-bright-black'),
      brightRed: g('--aily-terminal-bright-red'),
      brightGreen: g('--aily-terminal-bright-green'),
      brightYellow: g('--aily-terminal-bright-yellow'),
      brightBlue: g('--aily-terminal-bright-blue'),
      brightMagenta: g('--aily-terminal-bright-magenta'),
      brightCyan: g('--aily-terminal-bright-cyan'),
      brightWhite: g('--aily-terminal-bright-white'),
    };
  }

  // 用于监听容器大小变化，改变terminal大小
  resizeObserver;
  resizeTimeout;
  fitContainer() {
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimeout) {
        clearTimeout(this.resizeTimeout);
      }
      this.resizeTimeout = setTimeout(() => {
        this.fitAddon.fit();
        if (this.electronService.isElectron) {
          const dimensions = this.fitAddon.proposeDimensions();
          if (dimensions && dimensions.cols && dimensions.rows) {
            this.terminalService.resize({ cols: dimensions.cols, rows: dimensions.rows });
          }
        }
      }, 100);
    });
    this.resizeObserver.observe(this.terminalEl.nativeElement);
  }

  // 监听右键点击, 咱贴文本
  contextMenuListener;
  listenRightClick() {
    this.clipboardAddon = new ClipboardAddon();
    this.terminal.loadAddon(this.clipboardAddon);
    this.contextMenuListener = (event) => {
      event.preventDefault();
      this.pasteClipboardToTerminal();
    };
    this.terminalEl.nativeElement.addEventListener('contextmenu', this.contextMenuListener);

    // 添加复制功能
    this.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      // Ctrl+C 用于复制（当有选中文本时）
      if (event.type === 'keydown' && event.ctrlKey && event.key === 'c') {
        if (this.terminal.hasSelection()) {
          this.copyTerminalSelection();
          return false; // 阻止事件继续传播
        }
      }
      // 也可以添加 Ctrl+Shift+V 用于粘贴
      if (event.type === 'keydown' && event.ctrlKey && event.key === 'v') {
        this.pasteClipboardToTerminal();
        return false;
      }
      return true; // 允许其他键盘事件正常处理
    });
  }

  private async pasteClipboardToTerminal() {
    try {
      const text = await this.electronService.clipboardReadText();
      if (text) {
        this.terminalService.send(text);
      }
    } catch (err) {
      console.error('获取剪贴板内容失败:', err);
    }
  }

  private async copyTerminalSelection() {
    try {
      await this.electronService.clipboardWriteText(this.terminal.getSelection());
    } catch (err) {
      console.error('写入剪贴板失败:', err);
    }
  }

  private async handleTerminalInput(input: string): Promise<void> {
    if (!this.electronService.isElectron) {
      this.terminalService.send(input);
      return;
    }

    if (!this.isCapturingSizeCommand && input.startsWith('\x1b')) {
      this.terminalService.send(input);
      return;
    }

    for (const char of input) {
      await this.handleTerminalInputChar(char);
    }
  }

  private async handleTerminalInputChar(char: string): Promise<void> {
    if (this.isCapturingSizeCommand) {
      await this.handleCapturedSizeCommandChar(char);
      return;
    }

    if (this.terminalInputLine.length === 0 && this.isPrintableTerminalChar(char) && char.toUpperCase() === this.sizeCommandPrefix[0]) {
      this.isCapturingSizeCommand = true;
      this.sizeCommandBuffer = char;
      this.terminal.write(char);
      return;
    }

    this.forwardTerminalInput(char);
  }

  private async handleCapturedSizeCommandChar(char: string): Promise<void> {
    if (this.isTerminalEnter(char)) {
      await this.submitSizeCommand();
      return;
    }

    if (char === '\x03') {
      this.resetSizeCommandCapture();
      this.terminalService.send(char);
      this.terminalInputLine = '';
      return;
    }

    if (this.isTerminalBackspace(char)) {
      if (this.sizeCommandBuffer.length > 0) {
        this.sizeCommandBuffer = this.sizeCommandBuffer.slice(0, -1);
        this.terminal.write('\b \b');
      }
      if (this.sizeCommandBuffer.length === 0) {
        this.resetSizeCommandCapture();
      }
      return;
    }

    if (!this.isPrintableTerminalChar(char)) {
      this.flushCapturedSizeCommandToPty(char);
      return;
    }

    this.sizeCommandBuffer += char;
    this.terminal.write(char);

    if (!this.isPotentialSizeCommand(this.sizeCommandBuffer)) {
      this.flushCapturedSizeCommandToPty();
    }
  }

  private async submitSizeCommand(): Promise<void> {
    const command = this.sizeCommandBuffer.trim();
    if (!command.toUpperCase().startsWith(this.sizeCommandPrefix)) {
      this.flushCapturedSizeCommandToPty('\r');
      return;
    }

    this.resetSizeCommandCapture();

    const match = /^SIZE>(\d+)x(\d+)$/i.exec(command);
    if (!match) {
      this.terminal.write('\r\nUsage: SIZE>1200x900\r\n');
      this.terminalService.send('\r');
      this.terminalInputLine = '';
      return;
    }

    const width = Number(match[1]);
    const height = Number(match[2]);
    try {
      const result = await window['iWindow']?.setSize?.({ width, height });
      if (!result?.success) {
        this.terminal.write(`\r\nSIZE failed: ${result?.error || 'unknown error'}\r\n`);
      }
    } catch (error: any) {
      this.terminal.write(`\r\nSIZE failed: ${error?.message || String(error)}\r\n`);
    }

    this.terminalService.send('\r');
    this.terminalInputLine = '';
  }

  private flushCapturedSizeCommandToPty(extraInput = ''): void {
    const input = this.sizeCommandBuffer + extraInput;
    this.eraseLocalTerminalInput(this.sizeCommandBuffer.length);
    this.resetSizeCommandCapture();
    this.terminalService.send(input);
    for (const char of input) {
      this.trackForwardedInput(char);
    }
  }

  private eraseLocalTerminalInput(length: number): void {
    if (length > 0) {
      this.terminal.write('\b \b'.repeat(length));
    }
  }

  private resetSizeCommandCapture(): void {
    this.isCapturingSizeCommand = false;
    this.sizeCommandBuffer = '';
  }

  private forwardTerminalInput(input: string): void {
    this.terminalService.send(input);
    this.trackForwardedInput(input);
  }

  private trackForwardedInput(input: string): void {
    for (const char of input) {
      if (this.isTerminalEnter(char) || char === '\x03' || char === '\x15') {
        this.terminalInputLine = '';
      } else if (this.isTerminalBackspace(char)) {
        this.terminalInputLine = this.terminalInputLine.slice(0, -1);
      } else if (this.isPrintableTerminalChar(char)) {
        this.terminalInputLine += char;
      }
    }
  }

  private isPotentialSizeCommand(command: string): boolean {
    const upper = command.toUpperCase();
    return this.sizeCommandPrefix.startsWith(upper) || upper.startsWith(this.sizeCommandPrefix);
  }

  private isPrintableTerminalChar(char: string): boolean {
    return char >= ' ' && char !== '\x7f';
  }

  private isTerminalEnter(char: string): boolean {
    return char === '\r' || char === '\n';
  }

  private isTerminalBackspace(char: string): boolean {
    return char === '\x7f' || char === '\b';
  }

  async nodePtyInit() {
    await this.terminalService.create({
      cols: 120,
      rows: 200,
      cwd: this.projectService.currentProjectPath
    });
  }

  async cloudPtyInit() {
    // 初始化云端工具
  }

  closeNodePty() {
    this.terminalService.close();
  }
}
