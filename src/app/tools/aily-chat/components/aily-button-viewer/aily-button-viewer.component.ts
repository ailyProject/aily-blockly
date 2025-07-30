import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';

export interface ButtonData {
    text: string;
    action: string;
    type?: 'primary' | 'default' | 'dashed' | 'link' | 'text';
    icon?: string;
    disabled?: boolean;
    loading?: boolean;
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
            console.error('Error processing button data:', error);
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
            disabled: Boolean(buttonData.disabled),
            loading: Boolean(buttonData.loading)
        };
    }

    /**
     * 处理按钮点击事件
     */
    onButtonClick(button: ButtonData): void {
        if (button.disabled || button.loading) {
            return;
        }

        console.log('Button clicked:', button);

        // 发射事件
        this.buttonClick.emit(button);

        // 根据 action 执行相应的操作
        this.executeAction(button);
    }

    /**
     * 执行按钮动作
     */
    private executeAction(button: ButtonData): void {
        switch (button.action) {
            case 'create_project':
                this.handleCreateProject();
                break;
            case 'more_info':
                this.handleMoreInfo();
                break;
            default:
                console.warn('Unknown button action:', button.action);
                // 可以在这里添加通用的处理逻辑
                break;
        }
    }

    /**
     * 处理创建项目动作
     */
    private handleCreateProject(): void {
        console.log('Executing create project action');
        // TODO: 实现创建项目的具体逻辑
        // 可能需要调用服务或路由跳转
    }

    /**
   * 处理补充说明动作
   */
    private handleMoreInfo(): void {
        console.log('Executing more info action');
        // TODO: 实现补充说明的具体逻辑
        // 可能需要显示对话框或展开详细信息
    }
}
