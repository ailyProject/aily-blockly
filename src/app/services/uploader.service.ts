import { Injectable } from '@angular/core';
import { ProjectService } from './project.service';
import { SerialService } from './serial.service';
import { ActionState, UiService } from './ui.service';
import { TerminalService } from '../tools/terminal/terminal.service';
import { NzMessageService } from 'ng-zorro-antd/message';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  constructor(
    private projectService: ProjectService,
    private uiService: UiService,
    private serialService: SerialService,
    private terminalService: TerminalService,
    private message: NzMessageService,
  ) { }

  async upload(): Promise<ActionState> {
    const projectPath = this.projectService.currentProject;
    const tempPath = projectPath + '/.temp';
    const buildPath = tempPath + '/build';

    // 检查.temp文件与build文件夹是否存在
    if (!window['file'].existsSync(tempPath) || !window['file'].existsSync(buildPath)) {
      this.message.error('请先编译项目');
      return;
    }

    // 加载项目package.json
    const packageJson = JSON.parse(window['file'].readFileSync(`${projectPath}/package.json`));
    const dependencies = packageJson.dependencies || {};
    const boardDependencies = packageJson.boardDependencies || {};

    // 从dependencies中查找以@aily-project/board-开头的依赖
    let board = ""
    Object.entries(dependencies).forEach(([key, version]) => {
      if (key.startsWith('@aily-project/board-')) {
        board = key
      }
    });

    if (!board) {
      this.message.error('缺少板子信息');
      return;
    }

    // 获取板子信息(board.json)
    const boardJson = JSON.parse(window['file'].readFileSync(`${projectPath}/node_modules/${board}/board.json`));
    console.log("boardJson: ", boardJson);

    if (!boardJson) {
      this.message.error('缺少板子信息');
      return;
    }

    // 获取上传参数
    let uploadParam = boardJson.uploadParam;
    // 替换uploadParam中的${serial}为当前串口
    if (!this.serialService.currentPort) {
      this.message.error('请先选择串口');
      return;
    }
    uploadParam = uploadParam.replace('${serial}', this.serialService.currentPort);

    // 获取sdk、上传工具的名称和版本
    let sdk = ""
    let uploader = ""

    Object.entries(boardDependencies).forEach(([key, version]) => {
      if (key.startsWith('@aily-project/sdk-')) {
        sdk = key.replace(/^@aily-project\/sdk-/, '') + '_' + version;
      }
      if (key.startsWith('@aily-project/tool-')) {
        uploader = key.replace(/^@aily-project\/tool-/, '') + '@' + version;
      }
    });

    if (!sdk || !uploader) {
      this.message.error('缺少sdk或上传工具');
      return;
    }

    // 组合sdk、上传工具的路径
    const sdkPath = await window["env"].get('AILY_SDK_PATH') + `/${sdk}`;
    const uploaderPath = await window["env"].get('AILY_TOOL_PATH') + `/${uploader}`;
    const toolsPath = await window["env"].get('AILY_TOOL_PATH');

    this.uiService.updateState({ state: 'doing', text: '准备完成，开始上传...' });

    // 上传
    await this.uiService.openTerminal();
    const uploadCmd = `arduino-cli.exe ${uploadParam} --input-dir ${buildPath} --board-path ${sdkPath} --uploader-path ${uploaderPath} --tools-path ${toolsPath} --verbose`;
    console.log("uploadCmd: ", uploadCmd);
    await this.terminalService.sendCmd(uploadCmd);

    this.uiService.updateState({ state: 'done', text: '上传完成' });
    this.message.success('上传完成');
  }
}
