import '@angular/compiler';
import { Subject } from 'rxjs';
import { SubappManagerService } from '../../../src/app/services/integrations/subapps/subapp-manager.service';

// A contract test shell around the production renderer service. Main/preload,
// download, extraction, selection and launched fixture runtime are all real.
const bridge = window as any;
bridge.startPublicationAcceptance = async (url: string) => {
  const service = new SubappManagerService({ currentLang: 'zh_cn', onLangChange: new Subject() } as any,
    { configReloaded$: new Subject(), getSubappIndexUrl: () => url } as any);
  bridge.publicationService = service;
  bridge.publicationOperation = null;
  service.state$.subscribe(state => {
    const output = document.querySelector('[data-version]') as HTMLElement;
    output.textContent = state.apps[0]?.installedVersion || '未安装';
  });
  for (const action of ['install', 'update', 'reinstall', 'downloadUpdate', 'installUpdate']) {
    document.querySelector(`[data-action="${action}"]`)!.addEventListener('click', () => {
      const operation = { settled: false, error: null as string | null };
      bridge.publicationOperation = operation;
      (service as any)[action]('aily-chat').then(() => { operation.settled = true; }, (error: Error) => {
        operation.error = error.message; operation.settled = true;
      }).finally(() => { document.querySelector('[data-error]')!.textContent = operation.error || ''; });
    });
  }
  await service.initialize();
};
