import { Component } from '@angular/core'

import { APP_ICON_IMPORTS, APP_ICON_PROVIDERS } from '@/components/ui/icon/app-icons'

@Component({
	selector: 'app-shell',
	imports: [...APP_ICON_IMPORTS],
	providers: [...APP_ICON_PROVIDERS],
	templateUrl: './app-shell.component.html',
	styleUrl: './app-shell.component.css'
})
export class AppShellComponent {}
