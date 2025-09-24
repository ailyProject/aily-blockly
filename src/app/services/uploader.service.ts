import { Injectable } from '@angular/core';
import { ActionService } from './action.service';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  constructor(
    private actionService: ActionService
  ) { }

  async upload() {
    try {
      const result = await this.actionService.dispatchWithFeedback('upload-begin', {}, 300000).toPromise();
      console.log("Upload finished: ", result);
      return result.data?.result;
    } catch (error) {
      console.log('上传失败:  ', error);
      throw error;
    }
  }

  /**
  * 取消当前编译过程
  */
  cancel() {
    this.actionService.dispatch('upload-cancel', {}, result => {
      if (result.success) {
      } else {
      }
    });
  }
}

