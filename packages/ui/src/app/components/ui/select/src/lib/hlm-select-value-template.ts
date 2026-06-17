import { Directive } from '@angular/core'
import { BrnSelectValueTemplate } from '@spartan-ng/brain/select'

@Directive({ selector: '[hlmSelectValueTemplate]', hostDirectives: [BrnSelectValueTemplate] })
export class HlmSelectValueTemplate {}
