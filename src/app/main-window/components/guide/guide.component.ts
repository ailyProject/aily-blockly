import { Component } from '@angular/core';
import { GUIDE_MENU } from '../../../configs/menu.config';
import { UiService } from '../../../services/ui.service';
import { ProjectService } from '../../../services/project.service';
import { version } from '../../../../../package.json';

@Component({
  selector: 'app-guide',
  imports: [],
  templateUrl: './guide.component.html',
  styleUrl: './guide.component.scss'
})
export class GuideComponent {
  version = version;
  guideMenu = GUIDE_MENU;
  showMenu = true;
  showMore = false;

  get recentlyProjects() {
    return this.projectService.recentlyProjects
  }

  constructor(
    private uiService: UiService,
    private projectService: ProjectService
  ) { }

  onMenuClick(e: any) {
    this.process(e);
  }

  async selectFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: '',
    });
    console.log('选中的文件夹路径：', folderPath);
    return folderPath;
  }

  async openProject(data) {
    const path = await this.selectFolder();
    if (path) {
      await this.projectService.projectOpen(path);
    }
  }

  async openProjectByPath(data) {
    await this.projectService.projectOpen(data.path);
  }

  process(item) {
    switch (item.data.type) {
      case 'window':
        this.uiService.openWindow(item.data);
        break;
      case 'explorer':
        this.openProject(item.data);
        break;
    }
  }
}
