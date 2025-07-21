import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FancyAnsi } from 'fancy-ansi';

@Pipe({
  name: 'ansi',
  standalone: true
})
export class AnsiPipe implements PipeTransform {
  private fancyAnsi = new FancyAnsi();

  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string | null | undefined): SafeHtml {
    if (!value) {
      return '';
    }
    
    // 先使用 FancyAnsi 转换 ANSI 代码
    let htmlString = this.fancyAnsi.toHtml(value);
    // 确保换行符被正确转换为 HTML 的 <br> 标签
    htmlString = htmlString.replace(/\n/g, '<br>');
    
    return this.sanitizer.bypassSecurityTrustHtml(htmlString);
  }
}