import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ElectronService } from './electron.service';
import { PlatformService } from './platform.service';
import { ProjectService } from './project.service';
import { ConfigService } from './config.service';

// 模型类型定义
export type ModelType = 'classification' | 'detection' | 'segmentation' | 'pose';

// 最近打开的模型项目
export interface RecentModelProject {
  name: string;
  nickname?: string;
  path: string;
  modelType: ModelType;
  updatedAt?: string;
}

// 训练配置接口
export interface TrainConfig {
  epochs: number;
  batchSize: number;
  learningRate: number;
  [key: string]: any;
}

// 项目元数据接口
export interface ModelProjectMeta {
  name: string;
  nickname: string;
  url: string;
  description: string;
  modelType: ModelType;
  trainConfig: TrainConfig;
  createdAt: string;
  updatedAt?: string;
  modelTrained: boolean;
}

// 分类模型数据集
export interface ClassificationDataset {
  classes: string[];
  totalSamples: number;
}

// 分类模型类别数据
export interface ClassificationClassData {
  name: string;
  enabled: boolean;
  samples: string[]; // base64 图片数据
}

// 目标检测数据集
export interface DetectionDataset {
  labels: string[];
  totalImages: number;
  totalAnnotations: number;
}

// 目标检测标注数据
export interface DetectionAnnotation {
  imageUrl: string;
  boxes: {
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
  }[];
}

// 保存项目选项
export interface SaveProjectOptions {
  projectName: string;
  projectPath: string;
  modelType: ModelType;
  trainConfig: TrainConfig;
  modelTrained: boolean;
  description?: string;
}

// 保存项目结果
export interface SaveProjectResult {
  success: boolean;
  projectPath?: string;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ModelProjectService {

  constructor(
    private message: NzMessageService,
    private electronService: ElectronService,
    private platformService: PlatformService,
    private projectService: ProjectService,
    private configService: ConfigService
  ) { }

  // ==================== 最近项目管理 ====================

  /**
   * 获取最近打开的模型训练项目列表
   */
  get recentProjects(): RecentModelProject[] {
    return this.configService.data?.recentModelProjects || [];
  }

  /**
   * 设置最近打开的模型训练项目列表
   */
  set recentProjects(data: RecentModelProject[]) {
    this.configService.data.recentModelProjects = data;
    this.configService.save();
  }

  /**
   * 添加最近打开的项目
   */
  addRecentProject(project: RecentModelProject) {
    let temp: RecentModelProject[] = [...this.recentProjects];
    // 添加到开头
    temp.unshift(project);
    // 去重（根据路径）
    temp = temp.filter((item, index) => {
      return temp.findIndex((item2) => item2.path === item.path) === index;
    });
    // 最多保留6个
    if (temp.length > 6) {
      temp.pop();
    }
    this.recentProjects = temp;
  }

  /**
   * 移除最近打开的项目
   */
  removeRecentProject(path: string) {
    let temp: RecentModelProject[] = this.recentProjects.filter(item => item.path !== path);
    this.recentProjects = temp;
  }

  // ==================== 路径和名称管理 ====================

  /**
   * 获取默认保存路径
   */
  getDefaultSavePath(): string {
    if (this.electronService.isElectron) {
      const pt = this.platformService.getPlatformSeparator();
      return window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    }
    return '';
  }

  /**
   * 生成唯一的项目名称
   */
  generateProjectName(basePath: string, prefix: string): string {
    return this.projectService.generateUniqueProjectName(basePath, prefix);
  }

  /**
   * 选择保存路径
   */
  async selectSavePath(currentPath: string): Promise<string | null> {
    if (!this.electronService.isElectron) {
      console.warn('文件选择功能仅在 Electron 环境下可用');
      return null;
    }

    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: currentPath,
    });

    if (folderPath) {
      const pt = this.platformService.getPlatformSeparator();
      if (folderPath.slice(-1) !== pt) {
        return folderPath + pt;
      }
      return folderPath;
    }
    return null;
  }

  /**
   * 检查项目是否存在
   */
  checkProjectExists(projectPath: string, projectName: string): boolean {
    if (!this.electronService.isElectron) {
      return false;
    }
    const electronAPI = (window as any).electronAPI;
    const fullPath = electronAPI.path.join(projectPath, projectName);
    return electronAPI.fs.existsSync(fullPath);
  }

  /**
   * 保存分类识别项目
   */
  async saveClassificationProject(
    options: SaveProjectOptions,
    classList: ClassificationClassData[]
  ): Promise<SaveProjectResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: '保存功能仅在 Electron 环境下可用' };
    }

    try {
      const electronAPI = (window as any).electronAPI;
      const projectPath = electronAPI.path.join(options.projectPath, options.projectName);

      // 检查目录是否存在
      if (electronAPI.fs.existsSync(projectPath)) {
        return { success: false, error: '项目已存在，请使用不同的名称' };
      }

      // 创建项目目录结构
      electronAPI.fs.mkdirSync(projectPath, { recursive: true });
      const datasetsPath = electronAPI.path.join(projectPath, 'datasets');
      const modelPath = electronAPI.path.join(projectPath, 'model');
      electronAPI.fs.mkdirSync(datasetsPath, { recursive: true });
      electronAPI.fs.mkdirSync(modelPath, { recursive: true });

      // 1. 生成 package.json
      const packageData: ModelProjectMeta = {
        name: options.projectName,
        nickname: options.projectName,
        url: '',
        description: options.description || `分类识别模型训练项目 - ${classList.length}个类别`,
        modelType: 'classification',
        trainConfig: options.trainConfig,
        createdAt: new Date().toISOString(),
        modelTrained: options.modelTrained
      };

      const packageJsonPath = electronAPI.path.join(projectPath, 'package.json');
      electronAPI.fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(packageData, null, 2),
        'utf-8'
      );

      // 2. 保存数据集
      const classNames = classList.map(c => c.name);
      const dataJson: ClassificationDataset = {
        classes: classNames,
        totalSamples: classList.reduce((sum, c) => sum + c.samples.length, 0)
      };

      const dataJsonPath = electronAPI.path.join(datasetsPath, 'data.json');
      electronAPI.fs.writeFileSync(
        dataJsonPath,
        JSON.stringify(dataJson, null, 2),
        'utf-8'
      );

      // 3. 保存每个类别的图片
      for (const classItem of classList) {
        const classDir = electronAPI.path.join(datasetsPath, classItem.name);
        electronAPI.fs.mkdirSync(classDir, { recursive: true });

        for (let i = 0; i < classItem.samples.length; i++) {
          const imageData = classItem.samples[i];
          const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
          const imagePath = electronAPI.path.join(classDir, `image_${i.toString().padStart(4, '0')}.jpg`);
          electronAPI.fs.writeBase64File(imagePath, base64Data);
        }
      }

      // 添加到最近项目
      this.addRecentProject({
        name: options.projectName,
        path: projectPath,
        modelType: 'classification',
        updatedAt: new Date().toISOString()
      });

      return { success: true, projectPath };

    } catch (error: any) {
      console.error('保存项目失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新分类识别项目
   */
  async updateClassificationProject(
    projectFullPath: string,
    options: SaveProjectOptions,
    classList: ClassificationClassData[]
  ): Promise<SaveProjectResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: '保存功能仅在 Electron 环境下可用' };
    }

    try {
      const electronAPI = (window as any).electronAPI;
      const datasetsPath = electronAPI.path.join(projectFullPath, 'datasets');

      // 1. 更新 package.json
      const packageData: ModelProjectMeta = {
        name: options.projectName,
        nickname: options.projectName,
        url: '',
        description: options.description || `分类识别模型训练项目 - ${classList.length}个类别`,
        modelType: 'classification',
        trainConfig: options.trainConfig,
        createdAt: new Date().toISOString(),
        modelTrained: options.modelTrained,
        updatedAt: new Date().toISOString()
      };

      const packageJsonPath = electronAPI.path.join(projectFullPath, 'package.json');
      electronAPI.fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(packageData, null, 2),
        'utf-8'
      );

      // 2. 清空并重新创建 datasets 目录
      if (electronAPI.fs.existsSync(datasetsPath)) {
        electronAPI.fs.rmSync(datasetsPath, { recursive: true, force: true });
      }
      electronAPI.fs.mkdirSync(datasetsPath, { recursive: true });

      // 3. 保存数据集
      const classNames = classList.map(c => c.name);
      const dataJson: ClassificationDataset = {
        classes: classNames,
        totalSamples: classList.reduce((sum, c) => sum + c.samples.length, 0)
      };

      const dataJsonPath = electronAPI.path.join(datasetsPath, 'labels.json');
      electronAPI.fs.writeFileSync(
        dataJsonPath,
        JSON.stringify(dataJson, null, 2),
        'utf-8'
      );

      // 4. 保存每个类别的图片
      for (const classItem of classList) {
        const classDir = electronAPI.path.join(datasetsPath, classItem.name);
        electronAPI.fs.mkdirSync(classDir, { recursive: true });

        for (let i = 0; i < classItem.samples.length; i++) {
          const imageData = classItem.samples[i];
          const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
          const imagePath = electronAPI.path.join(classDir, `image_${i.toString().padStart(4, '0')}.jpg`);
          electronAPI.fs.writeBase64File(imagePath, base64Data);
        }
      }

      return { success: true, projectPath: projectFullPath };

    } catch (error: any) {
      console.error('更新项目失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 保存目标检测项目
   */
  async saveDetectionProject(
    options: SaveProjectOptions,
    labels: string[],
    images: string[],
    annotations: Map<number, any[]>
  ): Promise<SaveProjectResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: '保存功能仅在 Electron 环境下可用' };
    }

    try {
      const electronAPI = (window as any).electronAPI;
      const projectPath = electronAPI.path.join(options.projectPath, options.projectName);

      // 检查目录是否存在
      if (electronAPI.fs.existsSync(projectPath)) {
        return { success: false, error: '项目已存在，请使用不同的名称' };
      }

      // 创建项目目录结构
      electronAPI.fs.mkdirSync(projectPath, { recursive: true });
      const datasetsPath = electronAPI.path.join(projectPath, 'datasets');
      const imagesPath = electronAPI.path.join(datasetsPath, 'images');
      const modelPath = electronAPI.path.join(projectPath, 'model');
      electronAPI.fs.mkdirSync(datasetsPath, { recursive: true });
      electronAPI.fs.mkdirSync(imagesPath, { recursive: true });
      electronAPI.fs.mkdirSync(modelPath, { recursive: true });

      // 1. 生成 package.json
      const packageData: ModelProjectMeta = {
        name: options.projectName,
        nickname: options.projectName,
        url: '',
        description: options.description || `目标检测模型训练项目 - ${labels.length}个标签`,
        modelType: 'detection',
        trainConfig: options.trainConfig,
        createdAt: new Date().toISOString(),
        modelTrained: options.modelTrained
      };

      const packageJsonPath = electronAPI.path.join(projectPath, 'package.json');
      electronAPI.fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(packageData, null, 2),
        'utf-8'
      );

      // 2. 保存数据集元数据
      let totalAnnotations = 0;
      annotations.forEach(boxes => {
        totalAnnotations += boxes.length;
      });

      const dataJson: DetectionDataset = {
        labels: labels,
        totalImages: images.length,
        totalAnnotations: totalAnnotations
      };

      const labelJsonPath = electronAPI.path.join(datasetsPath, 'labels.json');
      electronAPI.fs.writeFileSync(
        labelJsonPath,
        JSON.stringify(dataJson, null, 2),
        'utf-8'
      );

      // 3. 保存图片和标注
      const annotationsData: any[] = [];
      
      for (let i = 0; i < images.length; i++) {
        const imageData = images[i];
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const imageName = `image_${i.toString().padStart(4, '0')}.jpg`;
        const imagePath = electronAPI.path.join(imagesPath, imageName);
        electronAPI.fs.writeBase64File(imagePath, base64Data);

        // 保存标注数据
        const boxes = annotations.get(i) || [];
        annotationsData.push({
          image: imageName,
          boxes: boxes
        });
      }

      // 4. 保存标注文件
      const annotationsPath = electronAPI.path.join(datasetsPath, 'annotations.json');
      electronAPI.fs.writeFileSync(
        annotationsPath,
        JSON.stringify(annotationsData, null, 2),
        'utf-8'
      );

      // 添加到最近项目
      this.addRecentProject({
        name: options.projectName,
        path: projectPath,
        modelType: 'detection',
        updatedAt: new Date().toISOString()
      });

      return { success: true, projectPath };

    } catch (error: any) {
      console.error('保存项目失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新目标检测项目
   */
  async updateDetectionProject(
    projectFullPath: string,
    options: SaveProjectOptions,
    labels: string[],
    images: string[],
    annotations: Map<number, any[]>
  ): Promise<SaveProjectResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: '保存功能仅在 Electron 环境下可用' };
    }

    try {
      const electronAPI = (window as any).electronAPI;
      const datasetsPath = electronAPI.path.join(projectFullPath, 'datasets');
      const imagesPath = electronAPI.path.join(datasetsPath, 'images');

      // 1. 更新 package.json
      const packageData: ModelProjectMeta = {
        name: options.projectName,
        nickname: options.projectName,
        url: '',
        description: options.description || `目标检测模型训练项目 - ${labels.length}个标签`,
        modelType: 'detection',
        trainConfig: options.trainConfig,
        createdAt: new Date().toISOString(),
        modelTrained: options.modelTrained,
        updatedAt: new Date().toISOString()
      };

      const packageJsonPath = electronAPI.path.join(projectFullPath, 'package.json');
      electronAPI.fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(packageData, null, 2),
        'utf-8'
      );

      // 2. 清空并重新创建 datasets 目录
      if (electronAPI.fs.existsSync(datasetsPath)) {
        electronAPI.fs.rmSync(datasetsPath, { recursive: true, force: true });
      }
      electronAPI.fs.mkdirSync(datasetsPath, { recursive: true });
      electronAPI.fs.mkdirSync(imagesPath, { recursive: true });

      // 3. 保存数据集元数据
      let totalAnnotations = 0;
      annotations.forEach(boxes => {
        totalAnnotations += boxes.length;
      });

      const dataJson: DetectionDataset = {
        labels: labels,
        totalImages: images.length,
        totalAnnotations: totalAnnotations
      };

      const labelJsonPath = electronAPI.path.join(datasetsPath, 'labels.json');
      electronAPI.fs.writeFileSync(
        labelJsonPath,
        JSON.stringify(dataJson, null, 2),
        'utf-8'
      );

      // 4. 保存图片和标注
      const annotationsData: any[] = [];
      
      for (let i = 0; i < images.length; i++) {
        const imageData = images[i];
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const imageName = `image_${i.toString().padStart(4, '0')}.jpg`;
        const imagePath = electronAPI.path.join(imagesPath, imageName);
        electronAPI.fs.writeBase64File(imagePath, base64Data);

        const boxes = annotations.get(i) || [];
        annotationsData.push({
          image: imageName,
          boxes: boxes
        });
      }

      // 5. 保存标注文件
      const annotationsPath = electronAPI.path.join(datasetsPath, 'annotations.json');
      electronAPI.fs.writeFileSync(
        annotationsPath,
        JSON.stringify(annotationsData, null, 2),
        'utf-8'
      );

      return { success: true, projectPath: projectFullPath };

    } catch (error: any) {
      console.error('更新项目失败:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== 加载项目相关方法 ====================

  /**
   * 加载项目结果接口
   */
  

  /**
   * 选择并打开项目文件夹
   */
  async selectProjectFolder(): Promise<string | null> {
    if (!this.electronService.isElectron) {
      console.warn('文件选择功能仅在 Electron 环境下可用');
      return null;
    }

    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: this.getDefaultSavePath(),
    });

    return folderPath || null;
  }

  /**
   * 读取项目元数据
   */
  loadProjectMeta(projectPath: string): ModelProjectMeta | null {
    if (!this.electronService.isElectron) {
      return null;
    }

    try {
      const electronAPI = (window as any).electronAPI;
      const packageJsonPath = electronAPI.path.join(projectPath, 'package.json');
      
      if (!electronAPI.fs.existsSync(packageJsonPath)) {
        return null;
      }

      const content = electronAPI.fs.readFileSync(packageJsonPath, 'utf-8');
      return JSON.parse(content) as ModelProjectMeta;
    } catch (error) {
      console.error('读取项目元数据失败:', error);
      return null;
    }
  }

  /**
   * 加载分类识别项目数据
   */
  loadClassificationProject(projectPath: string): { 
    meta: ModelProjectMeta; 
    classes: ClassificationClassData[];
  } | null {
    if (!this.electronService.isElectron) {
      return null;
    }

    try {
      const electronAPI = (window as any).electronAPI;
      
      // 读取 package.json
      const meta = this.loadProjectMeta(projectPath);
      if (!meta) {
        return null;
      }

      // 读取 datasets/labels.json
      const datasetsPath = electronAPI.path.join(projectPath, 'datasets');
      const labelJsonPath = electronAPI.path.join(datasetsPath, 'labels.json');
      
      if (!electronAPI.fs.existsSync(labelJsonPath)) {
        return null;
      }

      const dataContent = electronAPI.fs.readFileSync(labelJsonPath, 'utf-8');
      const dataJson: ClassificationDataset = JSON.parse(dataContent);

      // 加载每个类别的图片
      const classes: ClassificationClassData[] = [];
      
      for (const className of dataJson.classes) {
        const classDir = electronAPI.path.join(datasetsPath, className);
        const samples: string[] = [];

        if (electronAPI.fs.existsSync(classDir)) {
          const files = electronAPI.fs.readdirSync(classDir);
          
          for (const file of files) {
            if (file.endsWith('.jpg') || file.endsWith('.png') || file.endsWith('.jpeg')) {
              const imagePath = electronAPI.path.join(classDir, file);
              const base64 = electronAPI.fs.readFileAsBase64(imagePath);
              const ext = file.split('.').pop()?.toLowerCase() || 'jpg';
              const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
              samples.push(`data:${mimeType};base64,${base64}`);
            }
          }
        }

        classes.push({
          name: className,
          enabled: true,
          samples: samples
        });
      }

      return { meta, classes };

    } catch (error) {
      console.error('加载分类项目失败:', error);
      return null;
    }
  }

  /**
   * 加载目标检测项目数据
   */
  loadDetectionProject(projectPath: string): {
    meta: ModelProjectMeta;
    labels: string[];
    images: string[];
    annotations: { image: string; boxes: any[] }[];
  } | null {
    if (!this.electronService.isElectron) {
      return null;
    }

    try {
      const electronAPI = (window as any).electronAPI;
      
      // 读取 package.json
      const meta = this.loadProjectMeta(projectPath);
      if (!meta) {
        return null;
      }

      // 读取 datasets/labels.json
      const datasetsPath = electronAPI.path.join(projectPath, 'datasets');
      const labelJsonPath = electronAPI.path.join(datasetsPath, 'labels.json');
      
      if (!electronAPI.fs.existsSync(labelJsonPath)) {
        return null;
      }

      const dataContent = electronAPI.fs.readFileSync(labelJsonPath, 'utf-8');
      const dataJson: DetectionDataset = JSON.parse(dataContent);

      // 读取标注文件
      const annotationsPath = electronAPI.path.join(datasetsPath, 'annotations.json');
      let annotationsData: { image: string; boxes: any[] }[] = [];
      
      if (electronAPI.fs.existsSync(annotationsPath)) {
        const annotationsContent = electronAPI.fs.readFileSync(annotationsPath, 'utf-8');
        annotationsData = JSON.parse(annotationsContent);
      }

      // 加载图片
      const imagesPath = electronAPI.path.join(datasetsPath, 'images');
      const images: string[] = [];

      if (electronAPI.fs.existsSync(imagesPath)) {
        const files = electronAPI.fs.readdirSync(imagesPath);
        
        // 按文件名排序以保持顺序
        files.sort();
        
        for (const file of files) {
          if (file.endsWith('.jpg') || file.endsWith('.png') || file.endsWith('.jpeg')) {
            const imagePath = electronAPI.path.join(imagesPath, file);
            const base64 = electronAPI.fs.readFileAsBase64(imagePath);
            const ext = file.split('.').pop()?.toLowerCase() || 'jpg';
            const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
            images.push(`data:${mimeType};base64,${base64}`);
          }
        }
      }

      return { 
        meta, 
        labels: dataJson.labels, 
        images, 
        annotations: annotationsData 
      };

    } catch (error) {
      console.error('加载检测项目失败:', error);
      return null;
    }
  }
}
