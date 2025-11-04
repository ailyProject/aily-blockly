import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { ChatService } from '../../services/chat.service';

export interface ButtonData {
    text: string;
    action: string;
    type?: 'primary' | 'default' | 'dashed' | 'link' | 'text';
    icon?: string;
    disabled?: boolean;
    loading?: boolean;
    id?: string;
}

@Component({
    selector: 'app-aily-button-viewer',
    standalone: true,
    imports: [CommonModule, NzButtonModule, NzIconModule],
    templateUrl: './aily-button-viewer.component.html',
    styleUrl: './aily-button-viewer.component.scss'
})
export class AilyButtonViewerComponent {
    @Input() data: any;
    @Output() buttonClick = new EventEmitter<ButtonData>();

    buttons: ButtonData[] = [];

    isDisabled = false

    constructor(private chatService: ChatService) {
    }

    /**
     * 设置组件数据
     */
    setData(data: any): void {
        this.data = data;
        this.processData();
    }

    /**
     * 处理输入数据
     */
    private processData(): void {
        if (!this.data) {
            this.buttons = [];
            return;
        }

        try {
            // 如果 data.buttons 存在，使用它；否则使用 data 本身
            const buttonsData = this.data.buttons || this.data;

            if (Array.isArray(buttonsData)) {
                this.buttons = buttonsData.map(this.normalizeButtonData);
            } else if (typeof buttonsData === 'object') {
                // 单个按钮数据
                this.buttons = [this.normalizeButtonData(buttonsData)];
            } else {
                console.warn('Invalid button data format:', buttonsData);
                this.buttons = [];
            }
        } catch (error) {
            console.warn('Error processing button data:', error);
            this.buttons = [];
        }
    }

    /**
     * 规范化按钮数据
     */
    private normalizeButtonData(buttonData: any): ButtonData {
        return {
            text: buttonData.text || buttonData.label || '按钮',
            action: buttonData.action || buttonData.command || '',
            type: buttonData.type || 'primary',
            icon: buttonData.icon,
            id: buttonData.id || ''
        };
    }

    /**
     * 处理按钮点击事件
     */
    onButtonClick(button: ButtonData): void {
        this.isDisabled = true;

        // 发射事件
        this.buttonClick.emit(button);

        const sendData = button.text

        // 直接往大模型发送按钮点击的消息
        this.chatService.sendTextToChat(sendData, { sender: 'button', type: 'button', cover: false });
    }

    logDetail() {
        console.log('Button Viewer Data:', this.data);
    }
}
