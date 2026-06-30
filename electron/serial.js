/**
 * 串口通信模块 - 带 IPC 节流优化
 * 
 * 解决高频数据发送时界面卡顿问题
 * 通过缓冲区收集数据，每 100ms 批量发送一次
 */

const { SerialPort } = require("serialport");

// 默认节流间隔 (ms)
const DEFAULT_FLUSH_INTERVAL = 100;

/**
 * 跨工具的开口注册表：path -> { port, evict }
 *
 * 同一个渲染进程（如 serial-monitor 、ffs-manager）可能针对同一串口
 * 创建多个 SerialPort 包装。Windows 上 SerialPort 独占句柄，只要前一个未 close，
 * 后者 open() 就会 ACCESS DENIED。这里依赖注册表，在开新串口前先强制驱逐老的。
 */
const openPortRegistry = new Map();

function registerOpenPort(path, entry) {
  openPortRegistry.set(path, entry);
}

function unregisterOpenPort(path, port) {
  const cur = openPortRegistry.get(path);
  if (cur && cur.port === port) openPortRegistry.delete(path);
}

/**
 * 驱逐同 path 的旧 SerialPort（如果还开着）。
 * 并发可调，调用方需 await。
 */
async function evictSamePathPort(path) {
  const entry = openPortRegistry.get(path);
  if (!entry) return;
  openPortRegistry.delete(path);
  try {
    if (typeof entry.evict === 'function') {
      await entry.evict();
    } else if (entry.port && entry.port.isOpen) {
      await new Promise((resolve) => entry.port.close(() => resolve()));
    }
  } catch (err) {
    console.warn('[serial] evictSamePathPort 失败:', path, err);
  }
}

/**
 * 包装 port.open：在 native open 之前强制驱逐同路径的旧 port，
 * 成功后把自己注册进去。遵循 node-serialport 的 (callback) 接口。
 */
function makeOpenWithEviction(port, evictFn) {
  return (callback) => {
    (async () => {
      await evictSamePathPort(port.path);
      // 驱逐后给 Windows 一点释放句柄的时间。
      await new Promise((r) => setTimeout(r, 50));
      port.open((err) => {
        if (!err) registerOpenPort(port.path, { port, evict: evictFn });
        if (callback) callback(err);
      });
    })().catch((err) => {
      if (callback) callback(err);
    });
  };
}

function makeCloseWithUnregister(port, doClose) {
  return (callback) => {
    unregisterOpenPort(port.path, port);
    doClose(callback);
  };
}

/**
 * 创建带节流功能的串口包装器
 * @param {Object} options - 串口配置选项
 * @param {number} [flushInterval=100] - 节流间隔，单位毫秒
 * @returns {Object} 串口包装器对象
 */
function createThrottledSerialPort(options, flushInterval = DEFAULT_FLUSH_INTERVAL) {
  const port = new SerialPort({ autoOpen: false, ...options });
  
  // IPC 节流相关变量
  let dataBuffer = [];          // 数据缓冲区
  let dataCallback = null;      // 数据回调函数
  let flushTimer = null;        // 定时器

  const evictSelf = () => new Promise((resolve) => {
    stopFlushTimer();
    if (!port.isOpen) { resolve(); return; }
    port.close((err) => {
      if (err) console.warn('[serial] throttled evict close 失败:', port.path, err);
      resolve();
    });
  });
  
  /**
   * 刷新缓冲区，将累积的数据一次性发送
   */
  const flushBuffer = () => {
    if (dataBuffer.length > 0 && dataCallback) {
      // 合并所有缓冲的数据为一个 Buffer
      const combinedData = Buffer.concat(dataBuffer);
      dataBuffer = [];
      dataCallback(combinedData);
    }
  };
  
  /**
   * 启动定时刷新
   */
  const startFlushTimer = () => {
    if (!flushTimer) {
      flushTimer = setInterval(flushBuffer, flushInterval);
    }
  };
  
  /**
   * 停止定时刷新
   */
  const stopFlushTimer = () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    // 确保剩余数据被刷新
    flushBuffer();
  };
  
  return {
    /**
     * 写入数据到串口
     */
    write: (data, callback) => port.write(data, callback),
    
    /**
     * 打开串口
     */
    open: makeOpenWithEviction(port, evictSelf),
    
    /**
     * 关闭串口
     */
    close: makeCloseWithUnregister(port, (callback) => {
      stopFlushTimer();
      port.close(callback);
    }),
    
    /**
     * 注册事件监听器
     * 对 'data' 事件进行节流处理
     */
    on: (event, callback) => {
      if (event === 'data') {
        // 对 data 事件进行节流处理
        dataCallback = callback;
        startFlushTimer();
        port.on(event, (data) => {
          // 将数据添加到缓冲区
          dataBuffer.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });
      } else if (event === 'close') {
        // close 事件时停止定时器
        port.on(event, (...args) => {
          stopFlushTimer();
          callback(...args);
        });
      } else {
        port.on(event, callback);
      }
      return port; // 允许链式调用
    },
    
    /**
     * 移除事件监听器
     */
    off: (event, callback) => {
      if (event === 'data') {
        dataCallback = null;
        stopFlushTimer();
      }
      port.off(event, callback);
      return port;
    },
    
    /**
     * 设置串口信号 (DTR/RTS 等)
     */
    set: (options, callback) => port.set(options, callback),
    
    /**
     * 获取 DTR 信号状态
     */
    dtrBool: () => {
      if (typeof port.dtrBool === 'function') {
        return port.dtrBool();
      }
      return false;
    },
    
    /**
     * 获取 RTS 信号状态
     */
    rtsBool: () => {
      if (typeof port.rtsBool === 'function') {
        return port.rtsBool();
      }
      return false;
    },
    
    /**
     * 获取串口路径
     */
    get path() { return port.path; },
    
    /**
     * 获取串口是否已打开
     */
    get isOpen() { return port.isOpen; }
  };
}

/**
 * 获取可用串口列表
 */
async function listPorts() {
  return await SerialPort.list();
}

/**
 * 创建未经节流的原始串口对象
 *
 * 用于 esptool-js Transport 等需要逐字节、低延迟读写的场景。
 * 注意：contextBridge 不会把 SerialPort 原型方法暴露给渲染端，
 * 所以这里返回一个纯对象字面量，逐个代理需要用到的方法 / 属性。
 */
function createRawSerialPort(options) {
  const port = new SerialPort({ autoOpen: false, ...options });

  const listenerMap = new WeakMap();

  const evictSelf = () => new Promise((resolve) => {
    if (!port.isOpen) { resolve(); return; }
    port.close((err) => {
      if (err) console.warn('[serial] raw evict close 失败:', port.path, err);
      resolve();
    });
  });

  const doClose = (callback) => port.close(callback);

  return {
    open: makeOpenWithEviction(port, evictSelf),
    close: makeCloseWithUnregister(port, doClose),
    update: (options, callback) => port.update(options, callback),
    write: (data, callback) => port.write(data, callback),
    set: (signals, callback) => port.set(signals, callback),
    flush: (callback) => port.flush(callback),
    drain: (callback) => port.drain(callback),
    on: (event, callback) => {
      let wrapped = callback;
      if (event === 'data') {
        // 跨桥传来的 Node Buffer 在渲染端可能不再是 Buffer 实例，
        // 包成 Uint8Array 让 WebStreams 端能直接消费。
        wrapped = (chunk) => {
          const view = chunk instanceof Uint8Array
            ? chunk
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          callback(view);
        };
        listenerMap.set(callback, wrapped);
      }
      port.on(event, wrapped);
    },
    off: (event, callback) => {
      const wrapped = listenerMap.get(callback) || callback;
      port.off(event, wrapped);
      if (event === 'data') listenerMap.delete(callback);
    },
    removeAllListeners: (event) => port.removeAllListeners(event),
    get path() { return port.path; },
    get isOpen() { return port.isOpen; },
    get baudRate() { return port.baudRate; },
  };
}

module.exports = {
  createThrottledSerialPort,
  createRawSerialPort,
  listPorts,
  DEFAULT_FLUSH_INTERVAL
};
