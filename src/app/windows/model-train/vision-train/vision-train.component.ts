import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { SubWindowComponent } from '../../../components/sub-window/sub-window.component';

@Component({
  selector: 'app-vision-train',
  imports: [
    SubWindowComponent,
    TranslateModule,
    NzButtonModule
  ],
  templateUrl: './vision-train.component.html',
  styleUrl: './vision-train.component.scss'
})
export class VisionTrainComponent {
  constructor(private router: Router) { }

  // 进入分类识别训练
  goToClassificationTrain() {
    this.router.navigate(['/model-train/vision/classification']);
  }

  // 进入目标检测训练
  goToDetectionTrain() {
    this.router.navigate(['/model-train/vision/detection']);
  }

  // 进入骨架识别训练（待实现）
  goToPoseTrain() {
    console.log('骨架识别训练功能开发中...');
  }

  close() {
    // 返回到模型训练选择页面
    this.router.navigate(['/model-train']);
  }
}
