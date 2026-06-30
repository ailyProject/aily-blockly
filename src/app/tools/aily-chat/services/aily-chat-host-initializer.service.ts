import { Injectable, Injector, inject } from '@angular/core';

import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { AuthService } from '../../../services/auth.service';
import { BuilderService } from '../../../services/builder.service';
import { CmdService } from '../../../services/cmd.service';
import { ConfigService } from '../../../services/config.service';
import { ConnectionGraphService } from '../../../services/connection-graph.service';
import { CrossPlatformCmdService } from '../../../services/cross-platform-cmd.service';
import { ElectronService } from '../../../services/electron.service';
import { NoticeService } from '../../../services/notice.service';
import { OnboardingService } from '../../../services/onboarding.service';
import { PlatformService } from '../../../services/platform.service';
import { ProjectService } from '../../../services/project.service';
import { UiService } from '../../../services/ui.service';
import { createElectronHostAdapter } from '../adapters/electron-host-adapter';
import { AilyHost } from '../core/host';
import { AbsAutoSyncService } from './abs-auto-sync.service';
import { ArduinoLintService } from './arduino-lint.service';

@Injectable({ providedIn: 'root' })
export class AilyChatHostInitializerService {
  private readonly injector = inject(Injector);

  ensureInitialized(): void {
    if (AilyHost.isInitialized()) {
      return;
    }

    const injector = this.injector;
    AilyHost.init(createElectronHostAdapter({
      get projectService() { return injector.get(ProjectService); },
      get configService() { return injector.get(ConfigService); },
      get authService() { return injector.get(AuthService); },
      get builderService() { return injector.get(BuilderService); },
      get platformService() { return injector.get(PlatformService); },
      get noticeService() { return injector.get(NoticeService); },
      get blocklyService() { return injector.get(BlocklyService); },
      get connectionGraphService() { return injector.get(ConnectionGraphService); },
      get cmdService() { return injector.get(CmdService); },
      get crossPlatformCmdService() { return injector.get(CrossPlatformCmdService); },
      get absAutoSyncService() { return injector.get(AbsAutoSyncService); },
      get arduinoLintService() { return injector.get(ArduinoLintService); },
      get electronService() { return injector.get(ElectronService); },
      get uiService() { return injector.get(UiService); },
      get onboardingService() { return injector.get(OnboardingService); },
    }));
  }
}
