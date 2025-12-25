/**
 * 模型训练服务
 * 使用 Web Worker + TensorFlow.js 浏览器版本
 * 支持 WebGL/WebGPU 加速，避免阻塞 UI
 */
import { Injectable, OnDestroy } from '@angular/core';
import { Subject, BehaviorSubject } from 'rxjs';

// 训练配置接口
export interface TrainConfig {
  epochs: number;
  batchSize: number;
  learningRate: number;
  imageSize?: number;
}

// 类别数据接口
export interface ClassData {
  name: string;
  images: string[]; // base64 图片数据
}

// 训练进度接口
export interface TrainProgress {
  status: 'preparing' | 'loading' | 'training' | 'saving' | 'completed' | 'error';
  epoch?: number;
  totalEpochs?: number;
  loss?: number;
  accuracy?: number;
  valLoss?: number;
  valAccuracy?: number;
  message?: string;
}

// 训练结果接口
export interface TrainResult {
  success: boolean;
  modelName?: string;
  metadata?: any;
  classes?: string[];
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ModelTrainService implements OnDestroy {
  // 训练进度流
  private progressSubject = new Subject<TrainProgress>();
  progress$ = this.progressSubject.asObservable();

  // 训练状态
  private isTrainingSubject = new BehaviorSubject<boolean>(false);
  isTraining$ = this.isTrainingSubject.asObservable();

  // Web Worker 实例
  private worker: Worker | null = null;

  constructor() {
    this.initWorker();
  }

  ngOnDestroy() {
    this.terminateWorker();
  }

  /**
   * 初始化 Worker
   */
  private initWorker(): void {
    try {
      // 创建 Worker
      this.worker = new Worker(
        new URL('../workers/model-train.worker.ts', import.meta.url),
        { type: 'module' }
      );

      // 监听 Worker 消息
      this.worker.addEventListener('message', (event) => {
        this.handleWorkerMessage(event.data);
      });

      // 监听 Worker 错误
      this.worker.addEventListener('error', (error) => {
        console.error('Worker 错误:', error);
        this.progressSubject.next({
          status: 'error',
          message: error.message || 'Worker 发生错误'
        });
        this.isTrainingSubject.next(false);
      });

    } catch (error: any) {
      console.error('初始化 Worker 失败:', error);
    }
  }

  /**
   * 终止 Worker
   */
  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * 处理 Worker 消息
   */
  private handleWorkerMessage(message: any): void {
    const { type, data } = message;

    switch (type) {
      case 'ready':
        console.log('Worker 已就绪');
        break;

      case 'progress':
        this.progressSubject.next(data);
        break;

      case 'completed':
        this.isTrainingSubject.next(false);
        this.progressSubject.next({
          status: 'completed',
          message: '训练完成！'
        });
        // 存储结果供后续使用
        this.currentTrainResult = {
          success: true,
          ...data
        };
        break;

      case 'error':
        this.isTrainingSubject.next(false);
        this.progressSubject.next({
          status: 'error',
          message: data.message || '训练失败'
        });
        this.currentTrainResult = {
          success: false,
          error: data.message
        };
        break;
    }
  }

  // 当前训练结果
  private currentTrainResult: TrainResult | null = null;

  /**
   * 开始训练
   */
  async startTraining(
    classes: ClassData[],
    config: TrainConfig
  ): Promise<TrainResult> {
    if (this.isTrainingSubject.value) {
      return { success: false, error: '训练已在进行中' };
    }

    // 验证数据
    if (classes.length < 2) {
      return { success: false, error: '至少需要 2 个类别进行训练' };
    }

    const hasEmptyClass = classes.some(c => c.images.length === 0);
    if (hasEmptyClass) {
      return { success: false, error: '每个类别至少需要 1 张图片' };
    }

    // 检查 Worker 是否可用
    if (!this.worker) {
      this.initWorker();
      if (!this.worker) {
        return { success: false, error: 'Worker 初始化失败' };
      }
    }

    this.isTrainingSubject.next(true);
    this.currentTrainResult = null;
    this.progressSubject.next({ status: 'preparing', message: '准备训练数据...' });

    // 发送训练消息到 Worker
    this.worker.postMessage({
      type: 'start',
      data: {
        classes,
        config
      }
    });

    // 返回 Promise，等待训练完成
    return new Promise((resolve) => {
      // 轮询检查结果
      const checkInterval = setInterval(() => {
        if (this.currentTrainResult !== null) {
          clearInterval(checkInterval);
          resolve(this.currentTrainResult);
          this.currentTrainResult = null;
        }
      }, 100);

      // 超时保护（2小时）
      setTimeout(() => {
        clearInterval(checkInterval);
        if (this.currentTrainResult === null) {
          resolve({ success: false, error: '训练超时' });
        }
      }, 2 * 60 * 60 * 1000);
    });
  }

  /**
   * 停止训练
   */
  async stopTraining(): Promise<void> {
    if (this.worker && this.isTrainingSubject.value) {
      this.worker.postMessage({ type: 'stop' });
      this.progressSubject.next({ status: 'error', message: '正在取消训练...' });
    }
  }

  /**
   * 从 IndexedDB 加载模型
   */
  async loadModel(modelName: string): Promise<any> {
    try {
      const tf = await import('@tensorflow/tfjs');
      const model = await tf.loadLayersModel(`indexeddb://${modelName}`);
      return model;
    } catch (error: any) {
      console.error('加载模型失败:', error);
      throw new Error(`加载模型失败: ${error.message}`);
    }
  }

  /**
   * 列出所有训练的模型
   */
  async listModels(): Promise<string[]> {
    try {
      const tf = await import('@tensorflow/tfjs');
      const models = await tf.io.listModels();
      return Object.keys(models).filter(key => key.startsWith('indexeddb://'));
    } catch (error: any) {
      console.error('列出模型失败:', error);
      return [];
    }
  }

  /**
   * 删除模型
   */
  async deleteModel(modelName: string): Promise<boolean> {
    try {
      const tf = await import('@tensorflow/tfjs');
      await tf.io.removeModel(`indexeddb://${modelName}`);
      return true;
    } catch (error: any) {
      console.error('删除模型失败:', error);
      return false;
    }
  }

  /**
   * 导出模型为文件
   */
  async exportModel(modelName: string): Promise<Blob> {
    try {
      const tf = await import('@tensorflow/tfjs');
      const model = await tf.loadLayersModel(`indexeddb://${modelName}`);
      
      // 保存到内存
      const saveResult = await model.save(tf.io.withSaveHandler(async (artifacts) => {
        return {
          modelArtifactsInfo: {
            dateSaved: new Date(),
            modelTopologyType: 'JSON'
          }
        };
      }));
      
      // 创建 zip 文件（需要额外的库，这里简化处理）
      const modelJSON = JSON.stringify(saveResult);
      return new Blob([modelJSON], { type: 'application/json' });
      
    } catch (error: any) {
      console.error('导出模型失败:', error);
      throw new Error(`导出模型失败: ${error.message}`);
    }
  }

  /**
   * 获取当前训练状态
   */
  get isTraining(): boolean {
    return this.isTrainingSubject.value;
  }
}
