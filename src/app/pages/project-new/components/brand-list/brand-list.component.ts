import { Component, EventEmitter, Input, Output } from '@angular/core';
import { BRAND_LIST, CORE_LIST } from '../../../../configs/board.config';

@Component({
  selector: 'app-brand-list',
  imports: [],
  templateUrl: './brand-list.component.html',
  styleUrl: './brand-list.component.scss'
})
export class BrandListComponent {

  @Input() mode: string = 'brand'

  get brandList() {
    return this.mode === 'core' ? CORE_LIST : BRAND_LIST;
  }
  selectedBrand: any = null;

  @Output() brandSelected = new EventEmitter<any>();



  selectBrand(brand: any) {
    this.selectedBrand = brand;
    this.brandSelected.emit(brand);
  }
}
