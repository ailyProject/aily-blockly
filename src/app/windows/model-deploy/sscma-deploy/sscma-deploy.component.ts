import { ChangeDetectorRef, Component, Input, OnInit, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NzStepsModule } from 'ng-zorro-antd/steps';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { SubWindowComponent } from '../../../components/sub-window/sub-window.component';
import { ModelDetail } from '../../../tools/model-store/model-store.service';
import { ElectronService } from '../../../services/electron.service';
import { PortItem, SerialService } from '../../../services/serial.service';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FirmwareService, FirmwareType, XiaoType, FirmwareInfo, FlashFile } from '../../../services/firmware.service';
// import { EspLoaderService, ModelInfo } from '../../../services/esploader.service';
import { EsptoolPyService, EsptoolPackageInfo } from '../../../services/esptool-py.service';
// import { AtCommandService } from '../../../services/at-command.service';
import { SSCMACommandService } from '../../../services/sscma-command.service';
import { encode } from 'js-base64';
import {
  getDeployStepConfig,
  DeployStepConfig,
  SupportBoardInfo,
  getSupportedBoards,
  getTaskDescription,
  getModelFormatDescription,
  getPrecisionDescription,
  formatFileSize,
  getDeviceConnectionImage,
  getDeviceConnectionSteps,
  getAuthorLogo
} from '../../../tools/model-store/model-constants';
import { MenuComponent } from '../../../components/menu/menu.component';
import { SscmaConfigComponent } from '../sscma-config/sscma-config.component';
import { NotificationComponent } from '../../../components/notification/notification.component';
import { UiService } from '../../../services/ui.service';

/**
 * 模型信息
 */
export interface ModelInfo {
  model_id: string;
  version: string;
  arguments: any;
  model_name: string;
  model_format: string;
  ai_framwork: string;
  author: string;
  classes: string[];
  checksum: string;
}

/**
 * SSCMA 模型部署组件
 * 适用于 XIAO ESP32S3 (Vision/Audio/Vibration)
 */
@Component({
  selector: 'app-sscma-deploy',
  standalone: true,
  imports: [
    CommonModule,
    SubWindowComponent,
    TranslateModule,
    NzStepsModule,
    NzButtonModule,
    MenuComponent,
    SscmaConfigComponent,
    NotificationComponent
  ],
  templateUrl: './sscma-deploy.component.html',
  styleUrl: './sscma-deploy.component.scss'
})
export class SscmaDeployComponent implements OnInit {
  @Input() modelDetail!: ModelDetail;
  @Input() initialStep: number = 0;
  @Output() deployComplete = new EventEmitter<void>();
  @Output() deployError = new EventEmitter<Error>();

  deployStepConfig: DeployStepConfig | null = null;
  supportBoardInfo: SupportBoardInfo | null = null;
  currentStep = 0;
  currentPort: string | undefined;
  authorLogo: string | null = null;
  deviceConnectionImage: string | null = null;
  deviceConnectionSteps: string[] = [];

  // 固件和部署相关
  firmwareInfo: FirmwareInfo | null = null;
  isDeploying = false;
  deployProgress = 0;
  deployStatus = '';
  xiaoType: XiaoType = XiaoType.VISION;
  isCancelling = false;  // 正在取消标志
  esptoolPackage: EsptoolPackageInfo | null = null;  // esptool 包信息
  flashStreamId: string = '';  // 烧录流ID，用于取消
  currentFlashResult: { promise: Promise<{ success: boolean }>, streamIdPromise: Promise<string> } | null = null;  // 当前烧录操作

  // 串口选择列表相关 
  showPortList = false;
  portList: PortItem[] = [];
  boardKeywords: string[] = [];
  position = { x: 0, y: 0 };

  constructor(
    private sanitizer: DomSanitizer,
    private serialService: SerialService,
    private electronService: ElectronService,
    private cd: ChangeDetectorRef,
    private firmwareService: FirmwareService,
    // private espLoaderService: EspLoaderService,
    private esptoolPyService: EsptoolPyService,
    // private atCommandService: AtCommandService,
    private sscmaCommandService: SSCMACommandService,
    private router: Router,
    private route: ActivatedRoute,
    private uiService: UiService
  ) { }

  ngOnInit(): void {
    // 从 localStorage 读取模型数据（路由模式下需要）
    const storedData = localStorage.getItem('current_model_deploy');
    if (storedData) {
      try {
        this.modelDetail = JSON.parse(storedData);
      } catch (error) {
        console.error('解析模型数据失败:', error);
      }
    }

    // 从 localStorage 读取串口信息
    const storedPort = localStorage.getItem('current_model_deploy_port');
    if (storedPort) {
      this.currentPort = storedPort;
    }

    // 从路由参数获取步骤，如果没有则从 input 获取
    this.route.paramMap.subscribe(params => {
      const step = params.get('step');
      if (step) {
        // 根据路由参数设置步骤（2步流程）
        const stepMap: { [key: string]: number } = {
          'deploy': 0,  // 第一步：部署
          'config': 1   // 第二步：配置
        };
        this.currentStep = stepMap[step] ?? this.initialStep;
      } else {
        this.currentStep = this.initialStep;
      }
      this.cd.detectChanges();
    });

    // 从 serialService 获取当前串口
    if (this.serialService.currentPort) {
      this.currentPort = this.serialService.currentPort;
    }

    // 根据作者名称配置部署步骤
    if (this.modelDetail?.author_name) {
      this.deployStepConfig = getDeployStepConfig(this.modelDetail.author_name);
      // 缓存作者 logo
      this.authorLogo = getAuthorLogo(this.modelDetail.author_name);
    }

    // 缓存设备连接相关数据
    if (this.modelDetail?.uniform_types) {
      this.deviceConnectionImage = getDeviceConnectionImage(this.modelDetail.uniform_types);
      this.deviceConnectionSteps = getDeviceConnectionSteps(this.modelDetail.uniform_types) || [];
    }

    // 根据任务类型确定 XIAO 设备类型
    if (this.modelDetail?.task) {
      this.xiaoType = this.getXiaoTypeFromTask(this.modelDetail.task);
    }

    // 获取固件信息
    this.loadFirmwareInfo();

    // 检查并设置默认串口
    this.checkAndSetDefaultPort();

    // 检测 esptool
    this.checkEsptool();
  }

  /**
   * 检测并准备 esptool
   */
  private async checkEsptool() {
    try {
      // console.log('[Deploy] 正在检测 esptool...');
      this.esptoolPackage = await this.esptoolPyService.detectEsptool();

      if (this.esptoolPackage) {
        // console.log('[Deploy] esptool 已就绪:', this.esptoolPackage);
      } else {
        // console.log('[Deploy] esptool 未安装，将在部署时安装');
      }
    } catch (error) {
      console.error('[Deploy] 检测 esptool 失败:', error);
    }
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 根据任务类型获取 XIAO 设备类型
   */
  private getXiaoTypeFromTask(task: string): XiaoType {
    const taskNum = parseInt(task, 10);
    if (taskNum === 6) return XiaoType.AUDIO;
    if (taskNum === 5) return XiaoType.VIBRATION;
    return XiaoType.VISION;
  }

  /**
   * 获取固件类型
   */
  private getFirmwareType(): FirmwareType {
    switch (this.xiaoType) {
      case XiaoType.AUDIO:
        return FirmwareType.AUDIO;
      case XiaoType.VIBRATION:
        return FirmwareType.VIBRATION;
      default:
        return FirmwareType.VISION;
    }
  }

  /**
   * 加载固件信息
   */
  private async loadFirmwareInfo() {
    try {
      const firmwareType = this.getFirmwareType();
      this.firmwareInfo = await this.firmwareService.getFirmwareInfo(firmwareType);
      // console.log('固件信息加载完成:', this.firmwareInfo);
    } catch (error) {
      console.error('加载固件信息失败:', error);
    }
  }

  /**
   * 检查串口列表并设置默认串口
   */
  private async checkAndSetDefaultPort() {
    try {
      const ports = await this.serialService.getSerialPorts();

      if (ports && ports.length > 0) {
        // 如果已经有串口，验证它是否还在可用列表中
        if (this.currentPort) {
          const portExists = ports.some(p => p.name === this.currentPort);
          if (!portExists) {
            // 存储的串口不再可用，清除它
            this.currentPort = undefined;
          }
        }

        // 如果没有串口且只有一个可用串口，自动选择
        if (!this.currentPort && ports.length === 1) {
          this.currentPort = ports[0].name;
        }
      } else {
        // 没有可用串口，清除当前串口
        this.currentPort = undefined;
      }

      this.cd.detectChanges();
    } catch (error) {
      console.warn('获取串口列表失败:', error);
      this.currentPort = undefined;
    }
  }

  // ==================== UI 辅助方法 ====================

  getSupportedBoards(): SupportBoardInfo[] {
    if (!this.modelDetail?.uniform_types) return [];
    return getSupportedBoards(this.modelDetail.uniform_types);
  }

  getTaskDescription(): string {
    if (!this.modelDetail?.task) return '-';
    return getTaskDescription(this.modelDetail.task);
  }

  getModelFormat(): string {
    if (!this.modelDetail?.model_format) return '-';
    return getModelFormatDescription(this.modelDetail.model_format);
  }

  getPrecision(): string {
    if (!this.modelDetail?.precision) return '-';
    return getPrecisionDescription(this.modelDetail.precision);
  }

  getFormattedSize(): string {
    if (!this.modelDetail?.model_size) return '-';
    return formatFileSize(this.modelDetail.model_size);
  }

  getSafeHtml(html: string): SafeHtml {
    return this.sanitizer.sanitize(1, html) || '';
  }

  getDeviceConnectionImage(): string | null {
    if (!this.modelDetail?.uniform_types) return null;
    return getDeviceConnectionImage(this.modelDetail.uniform_types);
  }

  getDeviceConnectionSteps(): string[] {
    if (!this.modelDetail?.uniform_types) return [];
    return getDeviceConnectionSteps(this.modelDetail.uniform_types) || [];
  }

  getAuthorLogo(): string | null {
    if (!this.modelDetail?.author_name) return null;
    return getAuthorLogo(this.modelDetail.author_name);
  }

  openUrl(url: string): void {
    this.electronService.openUrl(url);
  }

  // ==================== 串口选择 ====================

  openPortList(el: any) {
    const rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.getDevicePortList();
    this.showPortList = true;
  }

  async getDevicePortList() {
    const ports = await this.serialService.getSerialPorts();
    if (ports && ports.length > 0) {
      this.portList = ports;
    } else {
      this.portList = [
        {
          name: 'Device not found',
          text: '',
          type: 'serial',
          icon: 'fa-light fa-triangle-exclamation',
          disabled: true,
        }
      ];
    }
  }

  closePortList() {
    this.showPortList = false;
    this.cd.detectChanges();
  }

  selectPort(portItem: PortItem) {
    this.currentPort = portItem.name;
    this.closePortList();
  }

  /**
   * 取消部署
   */
  async cancelDeploy() {
    if (!this.isDeploying || this.isCancelling) {
      // console.log('[Deploy] 取消操作被忽略（不在部署中或已经在取消）');
      return;
    }

    this.isCancelling = true;
    this.cd.detectChanges();

    try {
      // 请求取消烧录（Python esptool）
      // 如果 flashStreamId 还没有值，但有正在进行的烧录操作，等待 streamId 就绪
      if (!this.flashStreamId && this.currentFlashResult) {
        // console.log('[Deploy] 等待 streamId 就绪...');
        try {
          // 设置超时，最多等待 5 秒
          const timeoutPromise = new Promise<string>((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 5000)
          );
          this.flashStreamId = await Promise.race([this.currentFlashResult.streamIdPromise, timeoutPromise]);
          // console.log('[Deploy] streamId 已就绪:', this.flashStreamId);
        } catch (e) {
          console.warn('[Deploy] 等待 streamId 超时或失败:', e);
        }
      }
      
      if (this.flashStreamId) {
        // console.log('[Deploy] 正在取消烧录流程, streamId:', this.flashStreamId);
        this.esptoolPyService.cancelFlash(this.flashStreamId);
      } else {
        // console.log('[Deploy] 没有活跃的烧录流程需要取消');
      }

      // 尝试断开 AT 命令连接
      try {
        await this.sscmaCommandService.disconnect();
      } catch (e) {
        console.warn('[Deploy] 断开 AT 命令连接时出错:', e);
      }
    } catch (error) {
      console.error('[Deploy] 取消过程出错:', error);
    }
    
    // console.log('[Deploy] cancelDeploy 执行完成，等待主流程检测 isCancelling 标志');
    // 注意：不要在这里重置状态
    // 让 startDeploy 的 catch 块和 finally 块处理状态重置
  }

  // ==================== 部署流程 ====================

  /**
   * 开始部署模型
   */
  async startDeploy() {
    if (!this.modelDetail || !this.currentPort) {
      console.error('缺少必要的参数');
      return;
    }

    this.isDeploying = true;
    this.isCancelling = false;
    this.deployProgress = 0;
    this.deployStatus = '正在准备部署...';
    this.cd.detectChanges();

    try {
      // 1. 获取模型文件
      this.deployProgress = 5;
      this.deployStatus = '正在获取模型文件...';
      this.cd.detectChanges();
      const modelFileResult = await this.firmwareService.getModelFile(this.modelDetail.id);

      if (!modelFileResult) {
        throw new Error('获取模型文件失败');
      }

      const { snapshot, detail } = modelFileResult;

      // 检查是否取消
      if (this.isCancelling) {
        throw new Error('用户取消部署');
      }

      // 2. 检测设备固件版本，决定是否需要更新固件
      let needFirmwareUpdate = true;  // 默认需要更新固件
      let deviceVersion: string | null = null;

      if (this.firmwareInfo) {
        this.deployStatus = '正在检测设备固件版本...';

        try {
          // 尝试连接设备获取版本
          await this.sscmaCommandService.connect(this.currentPort!);
          await this.delay(300);

          // 发送 AT+VER? 获取版本
          const verResponse = await this.sscmaCommandService.sendCommand('AT+VER?');
          
          if (verResponse && verResponse.code === 0 && verResponse.data) {
            const data = verResponse.data as any;
            // 版本信息在 data.software 字段
            deviceVersion = data.software || null;
            
            const targetVersion = this.firmwareInfo!['version'] as string;
            if (deviceVersion && targetVersion) {
              // console.log(`[Deploy] 设备当前固件版本: ${deviceVersion}, 目标版本: ${targetVersion}`);
              
              // 比较版本（简单字符串比较）
              if (deviceVersion === targetVersion) {
                needFirmwareUpdate = false;
              } else {
                // console.log('[Deploy] 固件版本不同，需要更新固件');
              }
            }
          }

          // 断开连接，准备后续操作
          await this.sscmaCommandService.disconnect();
        } catch (versionError) {
          // console.warn('[Deploy] 获取设备版本失败，将更新固件:', versionError);
          // 获取版本失败，默认需要更新固件
          needFirmwareUpdate = true;
          
          // 确保断开连接
          try {
            await this.sscmaCommandService.disconnect();
          } catch (e) {
            // 忽略断开连接错误
          }
        }
      }

      // 检查是否取消
      if (this.isCancelling) {
        throw new Error('用户取消部署');
      }

      // 3. 下载所需文件（根据版本检测结果决定是否下载固件）
      const flashFiles: FlashFile[] = [];

      // 2.1 下载固件文件
      if (this.firmwareInfo && needFirmwareUpdate) {
        this.deployProgress = 5;
        this.deployStatus = '正在下载固件...';
        this.cd.detectChanges();
        const firmwareFiles = await this.firmwareService.downloadFirmware(this.firmwareInfo);
        flashFiles.push(...firmwareFiles);
        // console.log('[Deploy] 固件下载完成');
        
        // 检查是否取消
        if (this.isCancelling) {
          throw new Error('用户取消部署');
        }
      }

      // 2.2 下载模型文件
      this.deployProgress = 10;
      this.deployStatus = '正在下载模型文件...';
      this.cd.detectChanges();
      const modelFile = await this.firmwareService.downloadModelFile(snapshot, this.xiaoType);
      flashFiles.push(modelFile);
      // console.log('[Deploy] 模型文件下载完成');

      // 检查是否取消
      if (this.isCancelling) {
        throw new Error('用户取消部署');
      }

      // 显示下载完成提示
      this.deployProgress = 15;
      this.deployStatus = '所有文件下载完成，准备烧录...';
      this.cd.detectChanges();

      // console.log('[Deploy] 所有文件已下载，共 ' + flashFiles.length + ' 个文件');

      // 4. 检查并安装 esptool（如果需要）
      if (!this.esptoolPackage) {
        this.deployProgress = 18;
        this.deployStatus = '正在准备烧录工具...';
        this.cd.detectChanges();

        const installSuccess = await this.esptoolPyService.installEsptool();
        if (!installSuccess) {
          throw new Error('安装 esptool 失败，请检查网络连接');
        }

        this.esptoolPackage = this.esptoolPyService.getEsptoolPackage();
        if (!this.esptoolPackage) {
          // 安装成功但检测失败，可能是文件系统缓存问题
          console.warn('[Deploy] esptool 安装失败，可能是文件系统缓存问题');
          throw new Error('esptool 工具已安装，但需要重新打开窗口才能使用。这是文件系统缓存导致的，请关闭窗口后重新打开即可。');
        }
      }

      // 检查是否取消
      if (this.isCancelling) {
        throw new Error('用户取消部署');
      }

      // 5. 分步烧录所有文件
      // console.log('[Deploy] 开始烧录流程');

      // 5.1 先烧录固件（如果需要更新且有固件文件）
      let firmwareFlashed = false;
      if (needFirmwareUpdate && flashFiles.length > 1) {
        // 有固件需要烧录
        this.deployProgress = 25;
        this.deployStatus = '正在烧录固件...';
        this.cd.detectChanges();

        try {
          const firmwareFile = flashFiles[0]; // 固件总是第一个
          const flashResult = this.esptoolPyService.flashSingleFile(
            { data: firmwareFile.data, address: firmwareFile.address },
            this.currentPort,
            {
              chip: 'esp32s3',
              baudRate: 460800,
              beforeFlash: 'default_reset',
              afterFlash: 'hard_reset',
              progressCallback: (progress: number, status: string) => {
                if (this.isCancelling) return;

                // 固件烧录占 25%-55%
                const overallProgress = 25 + Math.floor(progress * 0.3);
                this.deployProgress = overallProgress;
                this.deployStatus = `烧录固件: ${status}`;
                this.cd.detectChanges();
              }
            }
          );
          
          // 保存当前烧录操作，以便取消时使用
          this.currentFlashResult = flashResult;
          
          // 在后台异步获取 streamId（不阻塞烧录流程）
          flashResult.streamIdPromise.then(sid => {
            this.flashStreamId = sid;
            // console.log('[Deploy] 固件烧录 streamId:', this.flashStreamId);
          }).catch(err => {
            console.warn('[Deploy] 获取固件烧录 streamId 失败:', err);
          });
          
          // 等待烧录完成
          await flashResult.promise;
          
          // 烧录完成，清除当前烧录操作
          this.currentFlashResult = null;
          this.flashStreamId = '';
          firmwareFlashed = true;
          // console.log('[Deploy] 固件烧录完成');

        } catch (error) {
          console.error('[Deploy] 固件烧录失败:', error);
          throw new Error('固件烧录失败: ' + (error as Error).message);
        }
      } else if (!needFirmwareUpdate) {
        // 固件版本相同，跳过固件烧录
        // console.log('[Deploy] 固件版本相同，跳过固件烧录');
      }

      // 检查是否取消
      if (this.isCancelling) {
        throw new Error('用户取消部署');
      }

      // 6.2 烧录模型文件
      this.deployProgress = firmwareFlashed ? 55 : 25;
      this.deployStatus = '正在烧录模型文件...';
      this.cd.detectChanges();

      try {
        const modelFile = flashFiles[flashFiles.length - 1]; // 模型文件总是最后一个
        const flashResult = this.esptoolPyService.flashSingleFile(
          { data: modelFile.data, address: modelFile.address },
          this.currentPort,
          {
            chip: 'esp32s3',
            baudRate: 460800,
            beforeFlash: 'default_reset',
            afterFlash: 'hard_reset',
            progressCallback: (progress: number, status: string) => {
              if (this.isCancelling) return;

              // 模型烧录占 55%-85%（如果有固件）或 25%-85%（仅模型）
              const startProgress = firmwareFlashed ? 55 : 25;
              const overallProgress = startProgress + Math.floor(progress * 0.3);
              this.deployProgress = overallProgress;
              this.deployStatus = `烧录模型: ${status}`;
              this.cd.detectChanges();
            }
          }
        );
        
        // 保存当前烧录操作，以便取消时使用
        this.currentFlashResult = flashResult;
        
        // 在后台异步获取 streamId（不阻塞烧录流程）
        flashResult.streamIdPromise.then(sid => {
          this.flashStreamId = sid;
          // console.log('[Deploy] 模型烧录 streamId:', this.flashStreamId);
        }).catch(err => {
          console.warn('[Deploy] 获取模型烧录 streamId 失败:', err);
        });
        
        // 等待烧录完成
        await flashResult.promise;
        
        // 烧录完成，清除当前烧录操作
        this.currentFlashResult = null;
        this.flashStreamId = '';
        // console.log('[Deploy] 模型烧录完成');

      } catch (error) {
        console.error('[Deploy] 模型烧录失败:', error);
        throw new Error('模型烧录失败: ' + (error as Error).message);
      }

      // console.log('[Deploy] 所有文件烧录完成，准备设置模型信息');

      // 检查是否取消
      if (this.isCancelling) {
        throw new Error('用户取消部署');
      }

      // 7. 等待设备重启
      this.deployProgress = 88;
      this.deployStatus = '正在等待设备重启...';
      this.cd.detectChanges();
      await this.delay(1000);

      // 检查是否取消
      if (this.isCancelling) {
        throw new Error('用户取消部署');
      }

      // 7. 设置模型信息（AT 命令 - 使用 Native Service）

      this.deployProgress = 90;
      this.deployStatus = '正在连接设备...';
      this.cd.detectChanges();

      const modelInfo: ModelInfo = {
        model_id: snapshot.model_id,
        version: snapshot.version,
        arguments: snapshot.arguments,
        model_name: detail.name,
        model_format: snapshot.model_format,
        ai_framwork: snapshot.ai_framwork,
        author: detail.author_name,
        classes: detail.labels.map(l => l.object_name),
        checksum: snapshot.checksum || ''
      };

      try {
        // 使用 Native Service 连接串口
        await this.sscmaCommandService.connect(this.currentPort!);
        // console.log('[AT Native] 串口连接成功');

        // 等待设备完全准备好（设备可能刚重启）
        // console.log('[AT Native] 等待设备准备就绪...');
        await this.delay(500);

        this.deployProgress = 95;
        this.deployStatus = '正在设置模型信息...';
        this.cd.detectChanges();

        // console.log('[AT Native] 测试连接，发送 AT+STAT?...');
        await this.sscmaCommandService.sendCommand('AT+STAT?');
        // console.log('[AT Native] AT+STAT? 命令已发送，等待响应...');
        await this.delay(500);

        // console.log('[AT Native] 发送模型信息...');
        const infoJson = JSON.stringify(modelInfo);
        const encodedInfo = encode(infoJson);
        await this.sscmaCommandService.sendCommand(`AT+INFO="${encodedInfo}"`);
        await this.delay(200);

        // console.log('[AT Native] 触发设备更新...');
        await this.sscmaCommandService.sendCommand('AT+TRIGGER=""');
        await this.delay(200);

        // await this.sscmaCommandService.disconnect();
        // console.log('[AT Native] AT 命令流程完成');
      } catch (atError) {
        console.error('[AT Native] 命令执行失败:', atError);
        await this.sscmaCommandService.disconnect();
        throw new Error('设置模型信息失败: ' + (atError as Error).message);
      }

      // 9. 完成部署，进入配置页面
      this.deployProgress = 100;
      this.deployStatus = '部署完成！正在进入配置页面...';
      this.cd.detectChanges();

      // 等待一小段时间让用户看到完成提示
      await this.delay(1000);

      this.isDeploying = false;

      // 设置标志，让配置页面自动连接设备
      localStorage.setItem('auto_connect_after_deploy', 'true');

      // 自动进入配置页面（步骤1）
      this.router.navigate(['/model-deploy/sscma', 'config']);

      // console.log('[Deploy] 部署完成，已进入配置页面');

    } catch (error) {
      console.error('部署失败:', error);

      // 检查是否是用户取消
      const errorMsg = (error as Error).message || '';
      if (errorMsg.includes('用户取消')) {
        // 用户主动取消
        this.deployStatus = '部署已取消';
        this.deployProgress = 0;
        // console.log('[Deploy] 用户取消部署');
      } else {
        // 其他错误
        this.deployProgress = 0;
        this.deployStatus = '部署失败: ' + errorMsg;
        this.deployError.emit(error as Error);
      }
      
      this.cd.detectChanges();
    } finally {
      // 清理状态和连接
      this.isDeploying = false;
      this.isCancelling = false;
      this.flashStreamId = '';
      this.currentFlashResult = null;
      
      // 确保断开所有连接
      try {
        await this.sscmaCommandService.disconnect();
      } catch (e) {
        // 忽略断开连接错误
      }
      
      this.cd.detectChanges();
    }
  }

  /**
   * 滚动到底部
   */
  // private scrollToBottom(): void {
  //   setTimeout(() => {
  //     try {
  //       const top = document.documentElement.scrollHeight || document.body.scrollHeight;
  //       window.scrollTo({ top, behavior: 'smooth' });
  //     } catch (e) {
  //       // ignore
  //     }
  //   }, 50);
  // }

  // ==================== 步骤导航 ====================

  nextStep() {
    if (this.modelDetail?.author_name === 'SenseCraft AI') {
      if (this.currentStep === 0) {
        // 部署步骤不允许直接下一步，需要点击部署按钮
        return;
      }
    }
    const nextStep = this.currentStep + 1;
    const stepNames = ['deploy', 'config'];
    if (nextStep < stepNames.length) {
      this.router.navigate(['/model-deploy/sscma', stepNames[nextStep]]);
    }
  }

  prevStep() {
    if (this.currentStep > 0) {
      const prevStep = this.currentStep - 1;
      const stepNames = ['deploy', 'config'];
      this.router.navigate(['/model-deploy/sscma', stepNames[prevStep]]);
    }
  }

  /**
   * 配置完成回调
   */
  onConfigComplete(): void {
    // console.log('[Deploy] 配置完成');
    this.deployComplete.emit();
  }

  close() {
    this.uiService.closeWindow();
  }
}
