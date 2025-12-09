import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Pipe({
  name: 'addNewLine',
  standalone: true
})
export class AddNewLinePipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) { }

  transform(value: Uint8Array | string): SafeHtml {
    let stringValue: string;
    if (value instanceof Uint8Array) {
      stringValue = new TextDecoder().decode(value);
    } else {
      stringValue = value;
    }

    // 在每个换行符后添加 <br> 标签
    const htmlValue = stringValue.replace(/\n/g, '\n<br>');

    // 使用 DomSanitizer 将结果标记为安全的 HTML
    return this.sanitizer.bypassSecurityTrustHtml(htmlValue);
  }
}