import { Directive } from '@angular/core'
import { BrnComboboxValueTemplate } from '@spartan-ng/brain/combobox'

@Directive({ selector: '[hlmComboboxValueTemplate]', hostDirectives: [BrnComboboxValueTemplate] })
export class HlmComboboxValueTemplate {}
