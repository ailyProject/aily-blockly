import { Component, EventEmitter, Input, Output } from '@angular/core';
import { BRAND_LIST, CORE_LIST } from '../../../../configs/board.config';
import { ThemeService } from '../../../../services/theme.service';

@Component({
  selector: 'app-brand-list',
  imports: [],
  templateUrl: './brand-list.component.html',
  styleUrl: './brand-list.component.scss'
})
export class BrandListComponent {

  constructor(private themeService: ThemeService) {}

  @Input() mode: string = 'brand'

  get brandList() {
    return this.mode === 'core' ? CORE_LIST : BRAND_LIST;
  }
  selectedBrand: any = null;

  @Output() brandSelected = new EventEmitter<any>();



  getBrandImg(brand: any): string {
    if (this.themeService.theme() === 'light' && brand.imgLight) {
      return brand.imgLight;
    }
    return brand.img;
  }

  selectBrand(brand: any) {
    this.selectedBrand = brand;
    this.brandSelected.emit(brand);
  }
}
