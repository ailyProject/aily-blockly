import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';

import { ChatRuntimeHostBootstrapService } from '../services/chat-runtime-host-bootstrap.service';

@Component({
  selector: 'app-aily-chat-runtime-owner',
  standalone: true,
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatRuntimeOwnerComponent implements OnInit {
  private readonly bootstrap = inject(ChatRuntimeHostBootstrapService);

  ngOnInit(): void {
    void this.bootstrap.startHostRuntimeOwner().catch((error) => {
      console.error('[AilyChat][RuntimeOwnerHost] Failed to start dedicated runtime owner:', error);
    });
  }
}
