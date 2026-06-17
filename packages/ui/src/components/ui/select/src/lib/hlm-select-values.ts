import { Directive } from '@angular/core'
import { BrnSelectValues } from '@spartan-ng/brain/select'

@Directive({ selector: '[hlmSelectValues]', hostDirectives: [BrnSelectValues] })
export class HlmSelectValues {}
