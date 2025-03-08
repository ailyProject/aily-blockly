import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {

  boardList: any[] = [{
    "name": "test",
    "version": "1.0.0",
  }];

  constructor() { }

  async getBoardList() {
    const allBoardList = await this.getAllBoardList();
    const installedDict = await this.getInstalledDependencies();
    allBoardList.forEach((board) => {
      // 判断名称与版本是否对应
      if (installedDict[board.name] && installedDict[board.name].version === board.version) {
        board.installed = true;
      } else {
        board.installed = false;
      }
    });
    this.boardList = allBoardList;

    console.log('boardList: ', this.boardList);
  }
  
  async getAllBoardList() {
    const allBoardList = await window['dependencies'].boardList();
    console.log('allBoardList: ', allBoardList);
    return allBoardList;
  }

  // installed dependencies
  async getInstalledDependencies() {
    const installedDict = await window['dependencies'].installedList();
    console.log('allDependencies: ', installedDict);
    return installedDict;
  }
}
