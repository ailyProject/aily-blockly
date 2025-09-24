import { Component, EventEmitter, Output } from '@angular/core';
import { BRAND_LIST } from '../../../../configs/board.config';

@Component({
  selector: 'app-brand-list',
  imports: [],
  templateUrl: './brand-list.component.html',
  styleUrl: './brand-list.component.scss'
})
export class BrandListComponent {
  brandList = BRAND_LIST;
  selectedBrand: any = null;

  @Output() brandSelected = new EventEmitter<any>();

  selectBrand(brand: any) {
    this.selectedBrand = brand;
    this.brandSelected.emit(brand);
  }
}
