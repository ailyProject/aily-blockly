import { Component, ViewChild, ElementRef, OnDestroy, OnInit, HostListener } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { SaveProjectModalComponent } from '../../../../components/save-project-modal/save-project-modal.component';
import { ModelProjectService } from '../../../../services/model-project.service';
import { ElectronService } from '../../../../services/electron.service';

// 标注框接口
interface BoundingBox {
  id: string;
  x: number;      // 百分比位置 (0-100)
  y: number;      // 百分比位置 (0-100)
  width: number;  // 百分比宽度 (0-100)
  height: number; // 百分比高度 (0-100)
  label: string;
}

// 标注数据接口
interface AnnotationData {
  imageUrl: string;
  imageIndex: number;
  boxes: BoundingBox[];
}

@Component({
  selector: 'app-detection-train',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SubWindowComponent,
    SaveProjectModalComponent,
    TranslateModule,
    NzButtonModule,
    NzSelectModule,
    NzModalModule,
    NzInputModule
  ],
  templateUrl: './detection-train.component.html',
  styleUrl: './detection-train.component.scss'
})
export class DetectionTrainComponent implements OnInit, OnDestroy {
  @ViewChild('cameraVideo') cameraVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('cameraCanvas') cameraCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewVideo') previewVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('annotationImage') annotationImage!: ElementRef<HTMLImageElement>;
  @ViewChild('annotationCanvas') annotationCanvas!: ElementRef<HTMLCanvasElement>;

  // 摄像头状态
  cameraOpened = false;
  cameraError = false;
  cameraMirrored = true;
  private mediaStream: MediaStream | null = null;
  
  // 上传的图片列表
  uploadedImages: string[] = [];
  
  // 分页相关 - 使用固定数量，CSS负责自适应布局
  currentPage = 1;
  readonly PAGE_SIZE_NORMAL = 12; // 未打开摄像头时每页15张
  readonly PAGE_SIZE_CAMERA = 12; // 打开摄像头时每页15张
  
  // 标注窗口相关
  annotationOpened = false;
  currentAnnotation: AnnotationData | null = null;
  allLabels: string[] = []; // 已有的label列表
  newLabelName = '';
  selectedLabel = '';
  
  // 标签弹窗相关
  isLabelModalVisible = false;
  tempBoxForLabel: BoundingBox | null = null;
  modalLabelName = '';
  
  // 标注框绘制相关
  isDrawing = false;
  isResizing = false;
  isDragging = false;
  drawStartX = 0;
  drawStartY = 0;
  currentBox: BoundingBox | null = null;
  selectedBoxId: string | null = null;
  resizeHandle: string | null = null; // 'nw', 'ne', 'sw', 'se'
  dragOffsetX = 0;
  dragOffsetY = 0;
  
  // 存储所有图片的标注数据
  imageAnnotations: Map<number, BoundingBox[]> = new Map();
  
  // 裁剪遮罩偏移（用于计算遮罩位置）
  cropMaskOffset = { left: 0, right: 0, top: 0, bottom: 0 };

  // 保存项目相关
  isSaveProjectModalVisible = false;
  projectSaveName = '';
  projectSavePath = '';
  savedProjectFullPath = ''; // 已保存项目的完整路径
  
  // 获取当前页大小
  get pageSize(): number {
    return this.cameraOpened ? this.PAGE_SIZE_CAMERA : this.PAGE_SIZE_NORMAL;
  }
  
  // 获取当前页的图片
  get pagedImages(): string[] {
    const start = (this.currentPage - 1) * this.pageSize;
    const end = start + this.pageSize;
    return this.uploadedImages.slice(start, end);
  }
  
  // 获取总页数
  get totalPages(): number {
    return Math.ceil(this.uploadedImages.length / this.pageSize);
  }

  // 已标注图片数量（至少有一个box）
  get annotatedImageCount(): number {
    let count = 0;
    this.imageAnnotations.forEach(boxes => {
      if (boxes && boxes.length > 0) count++;
    });
    return count;
  }

  // 标签数量
  get labelCount(): number {
    return this.allLabels.length;
  }
  
  // 训练相关
  isTraining = false;
  showAdvanced = false;
  trainConfig = {
    epochs: 50,
    batchSize: 32,
    learningRate: 0.001
  };
  
  // 模型相关
  modelTrained = false;
  
  // 预览相关
  previewEnabled = false;
  previewInputSource: 'webcam' | 'upload' = 'webcam';

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private message: NzMessageService,
    private modelProjectService: ModelProjectService,
    private electronService: ElectronService
  ) { }

  ngOnInit() {
    // 初始化默认保存路径
    this.projectSavePath = this.modelProjectService.getDefaultSavePath();
    
    // 检查是否有项目路径参数（从打开项目跳转而来）
    this.route.queryParams.subscribe(params => {
      if (params['projectPath']) {
        this.loadProject(params['projectPath']);
      }
    });
  }

  /**
   * 加载项目数据
   */
  private loadProject(projectPath: string) {
    const loadingMsg = this.message.loading('正在加载项目...', { nzDuration: 0 });
    
    try {
      const projectData = this.modelProjectService.loadDetectionProject(projectPath);
      
      if (!projectData) {
        this.message.remove(loadingMsg.messageId);
        this.message.error('无法加载项目数据');
        return;
      }

      // 加载标签列表
      this.allLabels = projectData.labels || [];
      
      // 加载图片
      this.uploadedImages = projectData.images || [];
      
      // 加载标注数据
      this.imageAnnotations.clear();
      if (projectData.annotations) {
        projectData.annotations.forEach((annotationData, index) => {
          if (annotationData.boxes && annotationData.boxes.length > 0) {
            // 将标注框转换为内部格式
            const boxes: BoundingBox[] = annotationData.boxes.map((box: any, boxIndex: number) => ({
              id: `box_${index}_${boxIndex}`,
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              label: box.label
            }));
            this.imageAnnotations.set(index, boxes);
          }
        });
      }

      // 加载训练配置
      if (projectData.meta.trainConfig) {
        this.trainConfig = {
          epochs: projectData.meta.trainConfig.epochs || 50,
          batchSize: projectData.meta.trainConfig.batchSize || 32,
          learningRate: projectData.meta.trainConfig.learningRate || 0.001
        };
      }

      // 设置项目保存信息
      this.savedProjectFullPath = projectPath;
      this.projectSaveName = projectData.meta.name;
      this.modelTrained = projectData.meta.modelTrained || false;

      // 添加到最近打开的项目
      this.modelProjectService.addRecentProject({
        name: projectData.meta.name,
        nickname: projectData.meta.nickname,
        path: projectPath,
        modelType: 'detection',
        updatedAt: new Date().toISOString()
      });

      this.message.remove(loadingMsg.messageId);
      this.message.success(`项目 "${projectData.meta.name}" 加载成功`);
      
    } catch (error: any) {
      this.message.remove(loadingMsg.messageId);
      console.error('加载项目失败:', error);
      this.message.error(`加载项目失败: ${error.message}`);
    }
  }

  // 打开摄像头
  async openCamera() {
    // 如果在标注模式下打开摄像头，先保存标注并关闭标注窗口
    if (this.annotationOpened) {
      this.saveCurrentAnnotation();
      this.annotationOpened = false;
      this.currentAnnotation = null;
      this.selectedBoxId = null;
      this.isDrawing = false;
      this.isDragging = false;
      this.isResizing = false;
    }
    
    this.cameraOpened = true;
    this.cameraError = false;
    // 切换模式时重置到第一页
    // this.currentPage = 1;

    try {
      // 延迟获取video元素，确保DOM已渲染
      setTimeout(async () => {
        if (!this.cameraVideo) {
          console.error('Camera video element not found');
          this.cameraError = true;
          return;
        }

        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { 
              width: { ideal: 640 },
              height: { ideal: 480 }
            }
          });
          this.cameraVideo.nativeElement.srcObject = this.mediaStream;
        } catch (err) {
          console.error('Error accessing camera:', err);
          this.cameraError = true;
        }
      }, 100);
    } catch (err) {
      console.error('Error opening camera:', err);
      this.cameraError = true;
    }
  }

  // 关闭摄像头
  closeCamera() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.cameraVideo?.nativeElement) {
      this.cameraVideo.nativeElement.srcObject = null;
    }
    this.cameraOpened = false;
    this.cameraError = false;
    // 切换模式时重置到第一页
    // this.currentPage = 1;
  }

  // 切换镜像
  toggleMirror() {
    this.cameraMirrored = !this.cameraMirrored;
  }

  // 拍照
  captureImage() {
    if (!this.cameraVideo?.nativeElement || !this.cameraCanvas?.nativeElement) {
      return;
    }

    const video = this.cameraVideo.nativeElement;
    const canvas = this.cameraCanvas.nativeElement;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // 如果是镜像模式，翻转画布
      if (this.cameraMirrored) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0);
      
      // 将canvas转换为图片并添加到列表
      const imageData = canvas.toDataURL('image/jpeg');
      this.uploadedImages.push(imageData);
    }
  }

  // 上传图片
  uploadImages() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    
    input.onchange = (event: any) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        Array.from(files).forEach((file: any) => {
          const reader = new FileReader();
          reader.onload = (e: any) => {
            this.uploadedImages.push(e.target.result);
          };
          reader.readAsDataURL(file);
        });
      }
    };
    
    input.click();
  }

  // 查看图片
  viewImage(index: number) {
    // 先保存当前标注
    this.saveCurrentAnnotation();
    
    // 计算实际的图片索引
    const actualIndex = (this.currentPage - 1) * this.pageSize + index;
    this.openAnnotation(actualIndex);
  }
  
  // 打开标注窗口
  openAnnotation(imageIndex: number) {
    const imageUrl = this.uploadedImages[imageIndex];
    if (!imageUrl) return;
    
    // 如果摄像头正在使用，先关闭它
    if (this.cameraOpened) {
      this.closeCamera();
    }
    
    // 获取该图片已有的标注，或创建空数组
    const existingBoxes = this.imageAnnotations.get(imageIndex) || [];
    
    this.currentAnnotation = {
      imageUrl,
      imageIndex,
      boxes: [...existingBoxes] // 复制一份
    };
    this.annotationOpened = true;
    this.selectedBoxId = null;
    this.selectedLabel = this.allLabels.length > 0 ? this.allLabels[0] : '';
    
    // 重置裁剪遮罩（等待图片加载后计算）
    this.cropMaskOffset = { left: 0, right: 0, top: 0, bottom: 0 };
  }
  
  // 标注图片加载完成
  onAnnotationImageLoad() {
    if (!this.annotationImage?.nativeElement) return;
    
    const img = this.annotationImage.nativeElement;
    const container = img.parentElement;
    if (!container) return;
    
    // 获取容器和图片的尺寸
    const containerRect = container.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;
    
    // 获取图片的自然尺寸
    const imgWidth = img.naturalWidth;
    const imgHeight = img.naturalHeight;
    
    if (imgWidth === 0 || imgHeight === 0) return;
    
    // 计算图片的宽高比
    const imgAspect = imgWidth / imgHeight;
    const containerAspect = containerWidth / containerHeight;
    
    // 重置所有遮罩
    this.cropMaskOffset = { left: 0, right: 0, top: 0, bottom: 0 };
    
    if (imgAspect > 1) {
      // 横向图片 (宽>高)：需要遮盖左右两侧
      // 图片会占满容器高度，宽度按比例
      const visibleWidth = containerHeight * imgAspect;
      const cropWidth = (visibleWidth - containerHeight) / 2;
      const cropPercent = (cropWidth / visibleWidth) * 100;
      
      this.cropMaskOffset.left = cropPercent;
      this.cropMaskOffset.right = cropPercent;
    } else if (imgAspect < 1) {
      // 纵向图片 (高>宽)：需要遮盖上下两侧
      // 图片会占满容器宽度，高度按比例
      const visibleHeight = containerWidth / imgAspect;
      const cropHeight = (visibleHeight - containerWidth) / 2;
      const cropPercent = (cropHeight / visibleHeight) * 100;
      
      this.cropMaskOffset.top = cropPercent;
      this.cropMaskOffset.bottom = cropPercent;
    }
    // 如果是正方形（imgAspect === 1），不需要遮罩
  }
  
  // 保存当前标注数据
  private saveCurrentAnnotation() {
    if (this.currentAnnotation) {
      this.imageAnnotations.set(
        this.currentAnnotation.imageIndex, 
        [...this.currentAnnotation.boxes]
      );
    }
  }
  
  // 关闭标注窗口
  closeAnnotation() {
    // 保存标注数据
    this.saveCurrentAnnotation();
    
    this.annotationOpened = false;
    this.currentAnnotation = null;
    this.selectedBoxId = null;
    this.isDrawing = false;
    this.isDragging = false;
    this.isResizing = false;
  }
  
  // 删除当前图片
  deleteCurrentImage() {
    if (!this.currentAnnotation) return;
    
    const index = this.currentAnnotation.imageIndex;
    
    // 删除图片
    this.uploadedImages.splice(index, 1);
    
    // 删除对应的标注信息
    this.imageAnnotations.delete(index);
    
    // 更新其他图片的索引（所有大于删除索引的图片索引-1）
    const newAnnotations = new Map<number, BoundingBox[]>();
    this.imageAnnotations.forEach((boxes, key) => {
      if (key > index) {
        newAnnotations.set(key - 1, boxes);
      } else {
        newAnnotations.set(key, boxes);
      }
    });
    this.imageAnnotations = newAnnotations;
    
    // 如果还有图片，自动切换到下一张（如果是最后一张则切换到上一张）
    if (this.uploadedImages.length > 0) {
      let nextIndex = index;
      if (nextIndex >= this.uploadedImages.length) {
        nextIndex = this.uploadedImages.length - 1;
      }
      
      // 直接更新当前标注数据，避免关闭再打开造成闪烁
      const nextImageUrl = this.uploadedImages[nextIndex];
      const existingBoxes = this.imageAnnotations.get(nextIndex) || [];
      
      this.currentAnnotation = {
        imageUrl: nextImageUrl,
        imageIndex: nextIndex,
        boxes: [...existingBoxes]
      };
      this.selectedBoxId = null;
      this.isDrawing = false;
      this.isDragging = false;
      this.isResizing = false;
      
      // 重置裁剪遮罩
      this.cropMaskOffset = { left: 0, right: 0, top: 0, bottom: 0 };
    } else {
      // 没有图片了，直接关闭
      this.annotationOpened = false;
      this.currentAnnotation = null;
      this.selectedBoxId = null;
      this.isDrawing = false;
      this.isDragging = false;
      this.isResizing = false;
    }
    
    // 如果当前页没有图片了，回到上一页
    if (this.currentPage > this.totalPages && this.totalPages > 0) {
      this.currentPage = this.totalPages;
    }
  }
  
  // 上一张图片
  previousImage() {
    if (!this.currentAnnotation) return;
    const currentIndex = this.currentAnnotation.imageIndex;
    if (currentIndex > 0) {
      // 保存当前标注
      this.saveCurrentAnnotation();
      // 切换到上一张
      this.openAnnotation(currentIndex - 1);

      // 计算这张图片所在页，如果不在当前页则切换页码
      const newPage = Math.ceil((this.currentAnnotation.imageIndex + 1) / this.pageSize);
      if (newPage !== this.currentPage) {
        this.currentPage = newPage;
      }
    }
  }
  
  // 下一张图片
  nextImage() {
    if (!this.currentAnnotation) return;
    const currentIndex = this.currentAnnotation.imageIndex;
    if (currentIndex < this.uploadedImages.length - 1) {
      // 保存当前标注
      this.saveCurrentAnnotation();
      // 切换到下一张
      this.openAnnotation(currentIndex + 1);

      const newPage = Math.ceil((this.currentAnnotation.imageIndex + 1) / this.pageSize);
      if (newPage !== this.currentPage) {
        this.currentPage = newPage;
      }
    }
  }

  deleteSelectedLabel() {
    if (!this.selectedLabel) return;

    const labelToDelete = this.selectedLabel;
    const idx = this.allLabels.indexOf(labelToDelete);
    if (idx === -1) return;

    // 从标签列表中移除
    this.allLabels.splice(idx, 1);

    // 将当前图片以及其他图片中使用了该标签的标注框，替换为默认标签或清空
    const fallback = this.allLabels.length > 0 ? this.allLabels[0] : '';

    // 更新当前打开的图片标注
    if (this.currentAnnotation) {
      this.currentAnnotation.boxes.forEach(b => {
        if (b.label === labelToDelete) b.label = fallback;
      });
    }

    // 更新所有已保存的标注
    this.imageAnnotations.forEach((boxes, key) => {
      boxes.forEach(b => {
        if (b.label === labelToDelete) b.label = fallback;
      });
    });

    // 更新 selectedLabel
    this.selectedLabel = fallback;
  }

  openLabelModal() {
    this.isLabelModalVisible = true;
    this.modalLabelName = '';
  }
  
  // 标签切换 - 更新当前选中标注框的标签
  onLabelChange(newLabel: string) {
    if (!this.currentAnnotation) return;
    
    // 如果有选中的标注框，更新其标签
    if (this.selectedBoxId) {
      const box = this.currentAnnotation.boxes.find(b => b.id === this.selectedBoxId);
      if (box) {
        box.label = newLabel;
      }
    }
  }
  
  // 添加新label
  addNewLabel() {
    if (this.newLabelName.trim() && !this.allLabels.includes(this.newLabelName.trim())) {
      this.allLabels.push(this.newLabelName.trim());
      this.selectedLabel = this.newLabelName.trim();
      this.newLabelName = '';
    }
  }
  
  // 获取指定图片的标注数据（用于网格预览）
  getImageAnnotations(imageIndex: number): BoundingBox[] {
    return this.imageAnnotations.get(imageIndex) || [];
  }
  
  // 生成唯一ID
  private generateBoxId(): string {
    return 'box_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
  
  // 鼠标按下 - 开始绘制或拖拽
  onAnnotationMouseDown(event: MouseEvent) {
    if (!this.currentAnnotation) return;
    
    const target = event.target as HTMLElement;
    const container = target.closest('.annotation-image-container') as HTMLElement;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    
    // 检查是否点击了调整大小手柄
    const resizeTarget = (event.target as HTMLElement).closest('.resize-handle');
    if (resizeTarget && this.selectedBoxId) {
      this.isResizing = true;
      this.resizeHandle = resizeTarget.getAttribute('data-handle');
      this.drawStartX = x;
      this.drawStartY = y;
      event.preventDefault();
      return;
    }
    
    // 检查是否点击了拖拽区域
    const dragTarget = (event.target as HTMLElement).closest('.box-drag-area');
    if (dragTarget) {
      const boxId = dragTarget.getAttribute('data-box-id');
      if (boxId) {
        this.selectedBoxId = boxId;
        this.isDragging = true;
        const box = this.currentAnnotation.boxes.find(b => b.id === boxId);
        if (box) {
          this.dragOffsetX = x - box.x;
          this.dragOffsetY = y - box.y;
        }
        event.preventDefault();
        return;
      }
    }
    
    // 检查是否点击了已有的标注框
    const boxTarget = (event.target as HTMLElement).closest('.annotation-box');
    if (boxTarget) {
      const boxId = boxTarget.getAttribute('data-box-id');
      if (boxId) {
        this.selectedBoxId = boxId;
        event.preventDefault();
        return;
      }
    }
    
    // 开始绘制新框（即使没有标签也允许绘制）
    this.isDrawing = true;
    this.drawStartX = x;
    this.drawStartY = y;
    this.selectedBoxId = null;
    
    const newBox: BoundingBox = {
      id: this.generateBoxId(),
      x: x,
      y: y,
      width: 0,
      height: 0,
      label: this.selectedLabel || '' // 如果没有标签，先设置为空
    };
    this.currentBox = newBox;
    event.preventDefault();
  }
  
  // 鼠标移动 - 绘制或拖拽
  @HostListener('document:mousemove', ['$event'])
  onAnnotationMouseMove(event: MouseEvent) {
    if (!this.currentAnnotation) return;
    if (!this.isDrawing && !this.isDragging && !this.isResizing) return;
    
    const container = document.querySelector('.annotation-image-container') as HTMLElement;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    let x = ((event.clientX - rect.left) / rect.width) * 100;
    let y = ((event.clientY - rect.top) / rect.height) * 100;
    
    // 限制在0-100范围内
    x = Math.max(0, Math.min(100, x));
    y = Math.max(0, Math.min(100, y));
    
    if (this.isDrawing && this.currentBox) {
      // 绘制新框
      const width = x - this.drawStartX;
      const height = y - this.drawStartY;
      
      if (width >= 0) {
        this.currentBox.x = this.drawStartX;
        this.currentBox.width = width;
      } else {
        this.currentBox.x = x;
        this.currentBox.width = -width;
      }
      
      if (height >= 0) {
        this.currentBox.y = this.drawStartY;
        this.currentBox.height = height;
      } else {
        this.currentBox.y = y;
        this.currentBox.height = -height;
      }
    } else if (this.isDragging && this.selectedBoxId) {
      // 拖拽移动
      const box = this.currentAnnotation.boxes.find(b => b.id === this.selectedBoxId);
      if (box) {
        let newX = x - this.dragOffsetX;
        let newY = y - this.dragOffsetY;
        
        // 确保不超出边界
        newX = Math.max(0, Math.min(100 - box.width, newX));
        newY = Math.max(0, Math.min(100 - box.height, newY));
        
        box.x = newX;
        box.y = newY;
      }
    } else if (this.isResizing && this.selectedBoxId && this.resizeHandle) {
      // 调整大小
      const box = this.currentAnnotation.boxes.find(b => b.id === this.selectedBoxId);
      if (box) {
        const minSize = 5; // 最小5%
        
        switch (this.resizeHandle) {
          case 'se': // 右下角
            box.width = Math.max(minSize, x - box.x);
            box.height = Math.max(minSize, y - box.y);
            break;
          case 'sw': // 左下角
            const newWidthSW = box.x + box.width - x;
            if (newWidthSW >= minSize) {
              box.x = x;
              box.width = newWidthSW;
            }
            box.height = Math.max(minSize, y - box.y);
            break;
          case 'ne': // 右上角
            box.width = Math.max(minSize, x - box.x);
            const newHeightNE = box.y + box.height - y;
            if (newHeightNE >= minSize) {
              box.y = y;
              box.height = newHeightNE;
            }
            break;
          case 'nw': // 左上角
            const newWidthNW = box.x + box.width - x;
            const newHeightNW = box.y + box.height - y;
            if (newWidthNW >= minSize) {
              box.x = x;
              box.width = newWidthNW;
            }
            if (newHeightNW >= minSize) {
              box.y = y;
              box.height = newHeightNW;
            }
            break;
        }
      }
    }
  }
  
  // 鼠标释放 - 结束绘制或拖拽
  @HostListener('document:mouseup', ['$event'])
  onAnnotationMouseUp(event: MouseEvent) {
    if (this.isDrawing && this.currentBox && this.currentAnnotation) {
      // 只添加有一定大小的框
      if (this.currentBox.width > 2 && this.currentBox.height > 2) {
        // 如果没有标签，弹窗让用户添加
        if (!this.currentBox.label || this.allLabels.length === 0) {
          this.tempBoxForLabel = this.currentBox;
          this.modalLabelName = '';
          this.isLabelModalVisible = true;
        } else {
          this.currentAnnotation.boxes.push(this.currentBox);
          this.selectedBoxId = this.currentBox.id;
        }
      }
      this.currentBox = null;
    }
    
    this.isDrawing = false;
    this.isDragging = false;
    this.isResizing = false;
    this.resizeHandle = null;
  }
  
  // 关闭标签弹窗
  closeLabelModal() {
    this.isLabelModalVisible = false;
    this.tempBoxForLabel = null;
    this.modalLabelName = '';
  }
  
  // 确认添加标签
  confirmAddLabel() {
    if (!this.modalLabelName.trim()) {
      return;
    }
    
    const labelName = this.modalLabelName.trim();
    
    // 如果标签不存在，添加到标签列表
    if (!this.allLabels.includes(labelName)) {
      this.allLabels.push(labelName);
    }
    
    // 如果是为刚绘制的标注框添加标签
    if (this.tempBoxForLabel && this.currentAnnotation) {
      // 设置标注框的标签
      this.tempBoxForLabel.label = labelName;
      
      // 添加到标注列表
      this.currentAnnotation.boxes.push(this.tempBoxForLabel);
      this.selectedBoxId = this.tempBoxForLabel.id;
    }
    
    // 设置为当前选中标签（无论是哪种场景）
    this.selectedLabel = labelName;
    
    // 关闭弹窗
    this.closeLabelModal();
  }
  
  // 删除标注框
  deleteBox(boxId: string) {
    if (!this.currentAnnotation) return;
    
    const index = this.currentAnnotation.boxes.findIndex(b => b.id === boxId);
    if (index > -1) {
      this.currentAnnotation.boxes.splice(index, 1);
    }
    if (this.selectedBoxId === boxId) {
      this.selectedBoxId = null;
    }
  }
  
  // 更新标注框的label
  updateBoxLabel(boxId: string, label: string) {
    if (!this.currentAnnotation) return;
    
    const box = this.currentAnnotation.boxes.find(b => b.id === boxId);
    if (box) {
      box.label = label;
    }
  }
  
  // 上一页
  prevPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
    }
  }
  
  // 下一页
  nextPage() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
    }
  }
  
  // 跳转到指定页
  goToPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  // 切换高级选项
  toggleAdvanced() {
    this.showAdvanced = !this.showAdvanced;
  }

  // 重置训练配置
  resetTrainConfig() {
    this.trainConfig = {
      epochs: 50,
      batchSize: 32,
      learningRate: 0.001
    };
  }

  // 开始训练
  startTraining() {
    // TODO: 实现训练逻辑
    console.log('开始训练...');
  }

  // 导出模型
  exportModel() {
    // TODO: 实现模型导出逻辑
    console.log('导出模型...');
  }

  // 部署模型
  deployModel() {
    // TODO: 实现模型部署逻辑
    console.log('部署模型...');
  }

  // 打开保存项目模态框
  openSaveProjectModal() {
    // 如果项目已保存，直接保存到现有路径
    if (this.savedProjectFullPath) {
      this.saveToExistingProject();
      return;
    }
    
    this.isSaveProjectModalVisible = true;
  }

  // 关闭保存项目模态框
  closeSaveProjectModal() {
    this.isSaveProjectModalVisible = false;
  }

  async handleSaveProject(data: { name: string; path: string }) {
    if (!this.electronService.isElectron) {
      this.message.error('保存功能仅在 Electron 环境下可用');
      return;
    }

    // 先保存当前标注
    this.saveCurrentAnnotation();

    const loadingMsg = this.message.loading('正在保存项目...', { nzDuration: 0 });

    try {
      const options = {
        projectName: data.name,
        projectPath: data.path,
        modelType: 'detection' as const,
        trainConfig: {
          epochs: this.trainConfig.epochs,
          batchSize: this.trainConfig.batchSize,
          learningRate: this.trainConfig.learningRate
        },
        modelTrained: this.modelTrained
      };

      const result = await this.modelProjectService.saveDetectionProject(
        options,
        this.allLabels,
        this.uploadedImages,
        this.imageAnnotations
      );

      if (result.success) {
        this.savedProjectFullPath = result.projectPath!;
        this.projectSaveName = data.name;
        this.projectSavePath = data.path;
        this.message.remove(loadingMsg.messageId);
        this.message.success(`项目已保存到: ${result.projectPath}`);
        this.closeSaveProjectModal();
      } else {
        this.message.remove(loadingMsg.messageId);
        this.message.error(result.error || '保存项目失败');
      }

    } catch (error: any) {
      this.message.remove(loadingMsg.messageId);
      console.error('保存项目失败:', error);
      this.message.error(`保存项目失败: ${error.message}`);
    }
  }

  // 保存到已存在的项目
  private async saveToExistingProject() {
    // 先保存当前标注
    this.saveCurrentAnnotation();

    const loadingMsg = this.message.loading('正在更新项目...', { nzDuration: 0 });

    try {
      const options = {
        projectName: this.projectSaveName,
        projectPath: this.projectSavePath,
        modelType: 'detection' as const,
        trainConfig: {
          epochs: this.trainConfig.epochs,
          batchSize: this.trainConfig.batchSize,
          learningRate: this.trainConfig.learningRate
        },
        modelTrained: this.modelTrained
      };

      const result = await this.modelProjectService.updateDetectionProject(
        this.savedProjectFullPath,
        options,
        this.allLabels,
        this.uploadedImages,
        this.imageAnnotations
      );

      this.message.remove(loadingMsg.messageId);
      
      if (result.success) {
        this.message.success('项目已更新');
      } else {
        this.message.error(result.error || '更新项目失败');
      }

    } catch (error: any) {
      this.message.remove(loadingMsg.messageId);
      console.error('更新项目失败:', error);
      this.message.error(`更新项目失败: ${error.message}`);
    }
  }

  close() {
    // 返回到视觉模型训练选择页面
    this.router.navigate(['/model-train/vision']);
  }

  ngOnDestroy() {
    // 清理摄像头资源
    this.closeCamera();
  }
}
