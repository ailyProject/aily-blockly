import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { importProvidersFrom } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { NzModalModule } from 'ng-zorro-antd/modal';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideAnimations(),
    provideTranslateService(),
    importProvidersFrom(FormsModule, NzModalModule)
  ]
}).catch(err => console.error(err));
