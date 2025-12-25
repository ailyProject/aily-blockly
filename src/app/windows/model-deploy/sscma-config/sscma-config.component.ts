import { Component, Input, OnInit, OnDestroy, Output, EventEmitter, ChangeDetectorRef, OnChanges, SimpleChanges, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { NzSliderModule } from 'ng-zorro-antd/slider';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCardModule } from 'ng-zorro-antd/card';
import { NzDividerModule } from 'ng-zorro-antd/divider';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';
import { Subscription, Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { SSCMACommandService, AtResponse, InvokeResultData } from '../../../services/sscma-command.service';
import { SerialService, PortItem } from '../../../services/serial.service';
import { MenuComponent } from '../../../components/menu/menu.component';
import { SubWindowComponent } from '../../../components/sub-window/sub-window.component';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { ElectronService } from '../../../services/electron.service';
import { TranslateModule } from '@ngx-translate/core';

interface TriggerRule {
  id: number;
  classId: number;         // 目标类别ID
  condition: number;       // 条件类型: 0=>, 1=<, 2=>=, 3=<=, 4==, 5=!=
  threshold: number;       // 分数阈值 (0-100)
  gpio: number;            // GPIO引脚
  initLevel: number;       // 初始电平: 0=低, 1=高
  triggerLevel: number;    // 触发电平: 0=低, 1=高
}

// 简化的类别触发配置（前端简化版）
interface ClassTriggerConfig {
  classId: number;         // 类别ID（对应 modelMeta.classes 索引）
  threshold: number;       // 置信度阈值 (0-100)
  gpio: number | null;     // GPIO引脚，null表示未配置
  levelMode: 'high' | 'low' | null; // high=默认低触发高, low=默认高触发低
}

/**
 * SSCMA 模型配置组件
 * 负责连接设备、加载设备信息、实时预览、识别结果展示
 */
@Component({
  selector: 'app-sscma-config',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzSliderModule,
    NzButtonModule,
    NzCardModule,
    NzDividerModule,
    NzSwitchModule,
    NzInputModule,
    NzInputNumberModule,
    NzTagModule,
    NzSelectModule,
    NzSpinModule,
    NzIconModule,
    MenuComponent,
    SubWindowComponent,
    NzTabsModule,
    TranslateModule
  ],
  templateUrl: './sscma-config.component.html',
  styleUrls: ['./sscma-config.component.scss']
})
export class SscmaConfigComponent implements OnInit, OnDestroy, OnChanges {
  // ===================
  // 输入输出
  // ===================
  @Input() portPath!: string;
  @Input() showFrame: boolean = true;  // 是否显示外框
  @Output() configComplete = new EventEmitter<void>();
  @Output() backToDeploy = new EventEmitter<void>();

  // ===================
  // 视图引用
  // ===================
  @ViewChild('rightPanel') rightPanelRef?: ElementRef<HTMLDivElement>;
  @ViewChild('overlayCanvas') overlayCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewImg') previewImgRef?: ElementRef<HTMLImageElement>;

  // ===================
  // 串口相关
  // ===================
  currentPort: string | undefined;
  showPortList = false;
  portList: PortItem[] = [];
  position = { x: 0, y: 0 };

  // ===================
  // 传输类型
  // ===================
  showTransportList = false;
  transportMenuList: Array<{ name: string; text: string; value?: number; disabled?: boolean }> = [];
  currentTransport?: number;
  currentTransportName: string = '';

  // ===================
  // 连接状态
  // ===================
  isConnected = false;
  isConnecting = false;
  isLoadingConfig = false;

  // ===================
  // 预览相关
  // ===================
  isPreviewMode = false;
  previewImage: string | null = null;
  previewImageUrl: string | null = null;
  imageVersion: number = 0;
  lastUpdateTime: string = '';

  // ===================
  // 设备信息
  // ===================
  deviceInfo: {
    id?: string;
    name?: string;
    version?: any;
    device_id?: string | number;
    device_name?: string;
    device_version?: any;
    inference_interval_ms?: number;
    default_inference_mode?: string;
  } = {};

  // ===================
  // 模型元数据
  // ===================
  infoRaw: string | null = null;
  infoDecoded: string | null = null;
  modelMeta: {
    name?: string;
    version?: string;
    pic_url?: string;
    classes?: string[]
  } = {};

  modelInfo: {
    id?: number;
    type?: number;
    address?: number;
    size?: number;
  } = {};

  sensorInfo: {
    id?: number;
    type?: number;
    state?: number;
    opt_detail?: string;
  } = {};

  // ===================
  // 配置参数
  // ===================
  scoreThreshold: number = 60;
  iouThreshold: number = 50;
  confidenceThreshold: number = 60;  // 置信度阈值（与 scoreThreshold 同义）

  // ===================
  // 推理和识别
  // ===================
  isInvoking = false;
  invokeResults: InvokeResultData[] = [];
  resultCount = 0;
  classScores: number[] = [];
  barColors: string[] = ['#52c41a', '#1890ff', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2'];
  // 当前用于绘制的 boxes（每项为 [x,y,w,h,score,targetId]）
  currentBoxes: number[][] = [];

  // ===================
  // GPIO 触发规则 (AT+TRIGGER)
  // ===================
  triggerRules: TriggerRule[] = [];
  nextTriggerId = 1;
  
  // 简化的类别触发配置（每个类别一个配置）
  classTriggerConfigs: ClassTriggerConfig[] = [];
  
  availableGpioPins = [
    // {[1, 2, 3, 21, 41, 42]}; // XIAO ESP32-S3 可用GPIO
    { label: 'LED', value: 21 },
    { label: 'GPIO1(D0)', value: 1 },
    { label: 'GPIO2(D1)', value: 2 },
    { label: 'GPIO3(D2)', value: 3 },
    { label: 'GPIO42(D11)', value: 42 },
    { label: 'GPIO41(D12)', value: 41 }
  ];
  triggerConditionOptions = [
    { label: '大于', value: 0 },
    { label: '小于', value: 1 },
    { label: '大于等于', value: 2 },
    { label: '小于等于', value: 3 },
    { label: '等于', value: 4 },
    { label: '不等于', value: 5 }
  ];
  triggerLevelOptions = [
    { label: '灭灯', value: 0 },
    { label: '亮灯', value: 1 }
  ];

  // 根据 GPIO 引脚获取电平选项（LED 显示亮灯/灭灯，其他显示高电平/低电平）
  getLevelOptionsForGpio(gpio: number): Array<{ label: string; value: number }> {
    if (gpio === 21) { // LED 对应的引脚值是 21
      return [
        { label: '灭灯', value: 0 },
        { label: '亮灯', value: 1 }
      ];
    } else {
      return [
        { label: '低电平', value: 0 },
        { label: '高电平', value: 1 }
      ];
    }
  }

  // 获取类别选项（从模型元数据）
  get classOptions(): Array<{ label: string; value: number }> {
    if (this.modelMeta.classes && this.modelMeta.classes.length > 0) {
      return this.modelMeta.classes.map((name, index) => ({
        label: name,
        value: index
      }));
    }
    // 默认返回数字选项
    return Array.from({ length: 10 }, (_, i) => ({
      label: `类别 ${i}`,
      value: i
    }));
  }

  gpioOptions: { label: string; value: number }[] = [];

  // ===================
  // 触发规则选项（旧）
  // ===================
  conditionOptions = [
    { label: '大于', value: 1 },
    { label: '小于', value: 2 },
    { label: '等于', value: 3 }
  ];
  levelOptions = [
    { label: '低电平', value: 0 },
    { label: '高电平', value: 1 }
  ];

  // ===================
  // 界面状态
  // ===================
  selectedSidebar: 'device' | 'mqtt' | 'gpio' | 'serial' = 'device';
  selectedTabIndex = 0;
  private readonly tabIndexMap: ('device' | 'mqtt' | 'gpio' | 'serial')[] = ['device', 'mqtt', 'gpio', 'serial'];

  // ===================
  // 网络/MQTT 信息
  // ===================
  wifiInfo: { status?: number; ssid?: string; ip?: string; rssi?: number } = {};
  mqttInfo: { status?: number; host?: string; port?: number; clientId?: string; pub?: string; sub?: string } = {};

  // ===================
  // 网络配置表单
  // ===================
  wifiConfigForm = {
    ssid: '',
    password: '',
    security: 0 // 0=auto, 4=WPA2
  };

  mqttConfigForm = {
    enabled: false,
    mode: 'custom', // 'custom' | 'default'
    host: '',
    port: 1883,
    clientId: '',
    username: '',
    password: '',
    autoConnect: false
  };

  showWifiPassword = false;
  showMqttPassword = false;

  mqttModeOptions = [
    { label: '自定义模式', value: 'custom' },
    { label: '默认模式', value: 'default' }
  ];

  wifiSecurityOptions = [
    { label: 'AUTO', value: 0 },
    { label: 'NONE', value: 1 },
    { label: 'WEP', value: 2 },
    { label: 'WPA1_WPA2', value: 3 },
    { label: 'WPA2_WPA3', value: 4 },
    { label: 'WPA3', value: 5 }
  ];

  // ===================
  // 订阅管理
  // ===================
  private subscriptions: Subscription[] = [];
  private confidenceSubject: Subject<number> = new Subject<number>();
  private iouSubject: Subject<number> = new Subject<number>();

  constructor(
    private atService: SSCMACommandService,
    private serialService: SerialService,
    private message: NzMessageService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private electronService: ElectronService
  ) { }

  // ===================
  // 生命周期
  // ===================

  async ngOnInit(): Promise<void> {
    // 根据路由判断是否显示框架
    // /model-deploy/sscma/test -> showFrame = true (独立窗口)
    // /model-deploy/sscma/config -> showFrame = false (嵌入在容器中)
    const url = this.router.url;
    if (url.includes('/test')) {
      this.showFrame = true;
    } else if (url.includes('/config')) {
      this.showFrame = false;
    }
    // 如果通过 @Input 显式设置了 showFrame，则不覆盖

    this.initializePort();
    this.subscribeToConnectionState();
    this.subscribeToInvokeResults();
    this.initializeTransportMenu();
    // debounce slider changes: only send AT commands after user stops dragging
    this.subscriptions.push(
      this.confidenceSubject.pipe(debounceTime(600)).subscribe(async (value) => {
        // Skip if not connected (user might be adjusting UI before connecting)
        if (!this.isConnected) {
          return;
        }

        try {
          await this.atService.setScoreThreshold(value);
          this.scoreThreshold = value;
          // console.log('置信度已设置为:', value);
          // Success feedback (subtle, no blocking notification)
        } catch (error) {
          console.error('设置置信度失败:', error);
          this.message.error('设置置信度失败');
          // Revert UI to last known good value on error
          this.confidenceThreshold = this.scoreThreshold;
          this.cdr.detectChanges();
        }
      })
    );

    this.subscriptions.push(
      this.iouSubject.pipe(debounceTime(600)).subscribe(async (value) => {
        // Skip if not connected
        if (!this.isConnected) {
          return;
        }

        try {
          await this.atService.setIouThreshold(value);
          this.iouThreshold = value;
          // console.log('IOU阈值已设置为:', value);
        } catch (error) {
          console.error('设置IOU阈值失败:', error);
          this.message.error('设置IOU阈值失败');
          // Revert UI to last known good value on error
          this.iouThreshold = await this.atService.getIouThreshold().catch(() => this.iouThreshold);
          this.cdr.detectChanges();
        }
      })
    );

    // 检查是否从部署页面自动跳转过来，需要自动连接设备
    const autoConnect = localStorage.getItem('auto_connect_after_deploy');
    if (autoConnect === 'true') {
      localStorage.removeItem('auto_connect_after_deploy');
      // 延迟执行，确保组件完全初始化
      setTimeout(() => {
        this.connectToDevice();
      }, 500);
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['portPath'] && !changes['portPath'].isFirstChange()) {
      const newPath = changes['portPath'].currentValue as string | undefined;
      if (newPath) {
        this.currentPort = newPath;
      }
    }
  }

  // ===================
  // 初始化方法
  // ===================

  private async initializePort(): Promise<void> {
    // 优先级：@Input > serialService > localStorage
    let portToCheck: string | undefined;

    if (this.portPath) {
      portToCheck = this.portPath;
    } else if (this.serialService.currentPort) {
      portToCheck = this.serialService.currentPort;
    } else {
      // 尝试从 localStorage 读取（独立页面模式）
      const storedPort = localStorage.getItem('current_model_deploy_port');
      if (storedPort) {
        portToCheck = storedPort;
      }
    }

    // 验证串口是否仍然可用
    if (portToCheck) {
      try {
        const ports = await this.serialService.getSerialPorts();
        const portExists = ports.some(p => p.name === portToCheck);

        if (portExists) {
          this.currentPort = portToCheck;
        } else {
          // 存储的串口不再可用，清除它
          this.currentPort = undefined;
          console.warn('存储的串口不再可用:', portToCheck);
        }
      } catch (error) {
        console.warn('验证串口时出错:', error);
        this.currentPort = undefined;
      }
    }
  }

  private subscribeToConnectionState(): void {
    this.subscriptions.push(
      this.atService.isConnected$.subscribe(connected => {
        this.isConnected = connected;
        if (!connected) {
          this.isPreviewMode = false;
          this.previewImage = null;
        }
        // 连接状态变化时不自动加载配置，由 connectToDevice 统一处理
      })
    );
  }

  private subscribeToInvokeResults(): void {
    this.subscriptions.push(
      this.atService.responseReceived$.subscribe(response => {
        if (response.type === 1 && response.name === 'INVOKE') {
          this.handleInvokeResult(response);
        }
      })
    );
  }

  private initializeTransportMenu(): void {
    this.transportMenuList = [
      { name: '1', text: 'UART(USB)', value: 1 },
      { name: '2', text: 'UART(GPIO)', value: 2 },
      { name: '3', text: 'SPI', value: 3 },
      { name: '4', text: 'I2C', value: 4 },
      { name: '5', text: 'MQTT', value: 5 }
    ];
  }

  private async cleanup(): Promise<void> {
    this.subscriptions.forEach(sub => sub.unsubscribe());

    // Complete subjects to prevent memory leaks
    this.confidenceSubject.complete();
    this.iouSubject.complete();

    if (this.isPreviewMode) {
      await this.stopPreview().catch(console.error);
    }

    if (this.isConnected) {
      await this.disconnect().catch(console.error);
    }
  }

  // ===================
  // 串口管理
  // ===================

  openPortList(el: any): void {
    const rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.getDevicePortList();
    this.showPortList = true;
  }

  async getDevicePortList(): Promise<void> {
    const ports = await this.serialService.getSerialPorts();
    if (ports && ports.length > 0) {
      this.portList = ports;
    } else {
      this.portList = [{
        name: 'Device not found',
        text: '',
        type: 'serial',
        icon: 'fa-light fa-triangle-exclamation',
        disabled: true,
      }];
    }
  }

  closePortList(): void {
    this.showPortList = false;
    this.cdr.detectChanges();
  }

  selectPort(portItem: PortItem): void {
    this.currentPort = portItem.name;
    this.closePortList();
  }

  // ===================
  // 设备连接
  // ===================

  async connectToDevice(): Promise<void> {
    if (!this.currentPort) {
      this.message.warning('请先选择串口');
      return;
    }

    if (this.isConnected && this.atService['currentPortPath'] === this.currentPort) {
      this.message.info('设备已连接');
      return;
    }

    this.isConnecting = true;

    try {
      await this.atService.connect(this.currentPort);
      this.isConnecting = false;
      this.message.success('设备已连接');

      await this.delay(300);

      // 先加载设备信息和配置，完成后再启动预览
      this.isLoadingConfig = true;
      try {
        await this.loadDeviceConfig();
        await this.startPreview();
        await this.loadDeviceInfo();
        // 配置加载完成后启动预览
        await this.loadCurrentConfig();
      } catch (err) {
        console.warn('加载配置信息时发生部分错误:', err);
        // 即使配置加载失败，也尝试启动预览
        this.startPreview().catch(previewErr => {
          console.warn('启动预览失败:', previewErr);
        });
      } finally {
        this.isLoadingConfig = false;
      }
    } catch (error) {
      console.error('连接失败:', error);
      this.message.error('连接设备失败: ' + (error as Error).message);
      this.isConnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.atService.disconnect();
    } catch (error) {
      console.error('断开连接失败:', error);
    }
  }

  // ===================
  // 设备信息加载
  // ===================

  async loadDeviceConfig(): Promise<void> {
    try {
      await this.loadInfoFromDevice().catch(err => {
        console.warn('读取 AT+INFO? 失败:', err);
      })
      await this.loadTriggerRules().catch(err => {
        console.warn('加载触发规则失败:', err);
      });
    } catch (error) {
      console.error('加载设备配置失败:', error);
      throw error;
    }
  }

  async loadDeviceInfo(): Promise<void> {
    try {
      // 并行执行独立的设备信息查询命令，大幅提升加载速度
      const [id, name, version] = await Promise.all([
        this.atService.getDeviceId(),
        this.atService.getDeviceName(),
        this.atService.getVersion()
      ]);

      this.deviceInfo.id = id;
      this.deviceInfo.name = name;
      this.deviceInfo.version = version;

      // 字段兼容处理
      if (this.deviceInfo.id !== undefined) {
        this.deviceInfo.device_id = this.deviceInfo.id as any;
      }
      if (this.deviceInfo.name !== undefined) {
        this.deviceInfo.device_name = this.deviceInfo.name as any;
      }
      if (this.deviceInfo.version !== undefined) {
        this.deviceInfo.device_version = this.deviceInfo.version.software as any;
      }

      // console.log('设备信息:', this.deviceInfo);

      // 并行加载传输类型和模型信息
      // await Promise.all([
      //   this.loadDefaultTransport().catch(err => {
      //     console.warn('读取默认传输类型失败:', err);
      //   }),
      //   this.loadInfoFromDevice().catch(err => {
      //     console.warn('读取 AT+INFO? 失败:', err);
      //   })
      // ]);

      // 重置滚动位置到顶部,避免自动滚动到底部的设置区域
      setTimeout(() => {
        if (this.rightPanelRef?.nativeElement) {
          this.rightPanelRef.nativeElement.scrollTop = 0;
        }
      }, 100);
    } catch (error) {
      console.error('获取设备信息失败:', error);
      this.message.warning('部分设备信息获取失败');
    }
  }

  async loadInfoFromDevice(): Promise<void> {
    try {
      const resp = await this.atService.sendCommand('AT+INFO?');
      if (!resp || resp.code !== 0) {
        console.warn('AT+INFO? 返回非 0 code', resp);
        return;
      }

      const data = resp.data as any;
      let infoVal: string | null = null;

      if (data) {
        if (typeof data === 'string') {
          infoVal = data;
        } else if (data.info) {
          infoVal = String(data.info);
        }
      }

      this.infoRaw = infoVal;

      if (infoVal) {
        let decoded = this.decodeBase64IfNeeded(infoVal);
        this.infoDecoded = decoded;
        // console.log('Decoded AT+INFO? info:', decoded);

        this.parseModelMetadata(decoded);
      }

      this.cdr.detectChanges();
    } catch (error) {
      console.error('loadInfoFromDevice error:', error);
      throw error;
    }
  }

  private decodeBase64IfNeeded(input: string): string {
    const isBase64Like = /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(input.trim()) &&
      (input.length % 4 === 0 || input.endsWith('==') || input.endsWith('='));

    if (isBase64Like) {
      try {
        return atob(input.replace(/\r|\n/g, ''));
      } catch (e) {
        return input;
      }
    }

    return input;
  }

  private parseModelMetadata(decoded: string): void {
    try {   

      // AT+INFO?
      // {"type":0,"name":"INFO?","code":0,"data":{"info":"eyJtb2RlbF9pZCI6IjYwNzY4IiwidmVyc2lvbiI6IjEuMC4wIiwiYXJndW1lbnRzIjp7InNpemUiOjY3Ny4yOSwidXJsIjoiaHR0cHM6Ly9zZW5zZWNyYWZ0LXN0YXRpY3Muc2VlZWQuY2MvcmVmZXIvbW9kZWwvMTcyNjczNTcyMjEwOF9kcjVJczJfbW9iaWxlbmV0djJfMC4zNXJlcF92d3c2NF9pbnQ4X3NoYTFfYTkzOTQwN2Q1MDdiNDVjZWNhMjkzZTc0Yzg5NjFkNTkzNTdiMzdiMi50ZmxpdGUiLCJpY29uIjoiaHR0cHM6Ly9zZW5zZWNyYWZ0LXN0YXRpY3Muc2VlZWQuY2MvcmVmZXIvcGljLzE3MjY3MzU2MTE0OTFfNlpxeWNoX3BlcnNvbl9jbHMucG5nIiwidGFzayI6ImNsYXNzaWZ5IiwiY3JlYXRlZEF0IjoxNzI2NzM1NzY5LCJ1cGRhdGVkQXQiOjE3NDU4MTk4MTgsImlvdSI6IjAiLCJjb25mIjoiMCJ9LCJtb2RlbF9uYW1lIjoiUGVyc29uIENsYXNzaWZpY2F0aW9uIiwibW9kZWxfZm9ybWF0IjoidGZMaXRlIiwiYWlfZnJhbXdvcmsiOiI0IiwiYXV0aG9yIjoiU2Vuc2VDcmFmdCBBSSIsImNsYXNzZXMiOlsiTm90IGEgcGVyc29uIiwiUGVyc29uIl0sImNoZWNrc3VtIjoiMTc5MWM5NmFjMjk0MDg1YWJkMjMwZDEzYjQwODM4NDIifQ=="}}
      // base64解码
      // {"model_id":"60768","version":"1.0.0","arguments":{"size":677.29,"url":"https://sensecraft-statics.seeed.cc/refer/model/1726735722108_dr5Is2_mobilenetv2_0.35rep_vww64_int8_sha1_a939407d507b45ceca293e74c8961d59357b37b2.tflite","icon":"https://sensecraft-statics.seeed.cc/refer/pic/1726735611491_6Zqych_person_cls.png","task":"classify","createdAt":1726735769,"updatedAt":1745819818,"iou":"0","conf":"0"},"model_name":"Person Classification","model_format":"tfLite","ai_framwork":"4","author":"SenseCraft AI","classes":["Not a person","Person"],"checksum":"1791c96ac294085abd230d13b4083842"}
      // console.log('设备信息:', this.deviceInfo);
      // modelMeta?.classes

      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object') {
        // 模型名称和版本
        if (parsed.model_name) this.modelMeta.name = parsed.model_name;
        if (!this.modelMeta.name && parsed.name) this.modelMeta.name = parsed.name;
        if (parsed.model_version) this.modelMeta.version = parsed.model_version;
        if (!this.modelMeta.version && parsed.version) this.modelMeta.version = parsed.version;

        // 参数解析
        if (parsed.arguments && typeof parsed.arguments === 'object') {
          const args: any = parsed.arguments;
          if (args.icon && !this.modelMeta.pic_url) this.modelMeta.pic_url = args.icon;
          if (args.url && !this.modelMeta.pic_url) this.modelMeta.pic_url = args.url;

          if (typeof args.size === 'number' || typeof args.size === 'string') {
            const sizeNum = Number(args.size);
            if (!isNaN(sizeNum)) {
              this.modelInfo.size = Math.round(sizeNum * 1024);
            }
          }
        }

        // 模型 ID
        if (parsed.model_id && !this.modelInfo.id) {
          const mid = Number(parsed.model_id);
          if (!isNaN(mid)) this.modelInfo.id = mid;
        }

        // 类别列表
        if (Array.isArray(parsed.classes)) {
          (this.modelMeta as any).classes = parsed.classes;
          // 初始化类别触发配置
          this.initClassTriggerConfigs();
        }

        // 图片 URL
        if (!this.modelMeta.pic_url && parsed.pic_url) {
          this.modelMeta.pic_url = parsed.pic_url;
        }
      }
    } catch (err) {
      // 解析失败不影响流程
    }
  }

  // ===================
  // 配置加载
  // ===================

  async loadCurrentConfig(): Promise<void> {
    try {
      // 并行执行所有配置查询命令，大幅提升加载速度
      const [modelInfo, sensorInfo, scoreThreshold, iouThreshold] = await Promise.all([
        this.atService.getCurrentModel(),
        this.atService.getCurrentSensor(),
        this.atService.getScoreThreshold(),
        this.atService.getIouThreshold()
      ]);

      this.modelInfo = modelInfo;
      this.sensorInfo = sensorInfo;
      this.scoreThreshold = scoreThreshold;
      this.iouThreshold = iouThreshold;

      // 同步到置信度显示值
      this.confidenceThreshold = this.scoreThreshold;

      // 加载 GPIO 触发规则（可能依赖类别信息，所以不并行）
      await this.loadTriggerRules().catch(err => {
        console.warn('加载触发规则失败:', err);
      });

      // console.log('当前配置:', {
      //   model: this.modelInfo,
      //   sensor: this.sensorInfo,
      //   score: this.scoreThreshold,
      //   iou: this.iouThreshold
      // });

      this.message.success('配置信息加载完成');
      this.cdr.detectChanges();
    } catch (error) {
      console.error('获取配置失败:', error);
      this.message.warning('部分配置信息获取失败');
    }
  }

  // ===================
  // 传输类型管理
  // ===================

  openTransportList(el: any): void {
    const rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.showTransportList = true;
  }

  closeTransportList(): void {
    this.showTransportList = false;
    this.cdr.detectChanges();
  }

  async selectTransport(item: any): Promise<void> {
    const val = item && (item.value ?? Number(item.name));
    if (!val && val !== 0) return;

    const old = this.currentTransport;
    this.currentTransport = Number(val);
    this.currentTransportName = item.text || String(val);
    this.showTransportList = false;

    try {
      const res = await this.atService.setDefaultTransport(Number(val));
      this.message.success('默认传输类型已设置: ' + (item.text || res));
    } catch (err) {
      this.message.error('设置默认传输类型失败');
      this.currentTransport = old;
      await this.loadDefaultTransport().catch(() => { });
    }
  }

  async loadDefaultTransport(): Promise<void> {
    try {
      const t = await this.atService.getDefaultTransport();
      this.currentTransport = Number(t);
      const found = this.transportMenuList.find(x =>
        Number(x.value) === Number(t) || Number(x.name) === Number(t)
      );
      this.currentTransportName = found ? found.text : String(t);
      this.cdr.detectChanges();
    } catch (err) {
      console.warn('loadDefaultTransport error:', err);
    }
  }

  // ===================
  // 预览管理
  // ===================

  async startPreview(): Promise<void> {
    if (!this.isConnected) {
      this.message.warning('请先连接设备');
      return;
    }

    try {
      this.isPreviewMode = true;
      this.previewImage = null;
      this.previewImageUrl = null;
      this.imageVersion = 0;
      this.resultCount = 0;

      await this.atService.startInvoke(-1, 0, 0);
      this.message.success('预览已启动');
    } catch (error) {
      console.error('启动预览失败:', error);
      this.isPreviewMode = false;
      this.message.error('启动预览失败: ' + (error as Error).message);
    }
  }

  async stopPreview(): Promise<void> {
    try {
      await this.atService.stopAllTasks();
      this.isPreviewMode = false;
      this.message.success('预览已停止');
    } catch (error) {
      console.error('停止预览失败:', error);
      this.message.error('停止预览失败: ' + (error as Error).message);
    }
  }

  // ===================
  // 推理结果处理
  // ===================

  private handleInvokeResult(response: AtResponse): void {
    const result = response.data as InvokeResultData;

    // console.log('[预览] 收到推理结果:', {
    //   hasImage: !!result.image,
    //   isPreviewMode: this.isPreviewMode,
    //   responseType: response.type,
    //   responseName: response.name
    // });

    if (this.isPreviewMode && result.image) {
      if (result.boxes && Array.isArray(result.boxes)) {
        // 保存 boxes，等待图片更新后绘制
        console.log('[预览] 收到检测框数据:', result.boxes);
        try {
          this.currentBoxes = result.boxes as number[][];
        } catch (e) {
          this.currentBoxes = [];
        }
      } else {
        this.currentBoxes = [];
      }
      this.updatePreviewImage(result);
      // 触发一次绘制（图片 load 事件会再次触发 onPreviewImageLoad）
      setTimeout(() => this.onPreviewImageLoad(), 20);
    } else if (!result.image) {
      console.warn('[预览] 结果中没有图片数据');
    }

    this.invokeResults.unshift(result);
    if (this.invokeResults.length > 20) {
      this.invokeResults.pop();
    }

    this.resultCount++;
    this.updateClassScoresFromResult(result);
  }

  private updatePreviewImage(result: InvokeResultData): void {
    this.previewImage = result.image!;
    this.previewImageUrl = `data:image/jpeg;base64,${result.image}`;
    this.imageVersion++;
    this.lastUpdateTime = new Date().toLocaleTimeString();

    // console.log('[预览] 更新图片:', {
    //   frameCount: result.count,
    //   imageLength: result.image?.length,
    //   imageVersion: this.imageVersion,
    //   timestamp: this.lastUpdateTime
    // });

    this.cdr.detectChanges();
  }

  // 图片加载后触发，绘制检测框
  onPreviewImageLoad(): void {
    const img = this.previewImgRef?.nativeElement;
    const canvas = this.overlayCanvasRef?.nativeElement;
    if (!img || !canvas) return;

    const rect = img.getBoundingClientRect();
    const displayW = rect.width;
    const displayH = rect.height;
    const dpr = window.devicePixelRatio || 1;

    // set canvas physical size
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    // set CSS size
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // clear previous
    ctx.clearRect(0, 0, displayW, displayH);

    if (this.currentBoxes && this.currentBoxes.length > 0) {
      // compute scaling from image natural size to displayed size
      const naturalW = img.naturalWidth || displayW;
      const naturalH = img.naturalHeight || displayH;
      const scaleX = naturalW > 0 ? displayW / naturalW : 1;
      const scaleY = naturalH > 0 ? displayH / naturalH : 1;

      this.drawBoxes(this.currentBoxes, ctx, scaleX, scaleY);
    }
  }

  // 绘制检测框 boxes: [x,y,w,h,score,targetId]
  private drawBoxes(boxes: number[][], ctx: CanvasRenderingContext2D, scaleX = 1, scaleY = 1): void {
    if (!boxes || boxes.length === 0) return;

    const displayW = Number(ctx.canvas.style.width.replace('px', '')) || ctx.canvas.width;
    const displayH = Number(ctx.canvas.style.height.replace('px', '')) || ctx.canvas.height;

    const boxLineWidth = Math.max(2, Math.round(Math.max(displayW, displayH) * 0.002));
    const fontSize = Math.max(12, Math.round(displayW * 0.03));
    ctx.lineWidth = boxLineWidth;
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textBaseline = 'top';

    for (const b of boxes) {
      if (!Array.isArray(b) || b.length < 6) continue;
      const x = Number(b[0] - b[2] / 2) * scaleX;
      const y = Number(b[1] - b[3] / 2) * scaleY;
      const w = Number(b[2]) * scaleX;
      const h = Number(b[3]) * scaleY;
      const scoreRaw = Number(b[4]) || 0;
      const targetId = Number(b[5]) || 0;

      const className = (this.modelMeta && Array.isArray(this.modelMeta.classes) && this.modelMeta.classes[targetId])
        ? this.modelMeta.classes[targetId]
        : `id:${targetId}`;

      const color = this.colorForId(targetId);

      // rectangle
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = boxLineWidth;
      ctx.strokeRect(x, y, w, h);

      // label
      const scorePercent = this.normalizeScoreToPercent(scoreRaw);
      const label = `${className}:${scorePercent}`;
      const padding = 6;
      const textMetrics = ctx.measureText(label);
      const textW = Math.ceil(textMetrics.width);
      const textH = Math.ceil(fontSize * 1.2);

      // label background: prefer above box, fallback inside
      let labelX = x;
      let labelY = y - textH - padding;
      if (labelY < 0) labelY = y + 4;

      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.fillRect(labelX - 1, labelY - 1, textW + padding * 2, textH + padding);
      ctx.globalAlpha = 1.0;

      ctx.fillStyle = this.contrastColor(color);
      ctx.fillText(label, labelX + padding, labelY + (padding / 4));
    }
  }

  private colorForId(id: number): string {
    const palette = [
      '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
      '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
      '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000'
    ];
    return palette[Math.abs(id) % palette.length];
  }

  private contrastColor(hexColor: string): string {
    const c = (hexColor || '#000000').replace('#', '');
    const r = parseInt(c.substring(0, 2), 16) || 0;
    const g = parseInt(c.substring(2, 4), 16) || 0;
    const b = parseInt(c.substring(4, 6), 16) || 0;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? 'black' : 'white';
  }

  private updateClassScoresFromResult(result: InvokeResultData): void {
    const labels: string[] = (this.modelMeta as any).classes || [];
    if (!labels || labels.length === 0) {
      this.classScores = [];
      return;
    }

    const scores = new Array(labels.length).fill(0);

    if (result && result.classes && Array.isArray(result.classes)) {
      const first = result.classes[0];
      if (Array.isArray(first)) {
        // 结构: [[score, target_id], ...]
        for (const entry of result.classes as number[][]) {
          if (!Array.isArray(entry) || entry.length === 0) continue;
          const score = Number(entry[0]);
          const id = entry.length > 1 ? Number(entry[1]) : undefined;
          if (!isNaN(score) && typeof id === 'number' && id >= 0 && id < scores.length) {
            scores[id] = this.normalizeScoreToPercent(score);
          }
        }
      } else {
        // 结构: [score0, score1, score2, ...]
        for (let i = 0; i < (result.classes as any[]).length && i < scores.length; i++) {
          const v = Number((result.classes as any[])[i]);
          if (!isNaN(v)) scores[i] = this.normalizeScoreToPercent(v);
        }
      }
      this.classScores = scores;
      this.cdr.detectChanges();
    } else {
      this.classScores = [];
      this.cdr.detectChanges();
    }
  }

  private normalizeScoreToPercent(raw: number): number {
    if (raw <= 1) {
      return Math.round(raw * 100);
    }
    if (raw > 1 && raw <= 100) {
      return Math.round(raw);
    }
    return Math.round(Math.max(0, Math.min(100, raw)));
  }

  getBarBackground(index: number): string {
    const c = this.barColors[index % this.barColors.length] || this.barColors[0];
    return `linear-gradient(90deg, ${c}, ${c}CC)`;
  }

  // ===================
  // 配置调整
  // ===================

  /**
   * 置信度变化处理（实时设置）
   */
  onConfidenceChange(value: number): void {
    // update UI immediately, but debounce the AT command
    this.confidenceThreshold = value;
    this.confidenceSubject.next(value);
  }

  /**
   * IOU阈值变化处理（实时设置）
   */
  onIouChange(value: number): void {
    this.iouThreshold = value;
    this.iouSubject.next(value);
  }

  async applyScoreThreshold(): Promise<void> {
    try {
      const newValue = await this.atService.setScoreThreshold(this.scoreThreshold);
      this.message.success(`分数阈值已设置为: ${newValue}`);
    } catch (error) {
      console.error('设置分数阈值失败:', error);
      this.message.error('设置失败: ' + (error as Error).message);
    }
  }

  async applyIouThreshold(): Promise<void> {
    try {
      const newValue = await this.atService.setIouThreshold(this.iouThreshold);
      this.message.success(`IoU 阈值已设置为: ${newValue}`);
    } catch (error) {
      console.error('设置 IoU 阈值失败:', error);
      this.message.error('设置失败: ' + (error as Error).message);
    }
  }

  // ===================
  // 推理操作
  // ===================

  async startInvoke(): Promise<void> {
    if (!this.isConnected) {
      this.message.warning('请先连接设备');
      return;
    }

    try {
      this.isInvoking = true;
      this.invokeResults = [];
      this.resultCount = 0;

      await this.atService.startInvoke(-1, 0, 0);
      this.message.success('推理已启动');
    } catch (error) {
      console.error('启动推理失败:', error);
      this.isInvoking = false;
      this.message.error('启动推理失败: ' + (error as Error).message);
    }
  }

  async stopInvoke(): Promise<void> {
    try {
      await this.atService.stopAllTasks();
      this.isInvoking = false;
      this.message.success('推理已停止');
    } catch (error) {
      console.error('停止推理失败:', error);
      this.message.error('停止推理失败: ' + (error as Error).message);
    }
  }

  // ===================
  // 其他操作
  // ===================

  async refreshConfig(): Promise<void> {
    if (!this.isConnected) {
      await this.connectToDevice();
      if (this.isConnected) {
        await this.loadDeviceInfo();
        await this.loadCurrentConfig();
      }
    } else {
      await this.loadCurrentConfig();
    }
  }

  async rebootDevice(): Promise<void> {
    try {
      await this.atService.reboot();
      this.message.success('设备正在重启...');

      setTimeout(async () => {
        await this.connectToDevice();
        if (this.isConnected) {
          await this.loadDeviceInfo();
          await this.loadCurrentConfig();
        }
      }, 5000);
    } catch (error) {
      console.error('重启设备失败:', error);
      this.message.error('重启失败: ' + (error as Error).message);
    }
  }

  // ===================
  // GPIO 动作规则管理
  // ===================

  addTriggerRule(): void {
    const newRule: TriggerRule = {
      id: this.nextTriggerId++,
      classId: 0,
      condition: 2, // >= 
      threshold: 50,
      gpio: 1,
      initLevel: 0,
      triggerLevel: 1
    };
    this.triggerRules.push(newRule);
  }

  deleteTriggerRule(ruleId: number): void {
    this.triggerRules = this.triggerRules.filter(r => r.id !== ruleId);
  }

  /**
   * 初始化类别触发配置（当模型元数据加载后调用）
   */
  initClassTriggerConfigs(): void {
    if (!this.modelMeta.classes || this.modelMeta.classes.length === 0) {
      this.classTriggerConfigs = [];
      return;
    }
    
    // 为每个类别创建默认配置
    this.classTriggerConfigs = this.modelMeta.classes.map((_, index) => ({
      classId: index,
      threshold: 50,        // 默认50%置信度
      gpio: null,           // 默认未选择引脚
      levelMode: null       // 默认未选择电平模式
    }));
  }

  /**
   * 构建 AT+TRIGGER 规则字符串（从简化配置）
   * 格式: "CLASS_ID,CONDITION,SCORE_THRESHOLD,GPIO_PIN,INITIAL_LEVEL,TRIGGER_LEVEL"
   * 示例: "0,2,50,1,0,1" (类别0, >=, 50分, GPIO1, 初始低, 触发高)
   */
  private buildTriggerRuleString(rule: TriggerRule): string {
    return `${rule.classId},${rule.condition},${rule.threshold},${rule.gpio},${rule.initLevel},${rule.triggerLevel}`;
  }

  /**
   * 从简化配置构建单条规则字符串
   */
  private buildTriggerRuleFromConfig(config: ClassTriggerConfig): string | null {
    // 如果未配置GPIO或电平模式，则跳过
    if (config.gpio === null || config.levelMode === null) {
      return null;
    }
    
    // condition: 2 = >=（大于等于）
    const condition = 2;
    // levelMode: 'high' = 默认低触发高 (initLevel=0, triggerLevel=1)
    // levelMode: 'low' = 默认高触发低 (initLevel=1, triggerLevel=0)
    const initLevel = config.levelMode === 'high' ? 0 : 1;
    const triggerLevel = config.levelMode === 'high' ? 1 : 0;
    
    return `${config.classId},${condition},${config.threshold},${config.gpio},${initLevel},${triggerLevel}`;
  }

  /**
   * 合并所有规则为 AT+TRIGGER 格式字符串
   * 多规则之间用 | 分隔
   */
  private buildCombinedTriggerRules(): string {
    // 优先使用简化配置
    if (this.classTriggerConfigs.length > 0) {
      const rules = this.classTriggerConfigs
        .map(config => this.buildTriggerRuleFromConfig(config))
        .filter(rule => rule !== null) as string[];
      
      if (rules.length > 0) {
        return rules.join('|');
      }
    }
    
    // 回退到旧的 triggerRules（兼容）
    if (this.triggerRules.length === 0) {
      return '';
    }

    return this.triggerRules.map(rule => this.buildTriggerRuleString(rule)).join('|');
  }

  /**
   * 应用 GPIO 触发规则到设备
   */
  async applyTriggerRules(): Promise<void> {
    if (!this.isConnected) {
      this.message.warning('请先连接设备');
      return;
    }

    // 检查是否有有效的触发配置
    const hasValidConfig = this.classTriggerConfigs.some(
      config => config.gpio !== null && config.levelMode !== null
    );
    
    if (!hasValidConfig && this.triggerRules.length === 0) {
      this.message.warning('请先配置至少一个类别的 GPIO 触发规则');
      return;
    }

    try {
      const rulesString = this.buildCombinedTriggerRules();
      
      if (!rulesString) {
        this.message.warning('没有有效的触发规则');
        return;
      }
      
      console.log('发送 AT+TRIGGER 规则:', rulesString);

      const response = await this.atService.sendCommand(`AT+TRIGGER="${rulesString}"`);

      if (response && response.code === 0) {
        this.message.success('GPIO 触发规则已应用');
      } else {
        this.message.error('应用规则失败: ' + (response?.data || '未知错误'));
      }
    } catch (error) {
      console.error('应用 GPIO 触发规则失败:', error);
      this.message.error('应用规则失败: ' + (error as Error).message);
    }
  }

  /**
   * 从设备加载当前的 GPIO 触发规则
   */
  async loadTriggerRules(): Promise<void> {
    if (!this.isConnected) {
      this.message.warning('请先连接设备');
      return;
    }

    try {
      const response = await this.atService.sendCommand('AT+TRIGGER?');

      if (response && response.code === 0) {
        const data = response.data as any;
        const rulesString = data?.trigger_rules || '';
        // console.log('当前 AT+TRIGGER 规则:', rulesString);

        if (rulesString && rulesString.trim()) {
          // 解析规则字符串并填充到 classTriggerConfigs
          this.parseTriggerRulesString(rulesString);
        } else {
          // 设备未设置规则，保持默认空值状态
          console.log('设备未设置 GPIO 触发规则');
        }
      }
    } catch (error) {
      console.error('加载 GPIO 触发规则失败:', error);
      // 静默失败，不显示错误消息
    }
  }

  /**
   * 解析 AT+TRIGGER 规则字符串并填充到 classTriggerConfigs
   * 格式: "CLASS_ID,CONDITION,THRESHOLD,GPIO,INIT_LEVEL,TRIGGER_LEVEL"
   * 多规则用 | 分隔，例如: "0,2,50,1,0,1|1,2,60,2,0,1"
   */
  private parseTriggerRulesString(rulesString: string): void {
    if (!rulesString || !rulesString.trim()) return;

    const rules = rulesString.split('|');
    
    for (const ruleStr of rules) {
      const parts = ruleStr.split(',').map(p => p.trim());
      if (parts.length < 6) continue;

      const classId = parseInt(parts[0], 10);
      // const condition = parseInt(parts[1], 10); // 暂不使用，简化版固定为 >= (2)
      const threshold = parseInt(parts[2], 10);
      const gpio = parseInt(parts[3], 10);
      const initLevel = parseInt(parts[4], 10);
      const triggerLevel = parseInt(parts[5], 10);

      // 找到对应的 classTriggerConfig 并更新
      const config = this.classTriggerConfigs.find(c => c.classId === classId);
      if (config) {
        config.threshold = threshold;
        config.gpio = gpio;
        // 根据电平判断模式: initLevel=0, triggerLevel=1 -> 'high'; initLevel=1, triggerLevel=0 -> 'low'
        if (initLevel === 0 && triggerLevel === 1) {
          config.levelMode = 'high';
        } else if (initLevel === 1 && triggerLevel === 0) {
          config.levelMode = 'low';
        } else {
          // 其他情况默认 high
          config.levelMode = 'high';
        }
      }
    }

    this.cdr.detectChanges();
  }

  selectSidebar(name: 'device' | 'mqtt' | 'gpio' | 'serial'): void {
    this.selectedSidebar = name;
    this.selectedTabIndex = this.tabIndexMap.indexOf(name);
    if (name === 'mqtt' && this.isConnected) {
      // 仅在已连接时才自动加载网络信息
      setTimeout(() => {
        this.loadNetworkInfo().catch(err => {
          console.warn('加载网络信息失败:', err);
        });
      }, 80);
    }
  }

  onTabChange(index: number): void {
    const name = this.tabIndexMap[index];
    if (name) {
      this.selectSidebar(name);
    }
  }

  /**
   * 加载设备上的 WiFi / MQTT 状态
   */
  async loadNetworkInfo(): Promise<void> {
    if (!this.isConnected) {
      // 静默返回，不显示警告
      return;
    }

    try {
      // 查询 WiFi 状态
      const wifiResp = await this.atService.sendCommand('AT+WIFI?');
      if (wifiResp && wifiResp.code === 0) {
        const d: any = wifiResp.data || {};
        this.wifiInfo.status = d.status ?? d.state ?? this.wifiInfo.status;
        this.wifiInfo.ssid = d.ssid || d.name || this.wifiInfo.ssid;
        this.wifiInfo.ip = d.ip || this.wifiInfo.ip || '';
        this.wifiInfo.rssi = d.rssi ?? this.wifiInfo.rssi;
      }

      // 查询 MQTT Server 状态
      const mqttResp = await this.atService.sendCommand('AT+MQTTSERVER?');
      if (mqttResp && mqttResp.code === 0) {
        const m: any = mqttResp.data || {};
        this.mqttInfo.status = m.status ?? this.mqttInfo.status;
        this.mqttInfo.host = m.host || m.server || this.mqttInfo.host;
        this.mqttInfo.port = m.port ?? this.mqttInfo.port;
        this.mqttInfo.clientId = m.client_id || m.clientId || this.mqttInfo.clientId;
      }

      // 查询发布/订阅主题（如果可用）
      try {
        const ps = await this.atService.sendCommand('AT+MQTTPUBSUB?');
        if (ps && ps.code === 0) {
          const p: any = ps.data || {};
          this.mqttInfo.pub = p.pub || p.pub_topic || this.mqttInfo.pub;
          this.mqttInfo.sub = p.sub || p.sub_topic || this.mqttInfo.sub;
        }
      } catch (e) {
        // 非致命：有些固件可能没有此命令
      }

      this.cdr.detectChanges();

      // 重置滚动位置到顶部
      setTimeout(() => {
        if (this.rightPanelRef?.nativeElement) {
          this.rightPanelRef.nativeElement.scrollTop = 0;
        }
      }, 0);
    } catch (error) {
      console.error('loadNetworkInfo error:', error);
      this.message.error('加载网络信息失败');
      throw error;
    }
  }

  /**
   * 应用 WiFi 配置
   */
  async applyWifiConfig(): Promise<void> {
    if (!this.isConnected) {
      this.message.warning('请先连接设备');
      return;
    }

    if (!this.wifiConfigForm.ssid || !this.wifiConfigForm.ssid.trim()) {
      this.message.warning('请输入无线网络名称');
      return;
    }

    try {
      const cmd = `AT+WIFI="${this.wifiConfigForm.ssid}",${this.wifiConfigForm.security},"${this.wifiConfigForm.password || ''}"`;
      // console.log('应用 WiFi 配置:', cmd);

      const response = await this.atService.sendCommand(cmd);

      if (response && response.code === 0) {
        this.message.success('WiFi 配置已应用，设备将尝试连接');
        // 延迟刷新状态
        setTimeout(() => {
          this.loadNetworkInfo().catch(console.error);
        }, 3000);
      } else {
        this.message.error('应用 WiFi 配置失败: ' + (response?.data || '未知错误'));
      }
    } catch (error) {
      console.error('应用 WiFi 配置失败:', error);
      this.message.error('应用配置失败: ' + (error as Error).message);
    }
  }

  /**
   * 应用 MQTT 配置
   */
  async applyMqttConfig(): Promise<void> {
    if (!this.isConnected) {
      this.message.warning('请先连接设备');
      return;
    }

    if (!this.mqttConfigForm.host || !this.mqttConfigForm.host.trim()) {
      this.message.warning('请输入 MQTT 服务器地址');
      return;
    }

    try {
      // 构建 MQTT 服务器配置命令
      const cmd = `AT+MQTTSERVER="${this.mqttConfigForm.host}",${this.mqttConfigForm.port},"${this.mqttConfigForm.clientId}","${this.mqttConfigForm.username || ''}","${this.mqttConfigForm.password || ''}"`;
      // console.log('应用 MQTT 配置:', cmd);

      const response = await this.atService.sendCommand(cmd);

      if (response && response.code === 0) {
        this.message.success('MQTT 配置已应用');
        // 刷新状态
        setTimeout(() => {
          this.loadNetworkInfo().catch(console.error);
        }, 1000);
      } else {
        this.message.error('应用 MQTT 配置失败: ' + (response?.data || '未知错误'));
      }
    } catch (error) {
      console.error('应用 MQTT 配置失败:', error);
      this.message.error('应用配置失败: ' + (error as Error).message);
    }
  }

  /**
   * 取消网络配置（重置表单）
   */
  cancelNetworkConfig(): void {
    this.wifiConfigForm = {
      ssid: '',
      password: '',
      security: 0
    };
    this.mqttConfigForm = {
      enabled: false,
      mode: 'custom',
      host: '',
      port: 1883,
      clientId: '',
      username: '',
      password: '',
      autoConnect: false
    };
    this.showWifiPassword = false;
    this.showMqttPassword = false;
  }

  completeConfig(): void {
    this.configComplete.emit();
  }

  backToDeployPage(): void {
    this.backToDeploy.emit();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  openDocumentation() {
    this.electronService.openUrl('https://github.com/Seeed-Studio/SSCMA-Micro/blob/main/docs/protocol/at-protocol-en_US.md');
  }
}
