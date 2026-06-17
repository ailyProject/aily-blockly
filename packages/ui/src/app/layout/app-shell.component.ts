import { Component } from '@angular/core'
import { APP_ICON_IMPORTS } from '@ui/components/ui/icon/app-icons'

@Component({
	selector: 'app-shell',
	imports: [...APP_ICON_IMPORTS],
	templateUrl: './app-shell.component.html',
	styleUrl: './app-shell.component.css'
})
export class AppShellComponent {}
