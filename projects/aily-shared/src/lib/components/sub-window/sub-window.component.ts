import { Component, Input } from '@angular/core';
import { Router } from '@angular/router';

declare global {
  interface Window {
    iWindow: {
      goMain: (url: string) => void;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
    };
  }
}

@Component({
  selector: 'aily-sub-window',
  standalone: true,
  imports: [],
  templateUrl: './sub-window.component.html',
  styleUrl: './sub-window.component.scss',
})
export class SubWindowComponent {
  @Input() title = 'sub-window';
  @Input() winBtns: ('gomain' | 'minimize' | 'maximize' | 'close')[] = ['gomain', 'minimize', 'maximize', 'close'];

  currentUrl: string = '';

  constructor(private router: Router) {}

  ngOnInit(): void {
    this.currentUrl = this.router.url;
  }

  goMain(): void {
    window.iWindow?.goMain(this.currentUrl);
  }

  minimize(): void {
    window.iWindow?.minimize();
  }

  maximize(): void {
    window.iWindow?.maximize();
  }

  close(): void {
    window.iWindow?.close();
  }
}
