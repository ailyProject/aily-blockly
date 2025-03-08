import { Component, ElementRef, ViewChild } from '@angular/core';
import { NzInputModule } from 'ng-zorro-antd/input';
import { FormsModule } from '@angular/forms';
import { DialogComponent } from './components/dialog/dialog.component';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';

@Component({
  selector: 'app-aily-chat',
  imports: [
    NzInputModule,
    FormsModule,
    DialogComponent,
    NzButtonModule,
    ToolContainerComponent,
    NzResizableModule
  ],
  templateUrl: './aily-chat.component.html',
  styleUrl: './aily-chat.component.scss',
})
export class AilyChatComponent {
  @ViewChild('chatContainer') chatContainer: ElementRef;
  @ViewChild('chatList') chatList: ElementRef;

  list: any = [
    {
      content: 'Hello, how can I help you?',
    },
    {
      content: 'I want to know the weather today.',
      role: 'user',
    },
    {
      content: 'Where are you now?',
    },
    {
      content: 'I am in Beijing.',
      role: 'user',
    },
    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },
    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },
    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },
    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },
    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },
    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },
    {
      content:
        'The weather in Beijing today is sunny, with a maximum temperature of 30 degrees and a minimum temperature of 20 degrees.',
    },
  ];
  inputValue =
    '帮我生成一组流水灯功能的代码块，包含开后流水灯、关闭流水灯两个块。在开发板的D2~D13引脚上均连接有LED开后流水灯功能块，可以指定流水灯速度，调用后即开启流水关闭流水灯功能块，调用后即停止流水灯。';

  constructor(
    private uiService: UiService
  ) {}

  ngOnInit() {}

  ngAfterViewInit(): void {
    // console.log(this.dragHandle);
    // this.dragHandle.nativeElement.addEventListener('mousedown', (e: MouseEvent) => {
    //   console.log('mousedown');
    //   this.isDragging = true;
    //   this.startX = e.clientX;
    //   this.startWidth = this.resizableDiv.nativeElement.getBoundingClientRect().width;
    //   this.dragHandle.nativeElement.addEventListener('mousemove', this.handleMouseMove);
    //   this.dragHandle.nativeElement.addEventListener('mouseup', this.handleMouseUp);
    // });
    this.scrollToBottom(true);
  }

  bottomHeight = 180;
  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  close() {
    this.uiService.closeTool('aily-chat');
  }

  // private handleMouseMove = (e: MouseEvent) => {
  //   if (!this.isDragging) return;
  //   const width = this.startWidth - (e.clientX - this.startX);
  //   this.resizableDiv.nativeElement['style'].width = `${width}px`;
  // }

  // private handleMouseUp = () => {
  //   this.isDragging = false;
  //   this.dragHandle.nativeElement.removeEventListener('mousemove', this.handleMouseMove);
  //   this.dragHandle.nativeElement.removeEventListener('mouseup', this.handleMouseUp);
  // }

  getRandomString() {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }

  send() {
    console.log(this.inputValue);
    const msg = {
      content: this.inputValue,
      session_id: '',
      role: 'user',
    };
    this.list.push(msg);

    const uuid = this.getRandomString();

    // TODO 内容暂时须返回 toolbox 格式的json字符串方可解析，待沟通交流 解析的blockly格式
    const content = `
#### 这是一个测试标题

\`\`\`blockly
{
  "kind": "flyoutToolbox",
  "contents": [
    {
      "kind": "block",
      "type": "controls_if"
    },
    {
      "kind": "block",
      "type": "controls_whileUntil"
    }
  ]
}
\`\`\`

# 好嘛

| 什么

\`\`\`blockly
{
  "kind": "flyoutToolbox",
  "contents": [
    {
      "kind": "block",
      "type": "controls_if"
    }
  ]
}
\`\`\`

## 这个是二级标题
`;

    const segments = this.splitContent(content);

    const contentList: any = [];

    const ruleView = /```blockly\s([\s\S]*?)\s```/;
    segments.forEach((match, index) => {
      const exec: any = ruleView.exec(match);
      if (exec) {
        try {
          const data = JSON.parse(exec[1]);
          exec.push(data);
        } catch (err) {}
        contentList.push(exec);
      } else {
        contentList.push(match);
      }
    });

    this.list.push({
      uuid,
      content,
      contentList,
      role: 'system',
    });

    this.scrollToBottom();

    return;

    // TODO 临时走本地代理，需要后端处理跨域问题后更改为完整域名 @stao
    fetchEventSource('/api/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(msg),
      onmessage: (event) => {
        const obj = this.list.find((v: any) => v.uuid === uuid);
        if (obj.isDone) return;
        obj.content += event.data;
        // TODO 生成内容块类型异常 @stao，需要处理后继续完善 @downey
        if (event.data.includes('[DONE]')) {
          obj.role = 'system';
          obj.isDone = true;
          console.log(obj.content);
        }

        this.scrollToBottom();
      },
      onerror(event) {
        console.log('服务异常', event);
      },
      onclose() {
        console.log('服务关闭');
      },
    }).then();
  }

  splitContent(content: any) {
    // 正则表达式，匹配```blockly到下一个```之间的内容
    const regex = /```blockly([\s\S]*?)```/g;

    // 使用正则表达式进行匹配
    const matches = content.match(regex);

    // 处理匹配结果，将每次```blockly前面的内容也作为一个分段
    let segments: any = [];
    let lastIndex = 0;

    if (matches) {
      matches.forEach((match) => {
        const startIndex = content.indexOf(match, lastIndex);

        // 添加```blockly前面的内容
        if (startIndex > 0) {
          segments.push(content.slice(lastIndex, startIndex));
        }

        // 添加```blockly到```之间的内容
        segments.push(match);

        // 更新lastIndex
        lastIndex = startIndex + match.length;
      });

      // 添加最后一段内容（如果有）
      if (lastIndex < content.length) {
        segments.push(content.slice(lastIndex));
      }
    } else {
      // 如果没有匹配到```blockly，则整个content作为一段
      segments.push(content);
    }

    return segments;
  }

  scrollToBottom(offset: any = -30) {
    if (this.chatList?.nativeElement && this.chatContainer?.nativeElement) {
      setTimeout(() => {
        // if (
        //   offset != true &&
        //   this.chatContainer.nativeElement.scrollTop +
        //     this.chatContainer.nativeElement.clientHeight -
        //     this.chatContainer.nativeElement.scrollHeight <
        //     offset
        // ) {
        //   return;
        // }
        this.chatContainer.nativeElement.scrollTop =
          this.chatList.nativeElement.scrollHeight;
      }, 20);
    }
  }
}
