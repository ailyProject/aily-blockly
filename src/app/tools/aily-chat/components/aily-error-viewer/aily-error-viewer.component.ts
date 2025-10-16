import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { AuthService } from '../../../../services/auth.service';
import { Subject, takeUntil } from 'rxjs';
import { NzModalService } from 'ng-zorro-antd/modal';
import { LoginDialogComponent } from '../../../../main-window/components/login-dialog/login-dialog.component';

export interface AilyErrorData {
    type: 'aily-error';
    "error": {
        "status": 422,
        "message": "Http failure response for http://114.132.150.141:8000/api/v1/start_session: 422 Unprocessable Content"
    },
    "message": "Http failure response for http://114.132.150.141:8000/api/v1/start_session: 422 Unprocessable Content",
    "timestamp": "2025-08-01T14:30:19.347Z",
    "severity": "error",
    "metadata": {}
    content?: string;
}

@Component({
    selector: 'app-aily-error-viewer',
    standalone: true,
    imports: [
        CommonModule,
        NzToolTipModule,
        NzButtonModule
    ],
    templateUrl: './aily-error-viewer.component.html',
    styleUrls: ['./aily-error-viewer.component.scss']
})
export class AilyErrorViewerComponent implements OnInit, OnDestroy {
    @Input() data: AilyErrorData | null = null;

    status;
    message;


    constructor(
        private authService: AuthService,
        private modal: NzModalService
    ) { }

    ngOnInit() {
        this.processData();
    }

    ngOnDestroy() {
    }

    /**
     * 设置组件数据（由指令调用）
     */
    setData(data: AilyErrorData): void {
        this.data = data;
        this.processData();
    }

    /**
     * 处理数据
     */
    private processData(): void {
        console.log('Processing error data:', this.data);
        if (this.data.error) {
            this.status = this.data.error.status
            this.message = this.data.error.message
        }
    }

    login() {
        // this.authService.showUser.next(true);
        this.openLoginDialog();
    }

    openLoginDialog() {
        const modalRef = this.modal.create({
          nzTitle: null,
          nzFooter: null,
          nzClosable: false,
          nzBodyStyle: {
            padding: '0',
          },
          nzWidth: '350px',
          nzContent: LoginDialogComponent
        });
      }


    logDetail() {
        console.log('Error Viewer Data:', this.data);
    }
}
