import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { lastValueFrom } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class ConfigService {

  constructor(private http: HttpClient) { }

  async init() {
    await this.loadBoardList();
  }

  configData;
  async loadConfigFile() {
    let appPath = window['path'].join(window['app'].getPath('userData'), 'config.json');
    this.configData = await JSON.parse(window['file'].readFileSync(`${appPath}/config.json`));
  }

  async saveConfigFile() {
    let appPath = window['path'].join(window['app'].getPath('userData'), 'config.json');
    window['file'].writeFileSync(`${appPath}/config.json`, JSON.stringify(this.configData, null, 2));
  }

  boardList;
  async loadBoardList() {
    this.boardList = await lastValueFrom(
      this.http.get('https://blockly.openjumper.cn/boards.json', {
        responseType: 'json',
      }),
    );
    return this.boardList;
  }

  libraryList;
  async loadLibraryList() {
    this.libraryList = await lastValueFrom(
      this.http.get('https://blockly.openjumper.cn/libraries.json', {
        responseType: 'json',
      }),
    );
    return this.libraryList;
  }
}
