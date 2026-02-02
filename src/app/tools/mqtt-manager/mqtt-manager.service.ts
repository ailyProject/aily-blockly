import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export interface MqttDevice {
  id: number;
  uuid: string;
  token: string;
  auth_key: string;
  client_id: string;
  username: string;
  password?: string;
  iot_token?: string;
  created_at: string;
  updated_at: string;
  groups?: string[];
}

export interface MqttMessage {
  topic: string;
  payload: string;
  timestamp: Date;
  type: 'received' | 'sent' | 'system';
}

export interface ConnectionConfig {
  host: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
  protocol?: 'ws' | 'wss';
}

export interface ApiResponse<T = any> {
  message: number;
  detail: T;
}

/**
 * 简易 MQTT over WebSocket 客户端
 * 用于浏览器环境中的 MQTT 通信
 */
class SimpleMqttClient {
  private ws: WebSocket | null = null;
  private messageId = 1;
  private subscriptions: Map<string, (topic: string, payload: string) => void> = new Map();

  onConnect: (() => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onMessage: ((topic: string, payload: string) => void) | null = null;
  onError: ((error: string) => void) | null = null;

  constructor(
    private host: string,
    private port: number,
    private clientId: string,
    private username: string,
    private password: string
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 使用 WebSocket 连接（MQTT Broker 需要支持 WebSocket）
      const wsUrl = `ws://${this.host}:${this.port}/mqtt`;

      try {
        this.ws = new WebSocket(wsUrl, 'mqtt');
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          // 发送 CONNECT 包
          this.sendConnect();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (event) => {
          const errorMsg = 'WebSocket 连接错误';
          this.onError?.(errorMsg);
          reject(new Error(errorMsg));
        };

        this.ws.onclose = () => {
          this.onDisconnect?.();
        };

        // 连接超时
        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws?.close();
            reject(new Error('连接超时'));
          }
        }, 10000);

        // 假设连接成功（简化处理）
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.onConnect?.();
            resolve();
          }
        }, 500);
      } catch (error) {
        reject(error);
      }
    });
  }

  private sendConnect() {
    // 简化的 MQTT CONNECT 包
    // 实际实现需要完整的 MQTT 协议编码
    const connectPacket = this.buildConnectPacket();
    this.ws?.send(connectPacket);
  }

  private buildConnectPacket(): ArrayBuffer {
    // 简化实现：构建 MQTT CONNECT 包
    const protocolName = 'MQTT';
    const protocolLevel = 4; // MQTT 3.1.1
    const connectFlags = 0xC2; // Username + Password + Clean Session
    const keepAlive = 60;

    const clientIdBytes = new TextEncoder().encode(this.clientId);
    const usernameBytes = new TextEncoder().encode(this.username);
    const passwordBytes = new TextEncoder().encode(this.password);

    // 计算剩余长度
    const remainingLength = 10 + 2 + clientIdBytes.length + 2 + usernameBytes.length + 2 + passwordBytes.length;

    const packet = new Uint8Array(2 + remainingLength);
    let offset = 0;

    // Fixed header
    packet[offset++] = 0x10; // CONNECT
    packet[offset++] = remainingLength;

    // Protocol Name
    packet[offset++] = 0;
    packet[offset++] = 4;
    packet[offset++] = 'M'.charCodeAt(0);
    packet[offset++] = 'Q'.charCodeAt(0);
    packet[offset++] = 'T'.charCodeAt(0);
    packet[offset++] = 'T'.charCodeAt(0);

    // Protocol Level
    packet[offset++] = protocolLevel;

    // Connect Flags
    packet[offset++] = connectFlags;

    // Keep Alive
    packet[offset++] = (keepAlive >> 8) & 0xFF;
    packet[offset++] = keepAlive & 0xFF;

    // Client ID
    packet[offset++] = (clientIdBytes.length >> 8) & 0xFF;
    packet[offset++] = clientIdBytes.length & 0xFF;
    packet.set(clientIdBytes, offset);
    offset += clientIdBytes.length;

    // Username
    packet[offset++] = (usernameBytes.length >> 8) & 0xFF;
    packet[offset++] = usernameBytes.length & 0xFF;
    packet.set(usernameBytes, offset);
    offset += usernameBytes.length;

    // Password
    packet[offset++] = (passwordBytes.length >> 8) & 0xFF;
    packet[offset++] = passwordBytes.length & 0xFF;
    packet.set(passwordBytes, offset);

    return packet.buffer;
  }

  private handleMessage(data: ArrayBuffer) {
    const bytes = new Uint8Array(data);
    const packetType = (bytes[0] >> 4) & 0x0F;

    switch (packetType) {
      case 2: // CONNACK
        this.onConnect?.();
        break;
      case 3: // PUBLISH
        this.handlePublish(bytes);
        break;
      case 9: // SUBACK
        // 订阅确认
        break;
      case 11: // UNSUBACK
        // 取消订阅确认
        break;
      case 13: // PINGRESP
        // Ping 响应
        break;
    }
  }

  private handlePublish(bytes: Uint8Array) {
    let offset = 1;

    // 读取剩余长度
    let remainingLength = 0;
    let multiplier = 1;
    let byte;
    do {
      byte = bytes[offset++];
      remainingLength += (byte & 127) * multiplier;
      multiplier *= 128;
    } while ((byte & 128) !== 0);

    // 读取主题长度
    const topicLength = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;

    // 读取主题
    const topic = new TextDecoder().decode(bytes.slice(offset, offset + topicLength));
    offset += topicLength;

    // 读取消息
    const payload = new TextDecoder().decode(bytes.slice(offset));

    this.onMessage?.(topic, payload);
  }

  subscribe(topic: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const topicBytes = new TextEncoder().encode(topic);
    const packetId = this.messageId++;

    const packet = new Uint8Array(5 + topicBytes.length);
    let offset = 0;

    // Fixed header
    packet[offset++] = 0x82; // SUBSCRIBE
    packet[offset++] = 3 + topicBytes.length; // Remaining length

    // Packet ID
    packet[offset++] = (packetId >> 8) & 0xFF;
    packet[offset++] = packetId & 0xFF;

    // Topic
    packet[offset++] = (topicBytes.length >> 8) & 0xFF;
    packet[offset++] = topicBytes.length & 0xFF;
    packet.set(topicBytes, offset);
    offset += topicBytes.length;

    // QoS
    // packet[offset++] = 0;

    this.ws.send(packet.buffer);
  }

  unsubscribe(topic: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const topicBytes = new TextEncoder().encode(topic);
    const packetId = this.messageId++;

    const packet = new Uint8Array(4 + topicBytes.length);
    let offset = 0;

    // Fixed header
    packet[offset++] = 0xA2; // UNSUBSCRIBE
    packet[offset++] = 2 + topicBytes.length; // Remaining length

    // Packet ID
    packet[offset++] = (packetId >> 8) & 0xFF;
    packet[offset++] = packetId & 0xFF;

    // Topic
    packet[offset++] = (topicBytes.length >> 8) & 0xFF;
    packet[offset++] = topicBytes.length & 0xFF;
    packet.set(topicBytes, offset);

    this.ws.send(packet.buffer);
  }

  publish(topic: string, payload: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const topicBytes = new TextEncoder().encode(topic);
    const payloadBytes = new TextEncoder().encode(payload);

    const remainingLength = 2 + topicBytes.length + payloadBytes.length;
    const packet = new Uint8Array(2 + remainingLength);
    let offset = 0;

    // Fixed header
    packet[offset++] = 0x30; // PUBLISH (QoS 0)
    packet[offset++] = remainingLength;

    // Topic
    packet[offset++] = (topicBytes.length >> 8) & 0xFF;
    packet[offset++] = topicBytes.length & 0xFF;
    packet.set(topicBytes, offset);
    offset += topicBytes.length;

    // Payload
    packet.set(payloadBytes, offset);

    this.ws.send(packet.buffer);
  }

  disconnect() {
    if (this.ws) {
      // 发送 DISCONNECT 包
      const packet = new Uint8Array([0xE0, 0x00]);
      this.ws.send(packet.buffer);
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

@Injectable({
  providedIn: 'root'
})
export class MqttManagerService {
  private client: SimpleMqttClient | null = null;

  // 消息流
  private messagesSubject = new Subject<MqttMessage>();
  public messages$ = this.messagesSubject.asObservable();

  // 连接状态
  private connectionStatusSubject = new BehaviorSubject<boolean>(false);
  public connectionStatus$ = this.connectionStatusSubject.asObservable();

  constructor() {}

  // ==================== Admin API ====================

  /**
   * 检查 Broker 健康状态
   */
  async checkHealth(host: string, port: string): Promise<ApiResponse> {
    const response = await fetch(`http://${host}:${port}/health`);
    return response.json();
  }

  /**
   * 获取所有设备
   */
  async getAllDevices(host: string, port: string): Promise<ApiResponse<{ devices: MqttDevice[]; total: number }>> {
    const response = await fetch(`http://${host}:${port}/admin/devices`);
    return response.json();
  }

  /**
   * 获取设备详情
   */
  async getDeviceDetail(host: string, port: string, uuid: string): Promise<ApiResponse<MqttDevice>> {
    const response = await fetch(`http://${host}:${port}/admin/device/${uuid}`);
    return response.json();
  }

  /**
   * 创建设备
   */
  async createDevice(host: string, port: string, uuid?: string, token?: string): Promise<ApiResponse<{ uuid: string; token: string; authKey: string }>> {
    const body: any = {};
    if (uuid) body.uuid = uuid;
    if (token) body.token = token;

    const response = await fetch(`http://${host}:${port}/admin/device`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  /**
   * 获取设备连接凭证
   */
  async getDeviceConnection(host: string, port: string, uuid: string): Promise<ApiResponse<{ uuid: string; clientId: string; username: string; password: string }>> {
    const response = await fetch(`http://${host}:${port}/admin/device/${uuid}/connection`);
    return response.json();
  }

  // ==================== MQTT Client ====================

  /**
   * 连接到 MQTT Broker (via WebSocket)
   */
  connect(config: ConnectionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      // 如果已连接，先断开
      if (this.client) {
        this.disconnect();
      }

      this.client = new SimpleMqttClient(
        config.host,
        config.port,
        config.clientId,
        config.username,
        config.password
      );

      this.client.onConnect = () => {
        this.connectionStatusSubject.next(true);
        this.addSystemMessage('已连接到 MQTT Broker');
        resolve();
      };

      this.client.onDisconnect = () => {
        this.connectionStatusSubject.next(false);
        this.addSystemMessage('连接已关闭');
      };

      this.client.onError = (error) => {
        this.addSystemMessage(`连接错误: ${error}`);
        reject(new Error(error));
      };

      this.client.onMessage = (topic, payload) => {
        const message: MqttMessage = {
          topic,
          payload,
          timestamp: new Date(),
          type: 'received',
        };
        this.messagesSubject.next(message);
      };

      this.client.connect().catch(reject);
    });
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this.connectionStatusSubject.next(false);
    }
  }

  /**
   * 订阅主题
   */
  subscribe(topic: string): void {
    if (this.client && this.connectionStatusSubject.value) {
      this.client.subscribe(topic);
      this.addSystemMessage(`已订阅: ${topic}`);
    }
  }

  /**
   * 取消订阅
   */
  unsubscribe(topic: string): void {
    if (this.client && this.connectionStatusSubject.value) {
      this.client.unsubscribe(topic);
      this.addSystemMessage(`已取消订阅: ${topic}`);
    }
  }

  /**
   * 发布消息
   */
  publish(topic: string, payload: string): void {
    if (this.client && this.connectionStatusSubject.value) {
      this.client.publish(topic, payload);
      const message: MqttMessage = {
        topic,
        payload,
        timestamp: new Date(),
        type: 'sent',
      };
      this.messagesSubject.next(message);
    }
  }

  /**
   * 添加系统消息
   */
  private addSystemMessage(content: string): void {
    const message: MqttMessage = {
      topic: 'SYSTEM',
      payload: content,
      timestamp: new Date(),
      type: 'system',
    };
    this.messagesSubject.next(message);
  }

  /**
   * 获取连接状态
   */
  isConnected(): boolean {
    return this.connectionStatusSubject.value;
  }
}
