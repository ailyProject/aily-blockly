import { Component, EventEmitter, Input, input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';

@Component({
  selector: 'app-cloud-project-editor',
  imports: [
    FormsModule,
    NzButtonModule,
    NzInputModule
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss'
})
export class EditorComponent {

  @Output() close = new EventEmitter<void>();
  @Input() projectData: any = {
    name: '',
    nickname: '',
    description: '',
    image: ''
  };

  onClose() {
    this.close.emit();
  }

  onSave() {
    // 保存逻辑

    this.close.emit();
  }
}
