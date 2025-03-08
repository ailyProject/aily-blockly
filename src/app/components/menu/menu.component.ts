import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
} from '@angular/core';

@Component({
  selector: 'app-menu',
  imports: [CommonModule],
  templateUrl: './menu.component.html',
  styleUrl: './menu.component.scss',
})
export class MenuComponent {
  @ViewChild('menuBox') menuBox: ElementRef;
  @Input() menuList = [];

  @Input() position = {
    x: 2,
    y: 40,
  };

  @Input() width = 250;

  @Output() itemClickEvent = new EventEmitter();

  @Output() closeEvent = new EventEmitter();

  @Input() keywords = [];

  ngAfterViewInit(): void {
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('contextmenu', this.handleDocumentClick)
  }

  ngOnDestroy(): void {
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleDocumentClick);
  }

  itemClick(item) {
    this.itemClickEvent.emit(item);
  }

  handleDocumentClick = (event: MouseEvent) => {
    event.preventDefault();
    if (
      this.menuBox &&
      !this.menuBox.nativeElement.contains(event.target as Node)
    ) {
      this.closeMenu();
    }
  };

  closeMenu() {
    this.closeEvent.emit('');
  }

  isHighlight(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return this.keywords.some((keyword) => 
      keyword && lowerText.includes(keyword.toLowerCase())
    );
  }
}
