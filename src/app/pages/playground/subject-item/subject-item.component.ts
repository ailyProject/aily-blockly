import { Component } from '@angular/core';
import { SimplebarAngularModule } from 'simplebar-angular';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ProjectService } from '../../../services/project.service';
import { ConfigService } from '../../../services/config.service';
import { ElectronService } from '../../../services/electron.service';
import { CmdService } from '../../../services/cmd.service';
import { PlaygroundService } from '../playground.service';
import { UiService } from '../../../services/ui.service';

@Component({
  selector: 'app-subject-item',
  imports: [SimplebarAngularModule, NzButtonModule, TranslateModule,
  ],
  templateUrl: './subject-item.component.html',
  styleUrl: './subject-item.component.scss'
})
export class SubjectItemComponent {

  exampleItem: any;

  // example存放路径
  examplesRoot: string = '';

  get examplesList() {
    return this.playgroundService.processedExamplesList;
  }

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  constructor(
    private route: ActivatedRoute,
    private configService: ConfigService,
    private projectService: ProjectService,
    private message: NzMessageService,
    private electronService: ElectronService,
    private cmdService: CmdService,
    private playgroundService: PlaygroundService,
    private uiService: UiService
  ) { }

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      const name = params.get('name');
      if (name) {
        // 如果数据已经加载，直接查找
        if (this.playgroundService.isLoaded) {
          this.exampleItem = this.playgroundService.findExampleByName(name);
          this.initializeItemsLoadingState();
        } else {
          // 如果数据未加载，等待加载完成后查找
          this.playgroundService.loadExamplesList().then(() => {
            this.exampleItem = this.playgroundService.findExampleByName(name);
            this.initializeItemsLoadingState();
          });
        }
      }
    });
  }

  private initializeItemsLoadingState() {
    if (this.exampleItem && this.exampleItem.examples) {
      this.exampleItem.examples.forEach(item => {
        if (!item.hasOwnProperty('loading')) {
          item.loading = false;
        }
      });
    }
  }

  async installLib(lib, prefix) {
    this.cmdService.runAsync(`npm install ${lib.name} --prefix "${prefix}"`)
  }


  async loadExample(path) {
    // 找到当前item
    const currentItem = this.exampleItem?.examples?.find(item => item.path === path);
    if (!currentItem) return;

    this.message.loading('正在加载示例');
    currentItem.loading = true;
    
    try {
      const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
      const examplePath = `${appDataPath}/node_modules/${this.exampleItem.name}/${path}`;
      const abiFilePath = `${examplePath}/project.abi`;

      this.uiService.updateFooterState({ state: 'doing', text: `正在加载示例...`, timeout: 300000 });
      // 避免缓存，一律重新安装加载
      await this.cmdService.runAsync(`npm cache clean --force`);
      await this.cmdService.runAsync(`npm install ${this.exampleItem.name} --prefix "${appDataPath}" --force`);

      // if (!this.electronService.exists(examplePath) || !this.electronService.exists(abiFilePath)) {
      //   await this.cmdService.runAsync(`npm install ${this.exampleItem.name} --prefix "${appDataPath}"`)
      // }

      const targetPath = `${this.projectService.projectRootPath}\\${path}`;
      await this.cmdService.runAsync(`cp -r "${examplePath}" "${targetPath}"`);
      this.uiService.updateFooterState({ state: 'done', text: `示例加载完成` });
      this.projectService.projectOpen(targetPath);
    } catch (error) {
      this.message.error('示例加载失败');
    } finally {
      currentItem.loading = false;
    }
  }

  get hasAnyItemLoading() {
    return this.exampleItem?.examples?.some(item => item.loading) || false;
  }

  openUrl(url = 'https://arduino.me') {
    if (url) {
      this.electronService.openUrl(url);
    } else {
      this.message.error("invalid url");
    }
  }
}
