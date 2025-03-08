import { Component } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';

@Component({
  selector: 'app-about',
  imports: [
    SubWindowComponent
  ],
  templateUrl: './about.component.html',
  styleUrl: './about.component.scss'
})
export class AboutComponent {

}
