import { Component, Input } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-sub-window',
  imports: [],
  templateUrl: './sub-window.component.html',
  styleUrl: './sub-window.component.scss',
})
export class SubWindowComponent {
  @Input() title = 'sub-window';
  @Input() winBtns = ['gomain', 'minimize', 'maximize', 'close'];

  currentUrl;

  constructor(
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.currentUrl = this.router.url;
  }

  goMain() {
    window['iWindow'].goMain(this.currentUrl);
  }

  minimize() {
    window['iWindow'].minimize();
  }

  maximize() {
    window['iWindow'].maximize();
  }

  close() {
    window['iWindow'].close();
  }
}
