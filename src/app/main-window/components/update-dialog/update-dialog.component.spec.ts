import { EMPTY } from 'rxjs';
import { ConfigService } from '../../../services/core/preferences/config.service';
import { UpdateDialogComponent } from './update-dialog.component';

describe('UpdateDialogComponent changelog requests', () => {
  for (const [product, language, baseUrl, expectedUrl] of [
    ['coder', 'en', 'https://dl.aily.pro/blockly', 'https://dl.aily.pro/blockly/CHANGELOG_CODER.md'],
    ['coder', 'zh-CN', 'https://dl.yiyu.pro/blockly', 'https://dl.yiyu.pro/blockly/CHANGELOG_CODER_ZH.md'],
    ['blockly', 'zh-CN', 'https://dl.yiyu.pro/blockly', 'https://dl.yiyu.pro/blockly/CHANGELOG_ZH.md'],
  ]) {
    it(`loads the ${product} changelog for ${language}`, () => {
      const config = new ConfigService({} as any, {} as any);
      (config as any).runtimeBuildProduct = product;
      config.data = { region: 'cn', regions: { cn: { updater: baseUrl } } };
      const http = { get: jasmine.createSpy('get').and.returnValue(EMPTY) };
      const component = new UpdateDialogComponent(
        {},
        {} as any,
        { updateStatus: EMPTY, updateProgress: EMPTY, downloadSourceStatus: EMPTY } as any,
        {} as any,
        config,
        http as any,
        { currentLang: language, instant: (key: string) => key } as any,
      );

      component.ngOnInit();

      expect(http.get).toHaveBeenCalledOnceWith(expectedUrl, { responseType: 'text' });
      component.ngOnDestroy();
    });
  }
});
