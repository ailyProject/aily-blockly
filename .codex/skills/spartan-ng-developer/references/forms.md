# Forms Integration

How to wire Helm form components ([form-controls.md](form-controls.md)) into Angular's form systems. This file covers Spartan-specific patterns only; for choosing between ReactiveForms, Template-driven, and Signal Forms in general, defer to the `angular-developer` skill's form references.

Sources used below:

- https://spartan.ng/components/field
- https://spartan.ng/components/input
- https://spartan.ng/forms, https://spartan.ng/forms/reactive-forms, https://spartan.ng/forms/signal-forms (see note in §4)

## 1. Which form system to use

**Default to ReactiveForms.** Signal Forms is on track for stable release in Angular v22 - until then, it remains experimental and its API is still moving. Pick based on project state:

| Project state                                                 | Use                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| New form, any Angular version up to v21                       | **ReactiveForms**                                                       |
| Existing form using ReactiveForms                             | **ReactiveForms** (match the existing strategy)                         |
| Existing form using Template-driven                           | **Template-driven** (match the existing strategy)                       |
| Angular v22+ greenfield, willing to track upcoming-stable API | **Signal Forms** (see §4 - still verify against your installed version) |

Spartan Helm form components work with all of these - the wiring differs slightly per system.

> ⚠ Could not verify a single canonical "form-system recommendation" page from https://spartan.ng/forms - the URL returned an SPA shell with only nav/search. The guidance above reflects current Angular framework status; for per-component form integration claims, see the linked component pages.

## 2. How Helm participates - `ControlValueAccessor` via Brain

Helm form components don't implement `ControlValueAccessor` themselves. Instead, the underlying Brain primitive provides CVA, and the Helm directive applies the Brain primitive via `hostDirectives` (see [helm-conventions.md](helm-conventions.md) §4).

The practical implication: **anything `formControl` or `formControlName` would normally bind to works on a Helm component with no extra setup**. You don't need to add `ngDefaultControl` or write a custom CVA. This is shown directly in the Input docs example:

```html
<input hlmInput type="email" id="form-email" placeholder="name@example.com" formControlName="email" />
```

## 3. ReactiveForms

### Single control

```ts
import { Component } from '@angular/core'
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms'
import { HlmFieldImports } from '@spartan-ng/helm/field'
import { HlmInputImports } from '@spartan-ng/helm/input'
import { HlmLabelImports } from '@spartan-ng/helm/label'

@Component({
	imports: [ReactiveFormsModule, HlmInputImports, HlmFieldImports, HlmLabelImports],
	template: `
		<hlm-field>
			<label hlmFieldLabel for="email">Email</label>
			<input hlmInput id="email" type="email" [formControl]="emailCtrl" />
			@if (emailCtrl.invalid && emailCtrl.touched) {
				<p hlmFieldError>
					@if (emailCtrl.hasError('required')) {
						Email is required.
					}
					@if (emailCtrl.hasError('email')) {
						Invalid email format.
					}
				</p>
			}
		</hlm-field>
	`
})
export class EmailField {
	emailCtrl = new FormControl('', [Validators.required, Validators.email])
}
```

### FormGroup

```ts
form = new FormGroup({
	email: new FormControl('', [Validators.required, Validators.email]),
	plan: new FormControl<'free' | 'pro'>('free', [Validators.required])
})
```

```html
<form [formGroup]="form" (ngSubmit)="submit()">
	<hlm-field>
		<label hlmFieldLabel>Email</label>
		<input hlmInput formControlName="email" />
	</hlm-field>

	<hlm-field>
		<label hlmFieldLabel>Plan</label>
		<hlm-radio-group formControlName="plan">
			<div class="flex items-center gap-3">
				<hlm-radio value="free" inputId="free">
					<hlm-radio-indicator indicator />
				</hlm-radio>
				<label hlmLabel for="free">Free</label>
			</div>
			<div class="flex items-center gap-3">
				<hlm-radio value="pro" inputId="pro">
					<hlm-radio-indicator indicator />
				</hlm-radio>
				<label hlmLabel for="pro">Pro</label>
			</div>
		</hlm-radio-group>
	</hlm-field>

	<button hlmBtn type="submit" [disabled]="form.invalid">Save</button>
</form>
```

### Helm components that integrate with ReactiveForms

> ⚠ Could not verify a comprehensive "components that support `formControlName`" list from https://spartan.ng/forms/reactive-forms - that URL returned an SPA shell with only navigation. The list below is sourced from each component's own page documenting `formControlName` usage; verify against your installed version if a component isn't listed.

Per their component pages, the following accept `formControlName` / `[formControl]` directly: **Input**, **Textarea**, **Checkbox**, **Radio Group**, **Switch**, **Select**, **Native Select**, **Combobox**, **Autocomplete**, **Date Picker**, **Input OTP**, **Slider**, **Toggle**, **Toggle Group**.

(Button, Button Group, Field, Input Group, and Label are visual/structural - they don't participate in the form value.)

## 4. Signal Forms (experimental - stable in Angular v22)

> ⚠ Signal Forms is still experimental at time of writing. It is on track to ship stable in Angular v22. **For new forms on Angular v21 or earlier, use ReactiveForms (§3) instead** - Signal Forms' API has shifted across the experimental period and importing the wrong helpers from the wrong path is an easy way to waste time. Defer to `angular-developer`'s `signal-forms.md` reference for the canonical patterns once you're on v22+.

> ⚠ Could not verify Spartan-specific Signal Forms guidance from https://spartan.ng/forms/signal-forms - the page returned an SPA shell with no documentation content. Verify the API against your installed Angular version.

Signal Forms expose form state as signals, integrating naturally with Angular's reactivity. The shape below is illustrative - confirm imports and helpers against your project's Angular version.

```ts
import { Component } from '@angular/core';
// Imports and exact API depend on the Angular version. Check your installed version.

@Component({...})
export class SignalFormDemo {
  // Definition of fields / form goes here per your Angular version's Signal Forms API.
}
```

Whatever the Signal Forms wiring looks like, Helm components still participate via Brain's `ControlValueAccessor` - there's nothing Spartan-specific to add beyond what your form system requires.

## 5. Validation display with `<hlm-field>` / `[hlmField]`

The Field component is documented at https://spartan.ng/components/field as available in two interchangeable forms:

- Element form: `<hlm-field>…</hlm-field>`
- Attribute (directive) form: `<div hlmField>…</div>` - applies the same behavior to an existing element.

Supported child directives/components (per the Field docs):

- `hlmFieldLabel` - labels
- `hlmFieldDescription` - helper text
- `hlmFieldContent` - flex wrapper for label and description
- `hlmFieldError` - validation error messages
- `hlmFieldGroup` - container for multiple fields
- `hlmFieldSet` / `hlmFieldLegend` - semantic fieldset wrapper
- `hlmFieldTitle` - alternative to label
- `hlmFieldSeparator` - visual divider
- `hlmFieldControlDescribedBy` - companion directive for `aria-describedby` wiring

### `aria-describedby` behavior

Per the Field docs, the field group coordinates `aria-describedby` via `BrnFieldControlDescribedBy` (Brain selector `[brnFieldControlDescribedBy]` with an `aria-describedby: string | null` input). The directive manages association of descriptions/errors to the form control.

In practical terms: keep description and error elements inside the field, and the field group handles the association - don't hand-author `aria-describedby` on the input.

### Example

Element form:

```html
<hlm-field>
	<label hlmFieldLabel>Password</label>
	<input hlmInput type="password" [formControl]="passwordCtrl" />
	<p hlmFieldDescription>Minimum 8 characters.</p>
	@if (passwordCtrl.touched && passwordCtrl.errors?.['minlength']) {
	<p hlmFieldError>Too short.</p>
	}
</hlm-field>
```

Directive form (when you need a different host element or are wrapping existing markup):

```html
<div hlmField>
	<label hlmFieldLabel>Password</label>
	<input hlmInput type="password" [formControl]="passwordCtrl" />
	<p hlmFieldDescription>Minimum 8 characters.</p>
	@if (passwordCtrl.touched && passwordCtrl.errors?.['minlength']) {
	<p hlmFieldError>Too short.</p>
	}
</div>
```

Use `@if` (Angular v17+) to conditionally render the error message.

### Orientation

Field supports `orientation` of `'vertical'` (default), `'horizontal'`, or `'responsive'` (per Field docs). Responsive switches between row/column layout via container queries.

### Invalid styling

Input docs note a `forceInvalid: boolean` input on Brain Input (`[brnInput]`) for forcing the invalid visual state. Helm Input is styled to reflect both the native invalid state and `forceInvalid`.

## 6. Cross-field validation

Cross-field validators (e.g. password vs confirm password) attach to the parent `FormGroup`, not individual controls. Display errors at the form level:

```ts
form = new FormGroup({
  password: new FormControl(''),
  confirm: new FormControl(''),
}, { validators: this.matchPasswords });

private matchPasswords(g: AbstractControl): ValidationErrors | null {
  const p = g.get('password')?.value;
  const c = g.get('confirm')?.value;
  return p === c ? null : { passwordMismatch: true };
}
```

```html
@if (form.touched && form.hasError('passwordMismatch')) {
<p hlmFieldError>Passwords don't match.</p>
}
```

## 7. Programmatic value changes

When updating a Helm form component value from code (e.g. setting a default after async fetch):

```ts
// Patch via the control - preferred
this.form.patchValue({ email: user.email })

// Or directly
this.emailCtrl.setValue(user.email, { emitEvent: false }) // don't trigger valueChanges
```

Avoid mutating the underlying signal in two-way bindings (`[(value)]="x"`) and the FormControl simultaneously - pick one source of truth.

## 8. Common gotchas

| Pitfall                                                              | What goes wrong                                                             | Fix                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Adding `ngDefaultControl` to a Helm component                        | Compile error (unknown directive)                                           | Don't add it - Brain provides CVA already                                          |
| Manually writing `aria-describedby` on an input inside `<hlm-field>` | Conflicts with `BrnFieldControlDescribedBy`, screen reader output can break | Let the field group manage it via `hlmFieldDescription` / `hlmFieldError` siblings |
| Showing errors before user interaction                               | Distracting form on first render                                            | Gate display behind `.touched` or `.dirty`                                         |
| Using `[(ngModel)]` AND `formControlName` on the same input          | Inconsistent state, Angular warning                                         | Pick one - `formControlName` for ReactiveForms                                     |
| Forgetting `ReactiveFormsModule` in imports                          | Template error: `formControlName` not bound                                 | Add it to the standalone component's `imports`                                     |
| `itemToString` re-created every render (Select/Combobox)             | Change detection thrash, dropdowns flicker                                  | Declare on the class as a class field, not inline in the template                  |
| Programmatic `setValue` triggering loops                             | Infinite valueChanges → setValue cycle                                      | Pass `{ emitEvent: false }` to break the cycle                                     |

## See also

- [Form controls](form-controls.md) - per-component API and gotchas.
- [Helm conventions](helm-conventions.md) - `hostDirectives` composition with Brain.
- [Accessibility](accessibility.md) - form-specific a11y patterns.
- `angular-developer` skill's `reactive-forms.md` and `signal-forms.md` references for the general form-system guidance this file builds on.
- [Back to SKILL.md](../SKILL.md)
