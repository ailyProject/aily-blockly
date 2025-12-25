/**
 * 模型商店常量和映射配置
 */

export interface SupportBoardInfo {
  board: string;
  url: string;
}

// 开发板类型映射
export const BOARD_INFOS: Record<string, SupportBoardInfo> = {
  '26': {
    board:'reComputer Jetson',
    url:'https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html'
  },
  '32': {
    board:'XIAO ESP32S3 Sense',
    url:'https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html'
  },
  '36': {
    board:'Grove - Vision AI V2',
    url:'https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html'
  },
  '37': {
    board:'SenseCAP Watcher',
    url:'https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html'
  },
  '40': {
    board:'reCamera',
    url:'https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html'
  },
  '41': {
    board:'SenseCAP A1102',
    url:'https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html'
  },
  '60': {
    board:'Easy code ASR module',
    url:''
  }
};

// adapteds 到 uniform_type 的映射
export const ADAPTEDS_TO_UNIFORM_TYPE: Record<string, string> = {
  '1': '26',
  '9': '26',
  '7': '32',
  '11': '36',
  '12': '37',
  '13': '40',
  '14': '41',
  '20': '60'
};

// 任务类型映射
export const TASK_TYPES: Record<string, string> = {
  '1': '目标检测',
  '2': '分类检测',
  '3': '图像分割',
  '4': '姿态检测',
  '5': '生成式模型',
  '6': '音频识别'
};

// 模型精度映射
export const PRECISION_TYPES: Record<string, string> = {
  '1': 'INT8'
};

// 模型格式映射
export const MODEL_FORMATS: Record<string, string> = {
  '2': 'TF Lite'
};

// 作者 Logo 映射
export const AUTHOR_LOGOS: Record<string, string> = {
  'SenseCraft AI': 'sponsor/seeedstudio/logo_l.webp',
  'ChipIntelli': 'sponsor/seeedstudio/logo_l.webp' // 可以替换为其他 logo 路径
};

// 设备连接图片映射（根据 uniform_type）
export const DEVICE_CONNECTION_IMAGES: Record<string, string> = {
  '32': 'model/xiao.webp', // XIAO ESP32S3 Sense
  '36': 'model/xiao.webp', // Grove - Vision AI V2
  '37': 'model/xiao.webp', // SenseCAP Watcher
  '40': 'model/xiao.webp', // reCamera
  '41': 'model/xiao.webp'  // SenseCAP A1102
};

export const DEVICE_CONNECTION_STEPS: Record<string, string[]> = {
  '32': [
    'XIAO_ESP32S3_SENSE_CONNECT.STEP1',
    'XIAO_ESP32S3_SENSE_CONNECT.STEP2',
    'XIAO_ESP32S3_SENSE_CONNECT.STEP3',
    'XIAO_ESP32S3_SENSE_CONNECT.STEP4'
  ],
  // 可以为其他设备类型添加连接步骤
};

// 根据作者名称获取部署步骤配置
export interface DeployStepConfig {
  steps: string[];  // 步骤翻译key数组
  order: 'select-deploy-configure' | 'select-configure-deploy';
}

export const DEPLOY_STEP_CONFIGS: Record<string, DeployStepConfig> = {
  'SenseCraft AI': {
    steps: [
      // 'MODEL_DEPLOY.STEPS.SELECT',
      'MODEL_DEPLOY.STEPS.DEPLOY',
      'MODEL_DEPLOY.STEPS.CONFIGURE'
    ],
    order: 'select-deploy-configure',
  },
  'ChipIntelli': {
    steps: [
      // 'MODEL_DEPLOY.STEPS.SELECT',
      'MODEL_DEPLOY.STEPS.CONFIGURE',
      'MODEL_DEPLOY.STEPS.DEPLOY'
    ],
    order: 'select-configure-deploy'
  }
};

// 默认步骤配置（如果作者名称不在配置中）
export const DEFAULT_DEPLOY_STEPS: DeployStepConfig = {
  steps: [
    'MODEL_DEPLOY.STEPS.SELECT',
    'MODEL_DEPLOY.STEPS.DEPLOY',
    'MODEL_DEPLOY.STEPS.CONFIGURE'
  ],
  order: 'select-deploy-configure'
};

export const DEPLOY_TITLE: Record<string, string> = {
  'SenseCraft AI': 'SenseCraft AI',
  'ChipIntelli': 'ChipIntelli AI'
};

/**
 * 根据 uniform_types 获取支持的开发板列表
 */
export function getSupportedBoards(uniformTypes: string[]): SupportBoardInfo[] {
  const boards: SupportBoardInfo[] = [];
  if (!uniformTypes || uniformTypes.length === 0) return boards;
  for (const type of uniformTypes) {
    const boardInfo = BOARD_INFOS[type];
    if (boardInfo) {
      boards.push(boardInfo);
    }
  }
  return boards;
}

/**
 * 获取任务类型描述
 */
export function getTaskDescription(task: string): string {
  return TASK_TYPES[task] || '未知类型';
}

/**
 * 获取模型格式描述
 */
export function getModelFormatDescription(format: string): string {
  return MODEL_FORMATS[format] || '未知格式';
}

/**
 * 获取精度描述
 */
export function getPrecisionDescription(precision: string): string {
  return PRECISION_TYPES[precision] || '未知精度';
}

/**
 * 获取部署步骤配置
 */
export function getDeployStepConfig(authorName: string): DeployStepConfig {
  return DEPLOY_STEP_CONFIGS[authorName] || DEFAULT_DEPLOY_STEPS;
}

export function getDeployTitle(authorName: string): string | null {
  return DEPLOY_TITLE[authorName] || 'AI Model Store';
}

/**
 * 获取作者 Logo
 */
export function getAuthorLogo(authorName: string): string | null {
  return AUTHOR_LOGOS[authorName] || null;
}

/**
 * 获取设备连接图片（根据 uniform_types 数组）
 */
export function getDeviceConnectionImage(uniformTypes: string[]): string | null {
  if (!uniformTypes || uniformTypes.length === 0) return null;
  // 返回第一个匹配的图片
  for (const type of uniformTypes) {
    if (DEVICE_CONNECTION_IMAGES[type]) {
      return DEVICE_CONNECTION_IMAGES[type];
    }
  }
  return null;
}

export function getDeviceConnectionSteps(uniformTypes: string[]): string[] | null {
  if (!uniformTypes || uniformTypes.length === 0) return null;
  // 返回第一个匹配的连接步骤
  for (const type of uniformTypes) {
    if (DEVICE_CONNECTION_STEPS[type]) {
      return DEVICE_CONNECTION_STEPS[type];
    }
  }
  return null;
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: string | number): string {
  const size = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  
  if (isNaN(size)) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let fileSize = size;
  
  while (fileSize >= 1024 && unitIndex < units.length - 1) {
    fileSize /= 1024;
    unitIndex++;
  }
  
  return `${fileSize.toFixed(2)} ${units[unitIndex]}`;
}
