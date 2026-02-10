import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzPopconfirmModule } from 'ng-zorro-antd/popconfirm';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { UiService } from '../../services/ui.service';
import { MqttManagerService, MqttDevice, MqttMessage, ConnectionConfig } from './mqtt-manager.service';

@Component({
  selector: 'app-mqtt-manager',
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzToolTipModule,
    NzSwitchModule,
    NzResizableModule,
    NzTabsModule,
    NzTableModule,
    NzTagModule,
    NzPopconfirmModule,
    NzEmptyModule,
    NzSpinModule,
    NzModalModule,
    ToolContainerComponent,
    SubWindowComponent,
    TranslateModule,
  ],
  templateUrl: './mqtt-manager.component.html',
  styleUrl: './mqtt-manager.component.scss'
})
export class MqttManagerComponent implements OnInit, OnDestroy {
  @ViewChild('messageListBox') messageListBox!: ElementRef;
  @ViewChild('chatTextarea') chatTextarea!: ElementRef;

  currentUrl: string = '';

  // Broker 连接配置
  brokerHost = 'localhost';
  brokerAdminPort = '3001';
  brokerMqttPort = '1883';

  // 设备管理
  devices: MqttDevice[] = [];
  selectedDevice: MqttDevice | null = null;
  loadingDevices = false;

  // MQTT 连接状态
  isConnected = false;

  // 消息相关
  messages: MqttMessage[] = [];
  inputMessage = '';
  subscribeTopic = '';
  publishTopic = '';
  subscribedTopics: string[] = [];

  // 视图模式
  autoScroll = true;
  showTimestamp = true;

  // UI相关
  bottomHeight = 210;
  activeTab = 0;



  // 凭证弹窗
  showCredentialsModal = false;
  deviceCredentials: any = null;

  constructor(
    private router: Router,
    private cd: ChangeDetectorRef,
    private message: NzMessageService,
    private translate: TranslateService,
    private uiService: UiService,
    private mqttService: MqttManagerService
  ) { }

  ngOnInit() {
    this.currentUrl = this.router.url;

    // 订阅消息
    this.mqttService.messages$.subscribe(msg => {
      this.messages.push(msg);
      if (this.autoScroll) {
        setTimeout(() => this.scrollToBottom(), 50);
      }
      this.cd.detectChanges();
    });

    // 订阅连接状态
    this.mqttService.connectionStatus$.subscribe(status => {
      this.isConnected = status;
      this.cd.detectChanges();
    });

    // 加载保存的配置
    this.loadSavedConfig();
  }

  ngOnDestroy() {
    this.mqttService.disconnect();
  }

  // 加载保存的配置
  loadSavedConfig() {
    const savedConfig = localStorage.getItem('mqtt-manager-config');
    if (savedConfig) {
      const config = JSON.parse(savedConfig);
      this.brokerHost = config.brokerHost || 'localhost';
      this.brokerAdminPort = config.brokerAdminPort || '3001';
      this.brokerMqttPort = config.brokerMqttPort || '1883';
    }
  }

  // 保存配置
  saveConfig() {
    localStorage.setItem('mqtt-manager-config', JSON.stringify({
      brokerHost: this.brokerHost,
      brokerAdminPort: this.brokerAdminPort,
      brokerMqttPort: this.brokerMqttPort,
    }));
  }

  // 检查Broker健康状态
  async checkBrokerHealth() {
    try {
      const result = await this.mqttService.checkHealth(this.brokerHost, this.brokerAdminPort);
      if (result.message === 1000) {
        this.message.success('Broker 服务正常运行');
      } else {
        this.message.error('Broker 服务异常');
      }
    } catch (error) {
      this.message.error('无法连接到 Broker 管理服务');
    }
  }

  // 获取所有设备
  async loadDevices(silent = false) {
    // silent 模式下不显示 loading，避免刷新时页面闪烁
    if (!silent) {
      this.loadingDevices = true;
    }
    try {
      const result = await this.mqttService.getAllDevices(this.brokerHost, this.brokerAdminPort);
      if (result.message === 1000) {
        this.devices = result.detail.devices;
        // this.message.success(`已加载 ${result.detail.total} 个设备`);
      }
    } catch (error) {
      this.message.error('获取设备列表失败');
    } finally {
      this.loadingDevices = false;
      this.cd.detectChanges();
    }
  }

  // 获取设备详情
  async getDeviceDetail(uuid: string) {
    try {
      const result = await this.mqttService.getDeviceDetail(this.brokerHost, this.brokerAdminPort, uuid);
      if (result.message === 1000) {
        this.selectedDevice = result.detail;
        this.cd.detectChanges();
      }
    } catch (error) {
      this.message.error('获取设备详情失败');
    }
  }

  // 创建设备（自动生成UUID和Token）
  async createDevice() {
    try {
      const result = await this.mqttService.createDevice(
        this.brokerHost,
        this.brokerAdminPort
      );
      if (result.message === 1000) {
        this.message.success('设备创建成功');
        await this.loadDevices();
      } else if (result.message === 1001) {
        this.message.error('UUID 已存在');
      }
    } catch (error) {
      this.message.error('创建设备失败');
    }
  }

  // 获取设备连接凭证
  async getDeviceCredentials(uuid: string) {
    try {
      const result = await this.mqttService.getDeviceConnection(this.brokerHost, this.brokerAdminPort, uuid);
      if (result.message === 1000) {
        this.deviceCredentials = result.detail;
        this.showCredentialsModal = true;
      }
    } catch (error) {
      this.message.error('获取连接凭证失败');
    }
  }

  // 使用凭证连接
  async connectWithCredentials() {
    if (!this.deviceCredentials) return;
    this.saveConfig();

    const config: ConnectionConfig = {
      host: this.brokerHost,
      port: parseInt(this.brokerMqttPort),
      clientId: this.deviceCredentials.clientId,
      username: this.deviceCredentials.username,
      password: this.deviceCredentials.password,
    };

    try {
      await this.mqttService.connect(config);
      this.message.success('MQTT 连接成功');
      this.showCredentialsModal = false;
    } catch (error) {
      this.message.error('MQTT 连接失败');
    }
  }

  // 断开连接
  disconnect() {
    this.mqttService.disconnect();
    this.message.info('已断开 MQTT 连接');
  }

  // 订阅主题
  subscribeToTopic() {
    if (!this.subscribeTopic.trim()) {
      this.message.warning('请输入订阅主题');
      return;
    }
    if (!this.isConnected) {
      this.message.warning('请先连接到 MQTT Broker');
      return;
    }

    this.mqttService.subscribe(this.subscribeTopic);
    if (!this.subscribedTopics.includes(this.subscribeTopic)) {
      this.subscribedTopics.push(this.subscribeTopic);
    }
    this.message.success(`已订阅: ${this.subscribeTopic}`);
    this.subscribeTopic = '';
  }

  // 取消订阅
  unsubscribeTopic(topic: string) {
    this.mqttService.unsubscribe(topic);
    this.subscribedTopics = this.subscribedTopics.filter(t => t !== topic);
    this.message.info(`已取消订阅: ${topic}`);
  }

  // 发布消息
  publishMessage() {
    if (!this.publishTopic.trim()) {
      this.message.warning('请输入发布主题');
      return;
    }
    if (!this.inputMessage.trim()) {
      this.message.warning('请输入消息内容');
      return;
    }
    if (!this.isConnected) {
      this.message.warning('请先连接到 MQTT Broker');
      return;
    }

    this.mqttService.publish(this.publishTopic, this.inputMessage);
    this.message.success('消息已发布');
    this.inputMessage = '';
  }

  // 键盘事件处理
  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      this.publishMessage();
    }
  }

  // 清空消息
  clearMessages() {
    this.messages = [];
  }

  // 滚动到底部
  scrollToBottom() {
    if (this.messageListBox) {
      const element = this.messageListBox.nativeElement;
      element.scrollTop = element.scrollHeight;
    }
  }

  // 切换视图模式
  toggleViewMode(mode: 'autoScroll' | 'showTimestamp') {
    if (mode === 'autoScroll') {
      this.autoScroll = !this.autoScroll;
    } else if (mode === 'showTimestamp') {
      this.showTimestamp = !this.showTimestamp;
    }
  }

  // 调整底部高度
  onContentResize({ height }: NzResizeEvent) {
    this.bottomHeight = height!;
  }

  // 复制到剪贴板
  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    this.message.success('已复制到剪贴板');
  }

  // 选择设备
  selectDevice(device: MqttDevice) {
    this.selectedDevice = device;
  }

  // 检查当前选中设备是否已连接（WebSocket 方式）
  isSelectedDeviceConnected(): boolean {
    return this.mqttService.isConnected();
  }

  // 测试设备上线（使用 WebSocket 方式）
  async testDeviceOnline() {
    if (!this.selectedDevice) {
      this.message.warning('请先选择设备');
      return;
    }

    try {
      // 1. 获取设备连接凭证
      const result = await this.mqttService.getDeviceConnection(
        this.brokerHost,
        this.brokerAdminPort,
        this.selectedDevice.uuid
      );

      if (result.message !== 1000) {
        this.message.error('获取连接凭证失败');
        return;
      }

      const credentials = result.detail;
      this.saveConfig();

      // 2. 使用 WebSocket 连接到 Broker
      const config: ConnectionConfig = {
        host: this.brokerHost,
        port: parseInt(this.brokerMqttPort),
        clientId: credentials.clientId,
        username: credentials.username,
        password: credentials.password,
      };

      await this.mqttService.connect(config);
      this.message.success(`设备 ${this.selectedDevice.uuid} 已上线`);
      this.cd.detectChanges();

      // 3. 刷新设备列表以更新状态
      setTimeout(() => {
        this.loadDevices(true);
      }, 1000);

    } catch (error: any) {
      this.message.error(`上线失败: ${error.message || error}`);
    }
  }

  // 断开当前设备连接
  disconnectDevice() {
    if (!this.selectedDevice) return;
    this.mqttService.disconnect();
    this.message.info('设备已下线');
    this.cd.detectChanges();
    // 刷新设备列表以更新状态
    setTimeout(() => {
      this.loadDevices(true);
    }, 1000);
  }

  // 关闭工具
  close() {
    this.uiService.closeTool('mqtt-manager');
  }

  // 格式化时间
  formatTime(date: Date | string): string {
    const d = new Date(date);
    return d.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  // 获取消息方向样式
  getMessageClass(type: string): string {
    switch (type) {
      case 'received': return 'msg-received';
      case 'sent': return 'msg-sent';
      case 'system': return 'msg-system';
      default: return '';
    }
  }

  showMoreSettings = false;
  openMoreSettings() {

  }

  switchValue=false;
  toggleSwitch() {
    this.switchValue = !this.switchValue;
  }
}
