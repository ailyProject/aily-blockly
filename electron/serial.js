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
 * 创建带节流功能的串口包装器
 * @param {Object} options - 串口配置选项
 * @param {number} [flushInterval=100] - 节流间隔，单位毫秒
 * @returns {Object} 串口包装器对象
 */
function createThrottledSerialPort(options, flushInterval = DEFAULT_FLUSH_INTERVAL) {
  const port = new SerialPort(options);
  
  // IPC 节流相关变量
  let dataBuffer = [];          // 数据缓冲区
  let dataCallback = null;      // 数据回调函数
  let flushTimer = null;        // 定时器
  
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
    open: (callback) => port.open(callback),
    
    /**
     * 关闭串口
     */
    close: (callback) => {
      stopFlushTimer();
      port.close(callback);
    },
    
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

module.exports = {
  createThrottledSerialPort,
  listPorts,
  DEFAULT_FLUSH_INTERVAL
};
