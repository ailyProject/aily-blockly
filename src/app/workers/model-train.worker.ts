/**
 * 模型训练 Web Worker
 * 使用 TensorFlow.js 浏览器版本（WebGL/WebGPU 加速）
 * 在独立线程中训练，避免阻塞 UI
 */

import * as tf from '@tensorflow/tfjs';

// 训练配置接口
interface TrainConfig {
  epochs: number;
  batchSize: number;
  learningRate: number;
  imageSize?: number;
}

// 类别数据接口
interface ClassData {
  name: string;
  images: string[]; // base64 图片数据
}

// Worker 消息类型
interface WorkerMessage {
  type: 'start' | 'stop';
  data?: {
    classes: ClassData[];
    config: TrainConfig;
  };
}

interface WorkerResponse {
  type: 'progress' | 'completed' | 'error';
  data?: any;
}

// 训练配置
const CONFIG = {
  imageSize: 224,
  mobileNetVersion: 1,
  mobileNetAlpha: 0.25,
  denseUnits: 128,
  dropoutRate: 0.2,
  validationSplit: 0.2,
  useDataAugmentation: true
};

// MobileNet URL
const MOBILENET_URL = `https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v${CONFIG.mobileNetVersion}_${CONFIG.mobileNetAlpha.toFixed(2)}_${CONFIG.imageSize}/model.json`;
const TRUNCATION_LAYER = 'conv_pw_13_relu';

// 当前训练状态
let isTraining = false;
let shouldStop = false;

/**
 * 初始化最佳后端
 */
async function initBestBackend(): Promise<string> {
  try {
    // 1. 尝试 WebGPU（最快）
    if ('gpu' in navigator) {
      try {
        await import('@tensorflow/tfjs-backend-webgpu');
        await tf.setBackend('webgpu');
        await tf.ready();
        return 'webgpu';
      } catch (error) {
        console.warn('WebGPU 不可用，回退到 WebGL');
      }
    }

    // 2. 回退到 WebGL
    await tf.setBackend('webgl');
    await tf.ready();
    
    // 设置 WebGL 标志以提高性能
    tf.env().set('WEBGL_PACK', true);
    tf.env().set('WEBGL_FORCE_F16_TEXTURES', true);
    
    return 'webgl';
  } catch (error) {
    // 最终回退到 CPU
    await tf.setBackend('cpu');
    await tf.ready();
    return 'cpu';
  }
}

/**
 * 发送进度消息
 */
function sendProgress(status: string, data?: any) {
  const message: WorkerResponse = {
    type: 'progress',
    data: {
      status,
      ...data
    }
  };
  self.postMessage(message);
}

/**
 * 加载并预处理图像
 * Worker 中使用 createImageBitmap API
 */
async function loadImage(base64Data: string): Promise<tf.Tensor3D> {
  try {
    // 将 base64 转换为 Blob
    const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    
    // 使用 createImageBitmap（Worker 中可用）
    const imageBitmap = await createImageBitmap(blob);
    
    // 创建 tensor 并预处理
    const tensor = tf.browser.fromPixels(imageBitmap);
    
    // 调整大小到 224x224
    let resized = tf.image.resizeBilinear(tensor, [CONFIG.imageSize, CONFIG.imageSize]) as tf.Tensor3D;
    
    // 归一化到 [-1, 1]
    resized = resized.div(127.5).sub(1) as tf.Tensor3D;
    
    // 释放原始 tensor
    tensor.dispose();
    imageBitmap.close();
    
    return resized;
  } catch (error) {
    throw new Error('图片加载失败: ' + (error as Error).message);
  }
}

/**
 * 数据增强
 */
function augmentImage(image: tf.Tensor3D): tf.Tensor3D {
  return tf.tidy(() => {
    let augmented = image;
    
    // 随机水平翻转
    if (Math.random() > 0.5) {
      const batched = augmented.expandDims(0) as tf.Tensor4D;
      const flipped = tf.image.flipLeftRight(batched);
      augmented = flipped.squeeze([0]) as tf.Tensor3D;
    }
    
    // 随机亮度调整 (±10%)
    const brightnessOffset = (Math.random() - 0.5) * 0.2;
    augmented = augmented.add(brightnessOffset).clipByValue(-1, 1) as tf.Tensor3D;
    
    return augmented;
  });
}

/**
 * 加载数据集
 */
async function loadDataset(classes: ClassData[]): Promise<{
  xs: tf.Tensor4D;
  ys: tf.Tensor2D;
  classNames: string[];
}> {
  sendProgress('loading', { message: `加载 ${classes.length} 个类别的数据...` });
  
  const images: tf.Tensor3D[] = [];
  const labels: number[] = [];
  
  for (let classIdx = 0; classIdx < classes.length; classIdx++) {
    if (shouldStop) throw new Error('训练已取消');
    
    const classData = classes[classIdx];
    sendProgress('loading', { 
      message: `加载类别 "${classData.name}": ${classData.images.length} 张图片` 
    });
    
    for (const base64Data of classData.images) {
      try {
        const imageTensor = await loadImage(base64Data);
        
        // 添加原始图像
        images.push(imageTensor);
        labels.push(classIdx);
        
        // 数据增强
        if (CONFIG.useDataAugmentation) {
          const augmented = augmentImage(imageTensor);
          images.push(augmented);
          labels.push(classIdx);
        }
      } catch (error) {
        console.error('跳过图片:', error);
      }
    }
  }
  
  const totalImages = images.length;
  sendProgress('loading', { 
    message: `已加载 ${totalImages} 张图片${CONFIG.useDataAugmentation ? '（含数据增强）' : ''}` 
  });
  
  // 转换为张量
  const xs = tf.stack(images) as tf.Tensor4D;
  const ys = tf.oneHot(tf.tensor1d(labels, 'int32'), classes.length) as tf.Tensor2D;
  
  // 清理临时张量
  images.forEach(img => img.dispose());
  
  return { 
    xs, 
    ys, 
    classNames: classes.map(c => c.name) 
  };
}

/**
 * 加载预训练 MobileNet
 */
async function loadMobileNetFeatureExtractor(): Promise<tf.LayersModel> {
  sendProgress('loading', { message: '加载预训练 MobileNet 模型...' });
  
  // 加载完整的 MobileNet
  const mobilenet = await tf.loadLayersModel(MOBILENET_URL);
  
  // 获取截断层
  const truncationLayer = mobilenet.getLayer(TRUNCATION_LAYER);
  
  // 创建截断模型（特征提取器）
  const featureExtractor = tf.model({
    inputs: mobilenet.inputs,
    outputs: truncationLayer.output
  });
  
  // 冻结所有层
  featureExtractor.trainable = false;
  
  sendProgress('loading', { message: 'MobileNet 加载成功' });
  
  return featureExtractor;
}

/**
 * 创建分类头
 */
function createClassificationHead(numClasses: number, inputShape: number[]): tf.Sequential {
  const head = tf.sequential({
    layers: [
      // 全局平均池化
      tf.layers.globalAveragePooling2d({
        inputShape: inputShape.slice(1) as [number, number, number]
      }),
      
      // Dropout
      tf.layers.dropout({ rate: CONFIG.dropoutRate }),
      
      // 全连接层
      tf.layers.dense({
        units: CONFIG.denseUnits,
        activation: 'relu',
        kernelInitializer: 'varianceScaling'
      }),
      
      // 输出层
      tf.layers.dense({
        units: numClasses,
        activation: 'softmax',
        kernelInitializer: 'varianceScaling'
      })
    ]
  });
  
  return head;
}

/**
 * 提取特征
 */
async function extractFeatures(
  featureExtractor: tf.LayersModel,
  xs: tf.Tensor4D
): Promise<tf.Tensor4D> {
  sendProgress('loading', { message: '提取图像特征...' });
  
  const batchSize = 32;
  const numSamples = xs.shape[0];
  const features: tf.Tensor4D[] = [];
  
  for (let i = 0; i < numSamples; i += batchSize) {
    if (shouldStop) throw new Error('训练已取消');
    
    const end = Math.min(i + batchSize, numSamples);
    const batch = xs.slice([i, 0, 0, 0], [end - i, -1, -1, -1]);
    const batchFeatures = featureExtractor.predict(batch) as tf.Tensor4D;
    features.push(batchFeatures);
    batch.dispose();
    
    sendProgress('loading', { 
      message: `提取特征: ${end}/${numSamples}` 
    });
  }
  
  // 合并所有特征
  const allFeatures = tf.concat(features) as tf.Tensor4D;
  features.forEach(f => f.dispose());
  
  return allFeatures;
}

/**
 * 训练分类头
 */
async function trainClassificationHead(
  head: tf.Sequential,
  features: tf.Tensor4D,
  ys: tf.Tensor2D,
  config: TrainConfig
): Promise<void> {
  sendProgress('training', { message: '开始训练...' });
  
  // 编译模型
  head.compile({
    optimizer: tf.train.adam(config.learningRate),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy']
  });
  
  // 训练
  await head.fit(features, ys, {
    batchSize: config.batchSize,
    epochs: config.epochs,
    validationSplit: CONFIG.validationSplit,
    shuffle: true,
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        if (shouldStop) {
          head.stopTraining = true;
          return;
        }
        
        if (logs) {
          sendProgress('training', {
            epoch: epoch + 1,
            totalEpochs: config.epochs,
            loss: logs['loss'],
            accuracy: logs['acc'],
            valLoss: logs['val_loss'],
            valAccuracy: logs['val_acc'],
            message: `训练中: Epoch ${epoch + 1}/${config.epochs}`
          });
        }
      }
    }
  });
}

/**
 * 创建完整模型
 */
function createFullModel(
  featureExtractor: tf.LayersModel,
  head: tf.Sequential
): tf.LayersModel {
  const input = tf.input({
    shape: [CONFIG.imageSize, CONFIG.imageSize, 3]
  });
  
  const features = featureExtractor.apply(input) as tf.SymbolicTensor;
  const output = head.apply(features) as tf.SymbolicTensor;
  
  const fullModel = tf.model({
    inputs: input,
    outputs: output,
    name: 'mobilenet_classifier'
  });
  
  return fullModel;
}

/**
 * 主训练流程
 */
async function startTraining(classes: ClassData[], config: TrainConfig) {
  isTraining = true;
  shouldStop = false;
  
  try {
    sendProgress('preparing', { message: '初始化训练...' });
    
    // 设置后端（优先使用 WebGPU）
    await initBestBackend();
    const backend = tf.getBackend();
    sendProgress('preparing', { message: `使用后端: ${backend}` });
    
    // 1. 加载数据集
    const { xs, ys, classNames } = await loadDataset(classes);
    
    if (shouldStop) throw new Error('训练已取消');
    
    // 2. 加载预训练模型
    const featureExtractor = await loadMobileNetFeatureExtractor();
    
    if (shouldStop) throw new Error('训练已取消');
    
    // 3. 提取特征
    const features = await extractFeatures(featureExtractor, xs);
    
    if (shouldStop) throw new Error('训练已取消');
    
    // 4. 创建分类头
    const outputShape = featureExtractor.outputShape as number[];
    const head = createClassificationHead(classes.length, outputShape);
    
    // 5. 训练
    await trainClassificationHead(head, features, ys, config);
    
    if (shouldStop) throw new Error('训练已取消');
    
    // 6. 创建完整模型
    sendProgress('saving', { message: '保存模型...' });
    const fullModel = createFullModel(featureExtractor, head);
    
    // 7. 保存模型到 IndexedDB
    const modelName = `trained-model-${Date.now()}`;
    await fullModel.save(`indexeddb://${modelName}`);
    
    // 8. 保存元数据
    const metadata = {
      tfjsVersion: tf.version.tfjs,
      modelName,
      timeStamp: new Date().toISOString(),
      labels: classNames,
      imageSize: CONFIG.imageSize,
      modelConfig: {
        mobileNetVersion: CONFIG.mobileNetVersion,
        mobileNetAlpha: CONFIG.mobileNetAlpha,
        denseUnits: CONFIG.denseUnits,
        epochs: config.epochs,
        learningRate: config.learningRate,
        batchSize: config.batchSize
      }
    };
    
    // 清理
    xs.dispose();
    ys.dispose();
    features.dispose();
    
    // 发送完成消息
    const response: WorkerResponse = {
      type: 'completed',
      data: {
        modelName,
        metadata,
        classes: classNames
      }
    };
    self.postMessage(response);
    
  } catch (error: any) {
    const response: WorkerResponse = {
      type: 'error',
      data: {
        message: error.message || '训练失败'
      }
    };
    self.postMessage(response);
  } finally {
    isTraining = false;
    shouldStop = false;
  }
}

/**
 * 停止训练
 */
function stopTraining() {
  if (isTraining) {
    shouldStop = true;
    sendProgress('error', { message: '正在取消训练...' });
  }
}

/**
 * 消息处理
 */
self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
  const { type, data } = event.data;
  
  switch (type) {
    case 'start':
      if (data) {
        await startTraining(data.classes, data.config);
      }
      break;
      
    case 'stop':
      stopTraining();
      break;
  }
});

// 通知 Worker 已准备就绪
self.postMessage({ type: 'ready' });
