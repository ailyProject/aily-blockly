import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subscription } from 'rxjs';
import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { SaveProjectModalComponent } from '../../../../components/save-project-modal/save-project-modal.component';
import { ModelTrainService, TrainProgress, ClassData } from '../../../../services/model-train.service';
import { ModelProjectService, ClassificationClassData } from '../../../../services/model-project.service';
import { ElectronService } from '../../../../services/electron.service';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-webgpu';

interface ClassItem {
  id: number;
  name: string;
  enabled: boolean;
  samples: string[];
}

@Component({
  selector: 'app-classification-train',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SubWindowComponent,
    SaveProjectModalComponent,
    TranslateModule,
    NzButtonModule,
    NzToolTipModule,
    NzModalModule,
    NzInputModule,
    NzSelectModule,
    NzProgressModule
  ],
  templateUrl: './classification-train.component.html',
  styleUrl: './classification-train.component.scss'
})
export class ClassificationTrainComponent implements OnInit, OnDestroy {
  @ViewChild('cameraVideo') cameraVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('cameraCanvas') cameraCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewVideo') previewVideo!: ElementRef<HTMLVideoElement>;

  // 类别列表
  classList: ClassItem[] = [
    { id: 1, name: 'Class 1', enabled: true, samples: [] },
    { id: 2, name: 'Class 2', enabled: true, samples: [] }
  ];

  // 当前激活的菜单ID
  activeMenuId: number | null = null;

  // 编辑类名相关
  editingClassId: number | null = null;
  editingClassName: string = '';

  // 查看图片弹窗相关
  isImageModalVisible = false;
  currentViewingImages: string[] = [];
  currentViewingIndex = 0;
  currentViewingClassId: number | null = null;
  selectedClassForMove: number | null = null;

  // 摄像头采集相关（使用单一 mediaStream 管理所有摄像头流）
  currentCameraClassId: number | null = null;
  // 统一的媒体流（同时用于采集与预览）
  mediaStream: MediaStream | null = null;
  // 使用计数：同时有多少用途在使用该流（preview / camera）
  private mediaStreamUsageCount = 0;
  // 摄像头镜像状态（水平翻转预览与采集）
  cameraMirrored: boolean = false;
  cameraError: boolean = false;

  // 训练配置
  trainConfig = {
    epochs: 50,
    batchSize: 16,
    learningRate: 0.001
  };

  // 状态
  isTraining = false;
  modelTrained = false;
  showAdvanced = false;

  // 训练进度
  trainProgress: TrainProgress | null = null;
  private trainProgressSubscription: Subscription | null = null;

  // 训练结果
  trainedModelPath: string | null = null;

  // 预览相关
  previewEnabled: boolean = false;
  previewInputSource: string = 'webcam';
  previewStream: MediaStream | null = null;
  previewMirrored: boolean = false;
  private previewAnimationId: number | null = null;
  uploadedPreviewImage: string | null = null;
  
  // 模型推理相关
  private trainedModel: tf.LayersModel | null = null;
  private realTimePredictions: { [key: number]: number } = {};
  private isInferencing: boolean = false;
  private trainedClassLabels: string[] = []; // 训练时的类别标签顺序（来自label.txt）

  // 类别颜色配置
  private classColors = [
    { text: '#f5a623', bar: 'linear-gradient(90deg, #f5a623 0%, #f8c471 100%)' },
    { text: '#e74c8c', bar: 'linear-gradient(90deg, #f8b4c8 0%, #f5d0dc 100%)' },
    { text: '#3498db', bar: 'linear-gradient(90deg, #3498db 0%, #85c1e9 100%)' },
    { text: '#2ecc71', bar: 'linear-gradient(90deg, #2ecc71 0%, #82e0aa 100%)' },
    { text: '#9b59b6', bar: 'linear-gradient(90deg, #9b59b6 0%, #c39bd3 100%)' },
    { text: '#e67e22', bar: 'linear-gradient(90deg, #e67e22 0%, #f0b27a 100%)' },
    { text: '#1abc9c', bar: 'linear-gradient(90deg, #1abc9c 0%, #76d7c4 100%)' },
    { text: '#34495e', bar: 'linear-gradient(90deg, #34495e 0%, #7f8c8d 100%)' },
    { text: '#f39c12', bar: 'linear-gradient(90deg, #f39c12 0%, #f7dc6f 100%)' },
  ];

  private nextClassId = 3;

  // 保存项目相关
  isSaveProjectModalVisible = false;
  projectSaveName = '';
  projectSavePath = '';
  savedProjectFullPath = ''; // 已保存项目的完整路径

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private modal: NzModalService,
    private modelTrainService: ModelTrainService,
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
    
    // 订阅训练进度
    this.trainProgressSubscription = this.modelTrainService.progress$.subscribe(
      progress => {
        this.trainProgress = progress;
        console.log('训练进度:', progress);
      }
    );
  }

  /**
   * 加载项目数据
   */
  private loadProject(projectPath: string) {
    const loadingMsg = this.message.loading('正在加载项目...', { nzDuration: 0 });
    
    try {
      const projectData = this.modelProjectService.loadClassificationProject(projectPath);
      
      if (!projectData) {
        this.message.remove(loadingMsg.messageId);
        this.message.error('无法加载项目数据');
        return;
      }

      // 加载类别数据
      this.classList = projectData.classes.map((classData, index) => ({
        id: index + 1,
        name: classData.name,
        enabled: classData.enabled,
        samples: classData.samples
      }));
      
      // 更新 nextClassId
      this.nextClassId = this.classList.length + 1;

      // 加载训练配置
      if (projectData.meta.trainConfig) {
        this.trainConfig = {
          epochs: projectData.meta.trainConfig.epochs || 50,
          batchSize: projectData.meta.trainConfig.batchSize || 16,
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
        modelType: 'classification',
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

  ngOnDestroy() {
    // 清理订阅
    if (this.trainProgressSubscription) {
      this.trainProgressSubscription.unsubscribe();
    }
    // 关闭摄像头
    this.closeCamera();
    // 关闭预览摄像头
    this.stopPreview();
    // 释放模型资源
    if (this.trainedModel) {
      this.trainedModel.dispose();
    }
  }

  // 添加类别
  addClass() {
    this.classList.push({
      id: this.nextClassId++,
      name: `Class ${this.classList.length + 1}`,
      enabled: true,
      samples: []
    });
  }

  // 删除类别
  deleteClass(id: number) {
    this.classList = this.classList.filter(c => c.id !== id);
    this.activeMenuId = null;
  }

  // 停用/启用类别
  toggleClass(id: number) {
    const classItem = this.classList.find(c => c.id === id);
    if (classItem) {
      classItem.enabled = !classItem.enabled;
    }
    this.activeMenuId = null;
  }

  // 切换菜单
  toggleMenu(id: number) {
    this.activeMenuId = this.activeMenuId === id ? null : id;
  }

  // 开始编辑类名
  startEditClassName(classItem: ClassItem, event: Event) {
    event.stopPropagation();
    this.editingClassId = classItem.id;
    this.editingClassName = classItem.name;
  }

  // 保存类名
  saveClassName(classItem: ClassItem) {
    if (this.editingClassName.trim()) {
      classItem.name = this.editingClassName.trim();
    }
    this.editingClassId = null;
    this.editingClassName = '';
  }

  // 取消编辑类名
  cancelEditClassName() {
    this.editingClassId = null;
    this.editingClassName = '';
  }

  // 切换摄像头（内嵌预览）
  async toggleCamera(classId: number) {
    // 如果已经打开，则关闭
    if (this.currentCameraClassId === classId) {
      this.closeCamera();
      return;
    }

    // 关闭其他摄像头
    if (this.currentCameraClassId !== null) {
      this.closeCamera();
    }

    this.currentCameraClassId = classId;
    this.cameraError = false;
    // 重置镜像状态为默认（可按需保留）
    this.cameraMirrored = false;

    // 等待视图更新后启动摄像头
    setTimeout(async () => {
      try {
          if (!this.mediaStream) {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
              video: { 
                width: { ideal: 640 },
                height: { ideal: 640 },
                facingMode: 'user'
              } 
            });
          }
          // 增加使用计数并复用同一流
          this.mediaStreamUsageCount = Math.max(0, this.mediaStreamUsageCount) + 1;
          if (this.cameraVideo && this.cameraVideo.nativeElement) {
            this.cameraVideo.nativeElement.srcObject = this.mediaStream;
            this.cameraError = false;
          }
      } catch (err) {
        console.error('无法访问摄像头:', err);
        this.cameraError = true;
      }
    }, 100);
  }

  // 关闭摄像头
  closeCamera() {
    // 从使用计数中移除摄像头占用
    if (this.mediaStreamUsageCount > 0) this.mediaStreamUsageCount--;
    // 解除 video 元素绑定
    if (this.cameraVideo && this.cameraVideo.nativeElement) {
      try { this.cameraVideo.nativeElement.srcObject = null; } catch (e) { /* ignore */ }
    }
    // 若无任何使用者则停止并释放流
    if (this.mediaStreamUsageCount <= 0 && this.mediaStream) {
      this.stopMediaStream(this.mediaStream);
      this.mediaStream = null;
      this.mediaStreamUsageCount = 0;
    }
    this.currentCameraClassId = null;
    this.cameraError = false;
  }

  // 切换镜像（水平翻转）
  toggleMirror() {
    this.cameraMirrored = !this.cameraMirrored;
    // 如果需要，可以在此保存到某个类的状态
    console.log('摄像头镜像状态:', this.cameraMirrored);
  }

  // 采集图片（从摄像头）
  captureImage() {
    if (!this.cameraVideo || !this.cameraCanvas || this.currentCameraClassId === null) return;

    const video = this.cameraVideo.nativeElement;
    const canvas = this.cameraCanvas.nativeElement;
    const classItem = this.classList.find(c => c.id === this.currentCameraClassId);
    if (!classItem) return;

    // 设置 canvas 尺寸为正方形
    const size = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = size;
    canvas.height = size;

    // 计算居中裁剪的偏移
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const offsetX = (video.videoWidth - size) / 2;
    const offsetY = (video.videoHeight - size) / 2;

    // 绘制正方形裁剪的图像，若启用镜像则在 canvas 上水平翻转
    if (this.cameraMirrored) {
      ctx.save();
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, offsetX, offsetY, size, size, 0, 0, size, size);
      ctx.restore();
    } else {
      ctx.drawImage(video, offsetX, offsetY, size, size, 0, 0, size, size);
    }

    // 转换为 data URL 并添加到样本
    const dataURL = canvas.toDataURL('image/jpeg', 0.9);
    classItem.samples.push(dataURL);
  }

  // 上传图片
  uploadImages(classId: number) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    
    input.onchange = (event: any) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        const classItem = this.classList.find(c => c.id === classId);
        if (classItem) {
          Array.from(files).forEach((file: any) => {
            const reader = new FileReader();
            reader.onload = (e: any) => {
              classItem.samples.push(e.target.result);
            };
            reader.readAsDataURL(file);
          });
        }
      }
    };
    
    input.click();
  }

  // 查看图片
  viewImage(classId: number, index: number, event: Event) {
    event.stopPropagation();
    const classItem = this.classList.find(c => c.id === classId);
    if (classItem) {
      this.currentViewingImages = [...classItem.samples];
      this.currentViewingIndex = index;
      this.currentViewingClassId = classId;
      this.selectedClassForMove = classId;
      this.isImageModalVisible = true;
    }
  }

  // 关闭图片查看弹窗
  closeImageModal() {
    this.isImageModalVisible = false;
    this.currentViewingImages = [];
    this.currentViewingIndex = 0;
    this.currentViewingClassId = null;
    this.selectedClassForMove = null;
  }

  // 上一张图片
  previousImage() {
    if (this.currentViewingIndex > 0) {
      this.currentViewingIndex--;
    }
  }

  // 下一张图片
  nextImage() {
    if (this.currentViewingIndex < this.currentViewingImages.length - 1) {
      this.currentViewingIndex++;
    }
  }

  // 删除当前图片
  deleteCurrentImage() {
    // 直接删除当前图片（不弹出确认）
    if (this.currentViewingClassId === null) return;
    const classItem = this.classList.find(c => c.id === this.currentViewingClassId);
    if (!classItem) return;

    // 从源 class 中移除当前图片
    classItem.samples.splice(this.currentViewingIndex, 1);
    this.currentViewingImages.splice(this.currentViewingIndex, 1);

    // 如果删除后没有图片，保留弹窗并显示空状态（N/A）
    if (this.currentViewingImages.length === 0) {
      this.currentViewingIndex = 0;
      return;
    }

    // 删除后仍有图片：如果删除的是最后一张，则切回上一张，否则保留当前索引（将显示下一张）
    if (this.currentViewingIndex >= this.currentViewingImages.length) {
      this.currentViewingIndex = this.currentViewingImages.length - 1;
    }
  }

  // 获取当前查看的图片
  get currentViewingImage(): string {
    return this.currentViewingImages[this.currentViewingIndex] || '';
  }

  // 获取当前查看的类名
  get currentViewingClassName(): string {
    if (this.currentViewingClassId !== null) {
      const classItem = this.classList.find(c => c.id === this.currentViewingClassId);
      return classItem ? classItem.name : '';
    }
    return '';
  }

  // 切换到上一个 class（弹窗内上按钮）
  prevClass() {
    if (this.classList.length === 0) return;
    const idx = this.currentViewingClassId === null ? -1 : this.classList.findIndex(c => c.id === this.currentViewingClassId);
    if (idx > 0) {
      this.switchToClass(this.classList[idx - 1].id);
    } else if (idx === -1) {
      // 如果尚未选中，则选择第一个
      this.switchToClass(this.classList[0].id);
    }
  }

  // 切换到下一个 class（弹窗内下按钮）
  nextClass() {
    if (this.classList.length === 0) return;
    const idx = this.currentViewingClassId === null ? -1 : this.classList.findIndex(c => c.id === this.currentViewingClassId);
    if (idx >= 0 && idx < this.classList.length - 1) {
      this.switchToClass(this.classList[idx + 1].id);
    } else if (idx === -1) {
      // 如果尚未选中，则选择第一个
      this.switchToClass(this.classList[0].id);
    }
  }

  // 将弹窗切换到指定 class（更新图片列表与索引）
  private switchToClass(classId: number) {
    const classItem = this.classList.find(c => c.id === classId);
    if (!classItem) return;
    this.currentViewingClassId = classId;
    this.currentViewingImages = [...classItem.samples];
    this.currentViewingIndex = 0;
    this.selectedClassForMove = classId;
    this.isImageModalVisible = true;
  }

  // 将当前查看的图片移动到另一个 class（通过弹窗内的下拉选择）
  moveCurrentImageTo(targetClassId: number) {
    if (this.currentViewingImages.length === 0) return;
    if (this.currentViewingClassId === null) return;
    if (targetClassId === this.currentViewingClassId) return;

    const srcClass = this.classList.find(c => c.id === this.currentViewingClassId);
    const dstClass = this.classList.find(c => c.id === targetClassId);
    if (!srcClass || !dstClass) return;

    // 从源 class 中移除图片并取得被移动的数据
    const [moved] = srcClass.samples.splice(this.currentViewingIndex, 1);
    if (!moved) return;

    // 添加到目标 class 并记住目标索引
    dstClass.samples.push(moved);
    const newIndex = dstClass.samples.length - 1;

    // 切换到目标 class 并显示刚移动的图片
    this.currentViewingClassId = targetClassId;
    this.currentViewingImages = [...dstClass.samples];
    this.currentViewingIndex = newIndex;
    this.selectedClassForMove = targetClassId;
    this.isImageModalVisible = true;
  }

  // 立即移除某个 class 的所有样本
  removeAllSamples(classId: number) {
    const classItem = this.classList.find(c => c.id === classId);
    if (!classItem) return;

    // 清空样本数组
    classItem.samples = [];

    // 如果当前弹窗正在查看此 class，则清空弹窗内容并显示空状态
    if (this.currentViewingClassId === classId) {
      this.currentViewingImages = [];
      this.currentViewingIndex = 0;
      this.selectedClassForMove = classId;
    }

    // 关闭当前菜单（若打开）
    this.activeMenuId = null;
  }

  // 切换高级选项
  toggleAdvanced() {
    this.showAdvanced = !this.showAdvanced;
  }

  // 重置训练配置为默认值
  resetTrainConfig() {
    this.trainConfig.epochs = 50;
    this.trainConfig.batchSize = 16;
    this.trainConfig.learningRate = 0.001;
  }

  // 验证训练数据
  private validateTrainingData(): string | null {
    // 检查类别数量
    const enabledClasses = this.classList.filter(c => c.enabled);
    if (enabledClasses.length < 2) {
      return '至少需要启用 2 个类别进行训练';
    }

    // 检查每个类别是否有样本
    for (const classItem of enabledClasses) {
      if (classItem.samples.length === 0) {
        return `类别 "${classItem.name}" 没有样本图片`;
      }
    }

    return null;
  }

  // 开始训练
  async startTraining() {
    // 验证数据
    const validationError = this.validateTrainingData();
    if (validationError) {
      this.message.error(validationError);
      return;
    }

    // 关闭所有摄像头
    this.closeCamera();
    this.stopPreview();

    this.isTraining = true;
    this.trainProgress = null;

    // 准备训练数据
    const enabledClasses = this.classList.filter(c => c.enabled);
    const classData: ClassData[] = enabledClasses.map(c => ({
      name: c.name,
      images: c.samples
    }));

    try {
      // 调用训练服务（现在使用 Web Worker）
      const result = await this.modelTrainService.startTraining(
        classData,
        this.trainConfig
      );

      if (result.success) {
        this.modelTrained = true;
        this.trainedModelPath = result.modelName || null;
        
        // 保存训练时的类别标签顺序（对应模型输出的顺序）
        this.trainedClassLabels = enabledClasses.map(c => c.name);
        
        // this.message.success(`模型训练完成！模型已保存到浏览器存储: ${result.modelName}`);
        this.message.success(`模型训练完成！`);
        
        // 自动启用预览并加载模型
        this.previewEnabled = true;
        this.previewInputSource = 'webcam';
        await this.loadTrainedModel();
        await this.startPreview();
      } else {
        this.message.error(result.error || '训练失败');
      }
    } catch (error: any) {
      this.message.error(error.message || '训练过程中发生错误');
    } finally {
      this.isTraining = false;
    }
  }

  // 停止训练
  async stopTraining() {
    await this.modelTrainService.stopTraining();
    this.isTraining = false;
    this.message.info('训练已取消');
  }

  // 获取训练进度百分比
  getTrainProgressPercent(): number {
    if (!this.trainProgress || !this.trainProgress.epoch || !this.trainProgress.totalEpochs) {
      return 0;
    }
    return Math.round((this.trainProgress.epoch / this.trainProgress.totalEpochs) * 100);
  }

  // 初始化 TensorFlow.js 后端
  private async initTensorFlowBackend(): Promise<void> {
    try {
      // 尝试使用 WebGPU（最快）
      await tf.setBackend('webgpu');
      await tf.ready();
      console.log('TensorFlow.js 后端已初始化: WebGPU');
    } catch (error) {
      console.warn('WebGPU 不可用，回退到 WebGL:', error);
      try {
        // 回退到 WebGL
        await tf.setBackend('webgl');
        await tf.ready();
        console.log('TensorFlow.js 后端已初始化: WebGL');
      } catch (error2) {
        console.error('TensorFlow.js 后端初始化失败:', error2);
        // 最后回退到 CPU
        await tf.setBackend('cpu');
        await tf.ready();
        console.log('TensorFlow.js 后端已初始化: CPU');
      }
    }
  }

  // 加载训练好的模型
  private async loadTrainedModel(): Promise<void> {
    if (!this.trainedModelPath) {
      console.error('没有训练好的模型');
      return;
    }

    try {
      // 初始化 TensorFlow.js 后端
      await this.initTensorFlowBackend();
      
      // 加载完整模型（包含 MobileNet + 分类头）
      this.trainedModel = await tf.loadLayersModel(`indexeddb://${this.trainedModelPath}`);
      console.log('模型加载成功:', this.trainedModelPath);
    } catch (error) {
      console.error('加载模型失败:', error);
      this.message.error('加载模型失败');
    }
  }

  // 开始预览
  async startPreview(): Promise<void> {
    if (!this.previewEnabled || this.previewInputSource !== 'webcam') {
      return;
    }

    // 等待视图更新
    setTimeout(async () => {
      try {
        if (!this.mediaStream) {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
              width: { ideal: 640 },
              height: { ideal: 640 },
              facingMode: 'user'
            } 
          });
        }
        // 复用统一流并增加使用计数
        this.mediaStreamUsageCount = Math.max(0, this.mediaStreamUsageCount) + 1;

        if (this.previewVideo && this.previewVideo.nativeElement) {
          this.previewVideo.nativeElement.srcObject = this.mediaStream;

          // 等待视频准备就绪后开始推理
          this.previewVideo.nativeElement.onloadedmetadata = () => {
            this.startRealTimeInference();
          };
        }
      } catch (err) {
        console.error('无法访问预览摄像头:', err);
        this.message.error('无法访问摄像头');
      }
    }, 100);
  }

  // 停止预览
  stopPreview(): void {
    // 停止推理循环
    if (this.previewAnimationId) {
      cancelAnimationFrame(this.previewAnimationId);
      this.previewAnimationId = null;
    }
    
    // 从使用计数中移除预览占用
    if (this.mediaStreamUsageCount > 0) this.mediaStreamUsageCount--;
    // 解除 preview 绑定
    if (this.previewVideo && this.previewVideo.nativeElement) {
      try { this.previewVideo.nativeElement.srcObject = null; } catch (e) { /* ignore */ }
    }
    // 若无任何使用者则停止并释放流
    if (this.mediaStreamUsageCount <= 0 && this.mediaStream) {
      this.stopMediaStream(this.mediaStream);
      this.mediaStream = null;
      this.mediaStreamUsageCount = 0;
    }
  }

  // 统一停止给定的 MediaStream（安全空检查）
  private stopMediaStream(stream: MediaStream | null): void {
    if (!stream) return;
    try {
      stream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) { /* ignore */ }
      });
    } catch (e) {
      console.warn('stopMediaStream error', e);
    }
  }

  // 强制停止并释放所有流（清理使用计数）
  private stopAllStreams(): void {
    if (this.mediaStream) {
      this.stopMediaStream(this.mediaStream);
      this.mediaStream = null;
    }
    this.mediaStreamUsageCount = 0;
    // 解除 video 绑定
    if (this.previewVideo && this.previewVideo.nativeElement) {
      try { this.previewVideo.nativeElement.srcObject = null; } catch (e) { /* ignore */ }
    }
    if (this.cameraVideo && this.cameraVideo.nativeElement) {
      try { this.cameraVideo.nativeElement.srcObject = null; } catch (e) { /* ignore */ }
    }
  }

  // 切换预览镜像
  togglePreviewMirror(): void {
    this.previewMirrored = !this.previewMirrored;
  }

  // 上传预览图片
  uploadPreviewImage(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    
    input.onchange = async (event: any) => {
      const file = event.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = async (e: any) => {
          this.uploadedPreviewImage = e.target.result;
          // 对上传的图片进行推理
          await this.predictFromUploadedImage(this.uploadedPreviewImage);
        };
        reader.readAsDataURL(file);
      }
    };
    
    input.click();
  }

  // 对上传的图片进行推理
  private async predictFromUploadedImage(imageDataUrl: string): Promise<void> {
    if (!this.trainedModel) {
      console.warn('模型未加载');
      return;
    }

    try {
      // 创建临时 Image 元素加载图片
      const img = new Image();
      img.onload = async () => {
        // 预测输出
        const logits = tf.tidy(() => {
          // 从图片元素创建张量
          let tensor = tf.browser.fromPixels(img);
          
          // 裁剪为正方形
          const size = Math.min(tensor.shape[0], tensor.shape[1]);
          const offsetY = (tensor.shape[0] - size) / 2;
          const offsetX = (tensor.shape[1] - size) / 2;
          tensor = tf.slice(tensor, [offsetY, offsetX, 0], [size, size, 3]);
          
          // 调整大小为 224x224
          tensor = tf.image.resizeBilinear(tensor, [224, 224]);
          
          // 归一化到 [-1, 1]
          tensor = tf.div(tensor, 127.5).sub(1.0);
          
          // 添加批次维度
          const batched = tensor.expandDims(0);
          
          // 直接预测（完整模型包含特征提取 + 分类）
          return this.trainedModel!.predict(batched) as tf.Tensor;
        });
        
        // 异步获取概率值（WebGPU 优化）
        const probs = await logits.data();
        logits.dispose();
        
        // 转换为百分比并映射到类别ID（使用训练时的标签顺序）
        const predictions: { [key: number]: number } = {};
        this.trainedClassLabels.forEach((labelName, index) => {
          // 通过标签名称找到对应的类别
          const classItem = this.classList.find(c => c.name === labelName);
          if (classItem && probs[index] !== undefined) {
            predictions[classItem.id] = Math.round(probs[index] * 100);
          }
        });
        
        // 更新预测结果
        this.realTimePredictions = predictions;
      };
      
      img.src = imageDataUrl;
    } catch (error) {
      console.error('图片推理错误:', error);
      this.message.error('图片推理失败');
    }
  }

  // 预览开关变化处理
  async onPreviewEnabledChange(enabled: boolean): Promise<void> {
    if (enabled) {
      // 启用预览
      if (this.previewInputSource === 'webcam') {
        await this.startPreview();
      }
    } else {
      // 禁用预览
      this.stopPreview();
      // 清空预测结果
      this.realTimePredictions = {};
    }
  }

  // 预览输入源变化处理
  async onPreviewSourceChange(source: string): Promise<void> {
    if (source === 'webcam' && this.previewEnabled) {
      // 切换到摄像头
      this.stopPreview();
      await this.startPreview();
    } else if (source !== 'webcam') {
      // 切换到其他输入源
      this.stopPreview();
      // 清空预测结果和上传的图片
      this.realTimePredictions = {};
      this.uploadedPreviewImage = null;
    }
  }

  // 开始实时推理
  private startRealTimeInference(): void {
    if (!this.trainedModel || !this.previewVideo) {
      return;
    }

    const inferenceLoop = async () => {
      if (!this.previewEnabled || !this.previewVideo || this.isInferencing) {
        return;
      }

      this.isInferencing = true;

      try {
        const video = this.previewVideo.nativeElement;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          // 从视频捕获图像并预处理
          const predictions = await this.predictFromVideo(video);
          
          // 更新预测结果
          this.realTimePredictions = predictions;
        }
      } catch (error) {
        console.error('推理错误:', error);
      }

      this.isInferencing = false;
      
      // 继续下一帧（约30fps）
      this.previewAnimationId = requestAnimationFrame(inferenceLoop);
    };

    inferenceLoop();
  }

  // 从视频预测
  private async predictFromVideo(video: HTMLVideoElement): Promise<{ [key: number]: number }> {
    if (!this.trainedModel) {
      return {};
    }

    // 预测输出
    const logits = tf.tidy(() => {
      // 捕获视频帧
      let img = tf.browser.fromPixels(video);
      
      // 裁剪为正方形
      const size = Math.min(img.shape[0], img.shape[1]);
      const offsetY = (img.shape[0] - size) / 2;
      const offsetX = (img.shape[1] - size) / 2;
      img = tf.slice(img, [offsetY, offsetX, 0], [size, size, 3]);
      
      // 调整大小为 224x224
      img = tf.image.resizeBilinear(img, [224, 224]);
      
      // 归一化到 [-1, 1]
      img = tf.div(img, 127.5).sub(1.0);
      
      // 添加批次维度
      const batched = img.expandDims(0);
      
      // 直接预测（完整模型包含特征提取 + 分类）
      return this.trainedModel!.predict(batched) as tf.Tensor;
    });
    
    // 异步获取概率值（WebGPU 优化）
    const probs = await logits.data();
    logits.dispose();
    
    // 转换为百分比并映射到类别ID（使用训练时的标签顺序）
    const predictions: { [key: number]: number } = {};
    this.trainedClassLabels.forEach((labelName, index) => {
      // 通过标签名称找到对应的类别
      const classItem = this.classList.find(c => c.name === labelName);
      if (classItem && probs[index] !== undefined) {
        predictions[classItem.id] = Math.round(probs[index] * 100);
      }
    });
    
    return predictions;
  }

  // 获取类别颜色（文本）
  getClassColor(index: number): string {
    return this.classColors[index % this.classColors.length].text;
  }

  // 获取类别进度条颜色
  getClassBarColor(index: number): string {
    return this.classColors[index % this.classColors.length].bar;
  }

  // 获取类别预测值（实时推理）
  getClassPrediction(classId: number): number {
    return this.realTimePredictions[classId] || 0;
  }

  // 导出模型
  async exportModel() {
    if (!this.trainedModelPath || !this.trainedModel) {
      this.message.error('没有可导出的模型');
      return;
    }

    try {
      // 显示加载消息
      const loadingMsg = this.message.loading('正在导出模型...', { nzDuration: 0 });

      // 1. 从 IndexedDB 加载模型
      const model = await tf.loadLayersModel(`indexeddb://${this.trainedModelPath}`);
      
      // 2. 创建保存处理器来捕获模型数据
      let modelTopology: any = null;
      let weightSpecs: any = null;
      let weightData: ArrayBuffer | ArrayBuffer[] | null = null;

      await model.save(tf.io.withSaveHandler(async (artifacts) => {
        modelTopology = artifacts.modelTopology;
        weightSpecs = artifacts.weightSpecs;
        weightData = artifacts.weightData;
        
        return {
          modelArtifactsInfo: {
            dateSaved: new Date(),
            modelTopologyType: 'JSON'
          }
        };
      }));

      // 3. 获取应用数据路径
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI || !electronAPI.path || !electronAPI.fs) {
        this.message.error('Electron API 不可用');
        this.message.remove(loadingMsg.messageId);
        return;
      }

      // 使用 appDataPath 存储模型文件
      const appDataPath = (window as any)['path'].getAppDataPath();
      if (!appDataPath) {
        this.message.error('无法获取应用数据路径');
        this.message.remove(loadingMsg.messageId);
        return;
      }

      // 4. 创建输出目录
      const outputDir = electronAPI.path.join(appDataPath, 'models', 'classification');
      if (!electronAPI.fs.existsSync(outputDir)) {
        electronAPI.fs.mkdirSync(outputDir, { recursive: true });
      }

      // 5. 保存 model.json
      const modelJSON = {
        modelTopology: modelTopology,
        weightsManifest: [{
          paths: ['weights.bin'],
          weights: weightSpecs
        }],
        format: 'tfjs-layers',
        generatedBy: 'Aily Blockly - Classification Trainer',
        convertedBy: null
      };

      const modelJSONPath = electronAPI.path.join(outputDir, 'model.json');
      electronAPI.fs.writeFileSync(
        modelJSONPath, 
        JSON.stringify(modelJSON, null, 2),
        'utf-8'
      );

      // 6. 保存权重文件
      const weightsPath = electronAPI.path.join(outputDir, 'weights.bin');
      // 处理权重数据（可能是ArrayBuffer或ArrayBuffer[]）
      let weightsUint8Array: Uint8Array;
      if (Array.isArray(weightData)) {
        // 如果是数组，合并所有ArrayBuffer
        const totalLength = weightData.reduce((sum, buf) => sum + buf.byteLength, 0);
        weightsUint8Array = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of weightData) {
          weightsUint8Array.set(new Uint8Array(buf), offset);
          offset += buf.byteLength;
        }
      } else {
        weightsUint8Array = new Uint8Array(weightData!);
      }
      // 使用 Uint8Array 写入文件（Electron fs 支持）
      electronAPI.fs.writeFileSync(weightsPath, weightsUint8Array);

      // 7. 保存标签文件 (labels.txt)
      const labelsPath = electronAPI.path.join(outputDir, 'labels.txt');
      electronAPI.fs.writeFileSync(
        labelsPath,
        this.trainedClassLabels.join('\n'),
        'utf-8'
      );

      // 8. 保存元数据
      const metadata = {
        name: 'Classification Model',
        type: 'image-classification',
        createdAt: new Date().toISOString(),
        classNames: this.trainedClassLabels,
        numClasses: this.trainedClassLabels.length,
        inputShape: [224, 224, 3],
        modelConfig: {
          mobileNetVersion: 1,
          mobileNetAlpha: 0.25,
          denseUnits: 128,
          epochs: this.trainConfig.epochs,
          learningRate: this.trainConfig.learningRate,
          batchSize: this.trainConfig.batchSize
        }
      };

      const metadataPath = electronAPI.path.join(outputDir, 'metadata.json');
      electronAPI.fs.writeFileSync(
        metadataPath,
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );

      this.message.remove(loadingMsg.messageId);
      this.message.success(`模型已导出到: ${outputDir}`);
      
    } catch (error: any) {
      console.error('导出模型失败:', error);
      this.message.error(`导出模型失败: ${error.message}`);
    }
  }

  // 部署模型
  deployModel() {
    this.router.navigate(['/model-deploy/sscma']);
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

  // 处理保存项目事件
  async handleSaveProject(data: { name: string; path: string }) {
    if (!this.electronService.isElectron) {
      this.message.error('保存功能仅在 Electron 环境下可用');
      return;
    }

    const loadingMsg = this.message.loading('正在保存项目...', { nzDuration: 0 });

    try {
      // 转换 classList 为 ClassificationClassData 格式
      const classesData = this.classList.map(c => ({
        name: c.name,
        enabled: c.enabled,
        samples: c.samples
      }));

      const options = {
        projectName: data.name,
        projectPath: data.path,
        modelType: 'classification' as const,
        trainConfig: {
          epochs: this.trainConfig.epochs,
          batchSize: this.trainConfig.batchSize,
          learningRate: this.trainConfig.learningRate
        },
        modelTrained: this.modelTrained
      };

      const result = await this.modelProjectService.saveClassificationProject(options, classesData);

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
    const loadingMsg = this.message.loading('正在更新项目...', { nzDuration: 0 });

    try {
      // 转换 classList 为 ClassificationClassData 格式
      const classesData = this.classList.map(c => ({
        name: c.name,
        enabled: c.enabled,
        samples: c.samples
      }));

      const options = {
        projectName: this.projectSaveName,
        projectPath: this.projectSavePath,
        modelType: 'classification' as const,
        trainConfig: {
          epochs: this.trainConfig.epochs,
          batchSize: this.trainConfig.batchSize,
          learningRate: this.trainConfig.learningRate
        },
        modelTrained: this.modelTrained
      };

      const result = await this.modelProjectService.updateClassificationProject(
        this.savedProjectFullPath,
        options,
        classesData
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

  // 返回
  close() {
    this.router.navigate(['/model-train/vision']);
  }
}
