const net = require('net')

/**
 * 跨应用通信模块
 * 用于两个独立 Electron 应用之间的通信
 */
class CrossAppCommunication {
  constructor() {
    this.server = null
    this.client = null
    this.serverPort = 0 // 0 表示自动分配端口
    this.remotePort = null
    this.remoteHost = '127.0.0.1'
    this.messageHandlers = new Map()
    this.pendingRequests = new Map()
    this.requestId = 0
    this.serverSockets = [] // 存储服务器模式下的所有连接
  }

  /**
   * 启动服务器（监听其他应用的连接）
   * @param {number} port - 端口号，0 表示自动分配
   * @returns {Promise<number>} 实际监听的端口号
   */
  startServer(port = 0) {
    return new Promise((resolve, reject) => {
      if (this.server) {
        reject(new Error('服务器已经启动'))
        return
      }

      this.server = net.createServer((socket) => {
        console.log('收到其他应用的连接')
        this.serverSockets.push(socket)

        socket.on('data', (data) => {
          try {
            const message = JSON.parse(data.toString())
            this.handleMessage(socket, message)
          } catch (error) {
            console.error('解析消息失败:', error)
          }
        })

        socket.on('error', (error) => {
          console.error('Socket 错误:', error)
          this.removeServerSocket(socket)
        })

        socket.on('close', () => {
          console.log('连接已关闭')
          this.removeServerSocket(socket)
        })
      })

      this.server.on('error', (error) => {
        console.error('服务器错误:', error)
        reject(error)
      })

      this.server.listen(port, '127.0.0.1', () => {
        const actualPort = this.server.address().port
        this.serverPort = actualPort
        console.log(`跨应用通信服务器已启动，端口: ${actualPort}`)
        resolve(actualPort)
      })
    })
  }

  /**
   * 连接到另一个应用
   * @param {number} port - 目标应用的端口号
   * @param {string} host - 目标应用的主机地址，默认 127.0.0.1
   * @returns {Promise<void>}
   */
  connectToApp(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      if (this.client) {
        reject(new Error('已经连接到其他应用'))
        return
      }

      this.remotePort = port
      this.remoteHost = host

      this.client = net.createConnection({ port, host }, () => {
        console.log(`已连接到其他应用 ${host}:${port}`)
        resolve()
      })

      this.client.on('data', (data) => {
        try {
          const message = JSON.parse(data.toString())
          this.handleMessage(this.client, message)
        } catch (error) {
          console.error('解析消息失败:', error)
        }
      })

      this.client.on('error', (error) => {
        console.error('客户端连接错误:', error)
        reject(error)
      })

      this.client.on('close', () => {
        console.log('连接已关闭')
        this.client = null
      })
    })
  }

  /**
   * 发送同步消息（模拟 sendSync）
   * @param {string} channel - 消息通道
   * @param {any} data - 消息数据
   * @param {number} timeout - 超时时间（毫秒），默认 5000
   * @returns {Promise<any>} 返回响应数据
   */
  async sendSync(channel, data, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const socket = this.client || this.getConnectedSocket()
      if (!socket) {
        reject(new Error('未连接到其他应用'))
        return
      }

      const requestId = ++this.requestId
      const message = {
        type: 'request',
        id: requestId,
        channel,
        data,
        timestamp: Date.now()
      }

      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`请求超时: ${channel}`))
      }, timeout)

      // 保存请求回调
      this.pendingRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer)
          resolve(data)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })

      // 发送消息
      socket.write(JSON.stringify(message))
    })
  }

  /**
   * 发送异步消息
   * @param {string} channel - 消息通道
   * @param {any} data - 消息数据
   */
  send(channel, data) {
    const socket = this.client || this.getConnectedSocket()
    if (!socket) {
      console.error('未连接到其他应用')
      return
    }

    const message = {
      type: 'message',
      channel,
      data,
      timestamp: Date.now()
    }

    socket.write(JSON.stringify(message))
  }

  /**
   * 注册消息处理器
   * @param {string} channel - 消息通道
   * @param {Function} handler - 处理函数，返回响应数据
   */
  on(channel, handler) {
    this.messageHandlers.set(channel, handler)
  }

  /**
   * 移除消息处理器
   * @param {string} channel - 消息通道
   */
  removeHandler(channel) {
    this.messageHandlers.delete(channel)
  }

  /**
   * 处理接收到的消息
   * @private
   */
  handleMessage(socket, message) {
    if (message.type === 'request') {
      // 处理请求并返回响应
      const handler = this.messageHandlers.get(message.channel)
      if (handler) {
        try {
          const result = handler(message.data)
          const response = {
            type: 'response',
            id: message.id,
            success: true,
            data: result,
            timestamp: Date.now()
          }
          socket.write(JSON.stringify(response))
        } catch (error) {
          const response = {
            type: 'response',
            id: message.id,
            success: false,
            error: error.message,
            timestamp: Date.now()
          }
          socket.write(JSON.stringify(response))
        }
      } else {
        // 没有处理器，返回错误
        const response = {
          type: 'response',
          id: message.id,
          success: false,
          error: `未找到处理器: ${message.channel}`,
          timestamp: Date.now()
        }
        socket.write(JSON.stringify(response))
      }
    } else if (message.type === 'response') {
      // 处理响应
      const pendingRequest = this.pendingRequests.get(message.id)
      if (pendingRequest) {
        this.pendingRequests.delete(message.id)
        if (message.success) {
          pendingRequest.resolve(message.data)
        } else {
          pendingRequest.reject(new Error(message.error || '请求失败'))
        }
      }
    } else if (message.type === 'message') {
      // 处理普通消息（异步）
      const handler = this.messageHandlers.get(message.channel)
      if (handler) {
        try {
          handler(message.data)
        } catch (error) {
          console.error('处理消息失败:', error)
        }
      }
    }
  }

  /**
   * 获取已连接的 socket（用于服务器模式）
   * @private
   */
  getConnectedSocket() {
    // 返回第一个连接的 socket（如果有多个连接，可以扩展为选择逻辑）
    return this.serverSockets.length > 0 ? this.serverSockets[0] : null
  }

  /**
   * 移除服务器 socket
   * @private
   */
  removeServerSocket(socket) {
    const index = this.serverSockets.indexOf(socket)
    if (index > -1) {
      this.serverSockets.splice(index, 1)
    }
  }

  /**
   * 获取服务器端口号
   * @returns {number}
   */
  getServerPort() {
    return this.serverPort
  }

  /**
   * 关闭连接和服务器
   */
  close() {
    if (this.client) {
      this.client.destroy()
      this.client = null
    }

    // 关闭所有服务器连接
    this.serverSockets.forEach(socket => {
      socket.destroy()
    })
    this.serverSockets = []

    if (this.server) {
      this.server.close(() => {
        console.log('跨应用通信服务器已关闭')
      })
      this.server = null
    }

    this.messageHandlers.clear()
    this.pendingRequests.clear()
  }
}

module.exports = CrossAppCommunication

