import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnInit,
  SecurityContext,
  ViewChild,
} from '@angular/core';
import { ChatService } from '../../services/chat.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { SpeechService } from '../../services/speech.service';
import { CommonModule } from '@angular/common';
import { NzAvatarModule } from 'ng-zorro-antd/avatar';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { DomSanitizer } from '@angular/platform-browser';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzImageModule } from 'ng-zorro-antd/image';
import { FormsModule } from '@angular/forms';
import { MarkdownPipe } from '../../../../pipes/markdown.pipe';
import { AilyCodingComponent } from '../../../../components/aily-coding/aily-coding.component';

@Component({
  selector: 'aily-dialog',
  templateUrl: './dialog.component.html',
  styleUrls: ['./dialog.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzAvatarModule,
    NzButtonModule,
    MarkdownPipe,
    NzImageModule,
    AilyCodingComponent,
  ],
})
export class DialogComponent implements OnInit {
  @Input()
  data: any;

  get isDone() {
    if (typeof this.data.isDone == 'boolean') return this.data.isDone;
    return true;
  }

  set isDone(val) {
    this.data.isDone = val;
  }

  get mine() {
    return this.data.role == 'user';
  }

  get system() {
    return this.data.system;
  }

  // get continuous() {
  //   return this.speechService.continuous;
  // }

  get user() {
    return '';
  }

  // get chatList(): any {
  //   return this.chatService.chatList;
  // }

  // get version() {
  //   return this.chatService.version;
  // }

  // get promptPrefix() {
  //   return this.chatService.promptPrefix;
  // }

  // set promptPrefix(val) {
  //   this.chatService.promptPrefix = val;
  // }

  loaded = false;

  constructor(
    private message: NzMessageService,
    private speechService: SpeechService,
    private sanitizer: DomSanitizer,
    private chatService: ChatService,
  ) {}

  ngOnInit(): void {}

  getSafeHTML(html: string) {
    return this.sanitizer.sanitize(SecurityContext.HTML, html);
  }

  // 正则表达式，包含中文句号和逗号
  // reg = /[。|，]/g;
  reg = /[。|；|?|!|.]/g;

  ngAfterViewInit(): void {
    // console.log(this.data.contentList);
    if (this.data.subject) {
      this.data.subject.subscribe(
        (res: any) => {
          // if (
          //   this.reg.test(res) && !this.isPlaying &&
          //   this.speechService.autoPlay && !this.data.isFirst && !this.mine
          // ) {
          //   this.playIndex = 0;
          //   this.playOneByOne();
          // }
        },
        (err) => {},
        () => {
          this.showCopyBtn();
          this.showExportBtn();
          this.loaded = true;
        },
      );
    }

    setTimeout(async () => {
      this.showCopyBtn();
      this.showExportBtn();
    }, 500);
  }

  // 在pre标签的右上角显示复制按钮
  @ViewChild('mdContent')
  mdContent: ElementRef;
  showCopyBtn() {
    const pres = this.mdContent.nativeElement.querySelectorAll('pre');
    for (let index = 0; index < pres.length; index++) {
      const pre = pres[index];
      if (pre) {
        const copyBtn = document.createElement('button');
        copyBtn.innerText = '复制';
        copyBtn.className = 'copy-btn';
        copyBtn.onclick = () => this.copyCode(pre);
        pre.appendChild(copyBtn);
      }
    }
  }

  //将code标签中的内容复制到剪贴板
  copyCode(pre) {
    const code = pre.querySelector('code');
    if (code) {
      const range = document.createRange();
      range.selectNode(code);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      window.getSelection().removeAllRanges();
      this.message.success('已复制代码到剪贴板');
    }
  }

  // 显示表格导出按钮
  showExportBtn() {
    const tables = this.mdContent.nativeElement.querySelectorAll('table');
    for (let index = 0; index < tables.length; index++) {
      const table = tables[index];
      if (table) {
        const exportBtn = document.createElement('button');
        exportBtn.innerText = '导出';
        exportBtn.className = 'export';
        table.appendChild(exportBtn);
        const exportBtn1 = document.createElement('button');
        exportBtn1.innerText = 'Excel';
        exportBtn1.className = 'export-btn excel';
        table.appendChild(exportBtn1);
        const exportBtn2 = document.createElement('button');
        exportBtn2.innerText = 'Json';
        exportBtn2.className = 'export-btn json';
        table.appendChild(exportBtn2);
        const exportBtn3 = document.createElement('button');
        exportBtn3.innerText = 'SQL';
        exportBtn3.className = 'export-btn sql';
        table.appendChild(exportBtn3);
        // 点击按钮后弹出导出选项，选择导出格式
        exportBtn1.onclick = () => {
          this.exportToExcel(table);
        };
        exportBtn2.onclick = () => {
          this.exportToJson(table);
        };
        exportBtn3.onclick = () => {
          this.exportToSQL(table);
        };
      }
    }
  }

  // 表格导出excel
  exportToExcel(tableEl, filename = 'table') {
    // /* 获取表格数据 */
    // const sheetData = XLSX.utils.table_to_sheet(tableEl);
    // /* 将表格数据写入工作簿 */
    // const workbook = XLSX.utils.book_new();
    // XLSX.utils.book_append_sheet(workbook, sheetData, "Sheet1");
    // /* 导出excel文件 */
    // XLSX.writeFile(workbook, `${filename}.xlsx`);
  }

  // 表格导出json
  exportToJson(tableEl, filename = 'table') {
    const table = tableEl;
    const data = [];

    // 遍历每一行
    for (let i = 1; i < table.rows.length; i++) {
      const row = table.rows[i];
      const rowData = {};

      // 遍历每一列
      for (let j = 0; j < row.cells.length; j++) {
        const cell = row.cells[j];
        const header = table.rows[0].cells[j].textContent;
        rowData[header] = cell.textContent;
      }
      data.push(rowData);
    }
    const jsonData = JSON.stringify(data);
    const blob = new Blob([jsonData], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}.json`;
    a.click();
  }

  // 表格导出SQL
  exportToSQL(tableEl, filename = 'table') {
    const tableName = 'my_table';
    const table = tableEl;
    const thead = table.getElementsByTagName('thead')[0];
    const tbody = table.getElementsByTagName('tbody')[0];
    const columnNames = Array.from(thead.getElementsByTagName('th')).map(
      (th: any) => th.textContent.trim(),
    );
    const rows = tbody.getElementsByTagName('tr');
    const data = Array.from(rows).map((row: any) =>
      Array.from(row.getElementsByTagName('td')).map((td: any) =>
        td.textContent.trim(),
      ),
    );

    let createTableSql = `CREATE TABLE ${tableName} (\n`;
    columnNames.forEach((columnName, index) => {
      createTableSql += `  ${columnName} VARCHAR(255)${
        index !== columnNames.length - 1 ? ',' : ''
      }\n`;
    });
    createTableSql += ');\n';

    let insertSql = '';
    data.forEach((row) => {
      insertSql += `INSERT INTO ${tableName} (${columnNames.join(
        ', ',
      )}) VALUES ('${row.join("', '")}');\n`;
    });

    const sqlFileContent = createTableSql + insertSql;
    const blob = new Blob([sqlFileContent], {
      type: 'text/plain;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}.sql`;
    a.click();
  }

  // 播放语音
  isPlaying = false;
  playIndex = 0;
  async playOneByOne() {
    this.isPlaying = true;
    // 以逗号或句号为分隔符，将字符串分割成数组
    let list = this.data.content.split(this.reg);
    let text = '';
    for (let index = this.playIndex; index < list.length - 1; index++) {
      text = text + list[index];
    }
    // await this.speechService.play(text);
    this.playIndex = list.length - 1;
    // 判断是否播放完毕
    if (this.isDone) {
      let list_all = this.data.content.split(this.reg);
      if (this.playIndex == list_all.length - 1) {
        // await this.speechService.play(list_all[list_all.length - 1]);
        // if (this.continuous) {
        //   this.speechService.nextInput.next("start");
        // }
        this.isPlaying = false;
        return;
      }
    }
    this.playOneByOne();
  }

  playAll() {
    // this.speechService.play(this.data.content).then(() => {
    //   this.isPlaying = false;
    // });
    this.isPlaying = true;
  }

  stopPlay() {
    // this.speechService.stopPlay();
    this.isPlaying = false;
  }

  login() {
    // this.gptService.openAuthModel()
  }

  subService() {
    // this.gptService.openSubModel()
  }

  debug() {
    // console.log(this.data, this.data.user.id == 'c11083ae-53f0-49a7-a162-6742756181e3');
  }

  stop() {
    // this.gptService.stop();
    this.isDone = true;
  }

  selectTemp(temperature) {
    // if (this.chatList.length > 1) return;
    // this.gptService.temperature = temperature;
  }

  goto(url) {
    window.open(url, '_blank');
  }
}
