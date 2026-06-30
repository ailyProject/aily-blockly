import { Directive, HostListener } from '@angular/core';
import { ElectronService } from '../../../services/electron.service';

/**
 * 拦截 ngx-x-markdown 渲染出的 &lt;a href="http(s):..."&gt;，默认用系统浏览器打开（Electron：openByBrowser）。
 */
@Directive({
  selector: '[ailyMarkdownExternalLinks]',
  standalone: true,
})
export class AilyMarkdownExternalLinksDirective {
  constructor(private electron: ElectronService) {}

  @HostListener('click', ['$event'])
  onClick(ev: MouseEvent): void {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const a = t.closest('a[href]') as HTMLAnchorElement | null;
    if (!a?.getAttribute('href')) return;
    const href = (a.getAttribute('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (this.electron.isElectron) {
      this.electron.openUrl(href);
    } else {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  }
}
