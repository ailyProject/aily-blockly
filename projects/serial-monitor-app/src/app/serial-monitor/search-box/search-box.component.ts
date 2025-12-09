import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';

@Component({
  selector: 'app-search-box',
  imports: [NzInputModule, CommonModule, FormsModule],
  templateUrl: './search-box.component.html',
  styleUrl: './search-box.component.scss'
})
export class SearchBoxComponent {
  @Output() keywordChange = new EventEmitter<string>();
  @Output() prevResult = new EventEmitter<void>();
  @Output() nextResult = new EventEmitter<void>();
  @Input() resultsCount = 0;
  @Input() currentIndex = -1;

  keyword;

  onKeywordChange(e) {
    this.keywordChange.emit(this.keyword);
  }

  onPrevClick() {
    this.prevResult.emit();
  }
  
  onNextClick() {
    this.nextResult.emit();
  }
}
