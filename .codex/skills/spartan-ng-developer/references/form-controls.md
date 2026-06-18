# Form Controls

The 19 Helm components for data entry and user input. All follow [helm-conventions.md](helm-conventions.md). For wiring these to ReactiveForms or Signal Forms, see [forms.md](forms.md).

> **Verify against the generated source.** Spartan is pre-1.0 and the Helm code lives in the user's repo. When the docs and the user's generated file disagree, trust the file.

---

### Autocomplete

- **Pattern**: B (compound + portal)
- **Import**: `HlmAutocompleteImports` from `@spartan-ng/helm/autocomplete`
- **Use**: Text input with a filterable suggestion list.
- **Example**:
  ```html
  <hlm-autocomplete [(value)]="value" [(search)]="search" [itemToString]="toLabel">
  	<hlm-autocomplete-input placeholder="Search..." />
  	<hlm-autocomplete-content *hlmAutocompletePortal>
  		<ul hlmAutocompleteList>
  			@for (item of filtered(); track item.id) {
  			<hlm-autocomplete-item [value]="item">{{ item.label }}</hlm-autocomplete-item>
  			}
  		</ul>
  	</hlm-autocomplete-content>
  </hlm-autocomplete>
  ```
- **Key inputs**: `[(value)]`, `[(search)]`, `itemToString`, `isItemEqualToValue`.
- **Gotcha**: There is no `<hlm-autocomplete-trigger>` tag - the input itself is the trigger. Filter logic is your responsibility - Spartan only renders the items you pass.

### Button

- **Pattern**: A (directive on `<button>` or `<a>`)
- **Import**: `HlmButtonImports` from `@spartan-ng/helm/button`
- **Use**: Styled button.
- **Variants**: `default | outline | secondary | ghost | destructive | link`
- **Sizes**: `default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`
- **Example**:
  ```html
  <button hlmBtn variant="outline" size="sm">Click me</button> <a hlmBtn href="/docs">Read more</a>
  ```
- **Brain**: composes `BrnButton` (handles `disabled`).
- **Gotcha**: For icon-only buttons (`size="icon"`), always add an `aria-label` - there's no text for screen readers.

### Button Group

- **Pattern**: B (compound - `<hlm-button-group>` element or `[hlmButtonGroup]` attribute)
- **Import**: `HlmButtonGroupImports` from `@spartan-ng/helm/button-group`
- **Use**: Visually attached cluster of buttons (segmented toggle, action group).
- **Example**:
  ```html
  <hlm-button-group>
  	<button hlmBtn variant="outline">Left</button>
  	<button hlmBtn variant="outline">Mid</button>
  	<button hlmBtn variant="outline">Right</button>
  </hlm-button-group>
  ```
- **Gotcha**: Only the outermost edges get rounded; inner buttons drop their border-radius automatically.

### Checkbox

- **Pattern**: B (`<hlm-checkbox>` element)
- **Import**: `HlmCheckboxImports` from `@spartan-ng/helm/checkbox`
- **Use**: Single boolean input. Supports indeterminate state.
- **Example**:
  ```html
  <hlm-checkbox [(checked)]="accepted" /> <hlm-checkbox [checked]="state" [(indeterminate)]="isPartial" />
  ```
- **Key inputs**: `checked` (boolean), `indeterminate` (boolean), plus `checkedChange` / `indeterminateChange` outputs.
- **Form integration**: Works with `formControlName` via Brain's CVA.
- **Gotcha**: `checked` and `indeterminate` are **separate booleans**, not a `boolean | 'indeterminate'` union.

### Combobox

- **Pattern**: B (compound + portal)
- **Import**: `HlmComboboxImports` from `@spartan-ng/helm/combobox`
- **Use**: Searchable dropdown - typeable input with filtered options list.
- **Example**:
  ```html
  <hlm-combobox class="w-56" [(value)]="value" [(search)]="search" [itemToString]="toLabel">
  	<hlm-combobox-trigger class="w-full">
  		<hlm-combobox-value>
  			<hlm-combobox-placeholder>Pick a framework</hlm-combobox-placeholder>
  		</hlm-combobox-value>
  	</hlm-combobox-trigger>
  	<hlm-combobox-content *hlmComboboxPortal class="w-[var(--brn-popover-trigger-width)]!">
  		<hlm-combobox-input placeholder="Search..." />
  		<ul hlmComboboxList>
  			@for (item of filtered(); track item.id) {
  			<hlm-combobox-item [value]="item">{{ item.label }}</hlm-combobox-item>
  			}
  		</ul>
  	</hlm-combobox-content>
  </hlm-combobox>
  ```
- **Multi-select**: use `<hlm-combobox-multiple>` plus `<hlm-combobox-chips>` / `<hlm-combobox-chip>` to render selected values.
- **Key inputs**: `[(value)]`, `[(search)]`, `itemToString`, `isItemEqualToValue`, `filter`, `filterOptions`.
- **`forceInvalid`**: available on `<hlm-combobox-input>` and `<hlm-combobox-chips>` (not on `<hlm-combobox>` itself). Use it to drive the invalid visual when wiring to a `FormControl`.
- **Gotchas**:
  - **No `[items]` input** — items are projected as content. `itemToString` must be a stable reference (declare on the class, don't inline in the template).
  - **`hlm-combobox-input` is a component, NOT a directive on a plain `<input>`.** Use `<hlm-combobox-input placeholder="..." />`, not `<input hlm-combobox-input ...>`. The component wraps a styled `<hlm-input-group>` + `<input hlmInputGroupInput>` + clear button + chevron. The bare-directive form renders an unstyled native input.
  - **`hlm-combobox-trigger` does not fill its container width by default.** Without `class="w-full"` on the trigger, the button shrinks to its content. Match the trigger to the outer `<hlm-combobox>` width by setting both — typical pattern: `<hlm-combobox class="w-56">` with `<hlm-combobox-trigger class="w-full">`.
  - **Popover width** — `<hlm-combobox-content>` doesn't automatically match the trigger width. To anchor it, set `class="w-[var(--brn-popover-trigger-width)]!"` on the content. (The Brain popover sets this CSS var to the trigger's width when opened.)

### Date Picker

- **Pattern**: B (compound + portal)
- **Import**: `HlmDatePickerImports` from `@spartan-ng/helm/date-picker`
- **Use**: Calendar-backed date input. Three selectors for the three modes.
- **Selectors**: `<hlm-date-picker>` (single), `<hlm-date-picker-multi>` (multi-select), `<hlm-date-range-picker>` (range).
- **Example**:
  ```html
  <hlm-field>
  	<label hlmFieldLabel for="date">Date</label>
  	<hlm-date-picker buttonId="date" [(date)]="selectedDate">
  		<span>Select date</span>
  	</hlm-date-picker>
  </hlm-field>
  ```
- **Range example**: `<hlm-date-range-picker [(date)]="range" />` - value type is `[Date, Date]`.
- **Key inputs**: `[(date)]`, `min`, `max`, `disabled`, `buttonId`, `captionLayout` (`'dropdown' | 'label' | 'dropdown-months' | 'dropdown-years'`), `formatDate`, `autoCloseOnSelect`, `minSelection` / `maxSelection` (multi only).
- **Gotcha**: Two-way binding is `[(date)]`, **not** `[(value)]`. For locale formatting, configure Angular's `LOCALE_ID` and `registerLocaleData` at bootstrap.

### Field

- **Pattern**: B (compound wrapper - `<hlm-field>` element or `<div hlmField>` directive)
- **Import**: `HlmFieldImports` from `@spartan-ng/helm/field`
- **Use**: Form-field layout wrapper. Aligns label, input, description, and error consistently and wires `aria-describedby` via Brain's `BrnFieldControlDescribedBy`.
- **Example**:
  ```html
  <div hlmField orientation="vertical">
  	<label hlmFieldLabel>Email</label>
  	<input hlmInput type="email" [formControl]="emailCtrl" />
  	<p hlmFieldDescription>We'll never share it.</p>
  	@if (emailCtrl.invalid && emailCtrl.touched) {
  	<p hlmFieldError>Invalid email format</p>
  	}
  </div>
  ```
- **Sub-API**: `hlmFieldSet`, `hlmFieldLegend`, `hlmFieldGroup`, `hlmFieldContent`, `hlmFieldTitle`, `hlmFieldSeparator`, `hlmFieldDescription`, `hlmFieldError`, `hlmFieldLabel`.
- **Inputs**: `orientation` (`'vertical' | 'horizontal' | 'responsive'`).
- **Gotcha**: Use `hlmFieldLabel` for the label inside Field - **not** `hlmLabel`. Both element (`<hlm-field>`) and directive (`<div hlmField>`) forms are supported.

### Input

- **Pattern**: A (directive on `<input>`)
- **Import**: `HlmInputImports` from `@spartan-ng/helm/input`
- **Use**: Styled native text input.
- **Example**:
  ```html
  <input hlmInput placeholder="Type here" [(ngModel)]="value" />
  <input hlmInput type="email" [formControl]="emailCtrl" />
  ```
- **Brain**: composes `BrnInput` + `BrnFieldControlDescribedBy` (a11y description linkage).
- **Inputs**: `forceInvalid` (boolean - force invalid styling regardless of validity state).
- **Gotcha**: The directive applies to native `<input>`. Passing `type="checkbox"` or `type="radio"` won't give you the Helm Checkbox / Radio components.

### Input Group

- **Pattern**: B (compound)
- **Import**: `HlmInputGroupImports` from `@spartan-ng/helm/input-group`
- **Use**: Input with addons (prefix icons, suffix buttons, etc.).
- **Example**:
  ```html
  <hlm-input-group>
  	<hlm-input-group-addon align="inline-start">
  		<ng-icon hlm name="lucideSearch" />
  	</hlm-input-group-addon>
  	<input hlmInputGroupInput placeholder="Search..." />
  </hlm-input-group>
  ```
- **Sub-components**: `<hlm-input-group-addon>`, `<hlm-input-group-button>`, `<hlm-input-group-text>`, `<hlm-input-group-textarea>`.
- **Align values**: `'inline-start' | 'inline-end' | 'block-start' | 'block-end'`.
- **Gotcha**: Use `hlmInputGroupInput` (not bare `hlmInput`) so the group can strip / round border-radius at the edges correctly.

### Input OTP

- **Pattern**: B (compound, segmented)
- **Imports**: `HlmInputOtpImports` from `@spartan-ng/helm/input-otp` plus `BrnInputOtpImports` from `@spartan-ng/brain/input-otp` for the root wrapper.
- **Use**: One-time-password input with per-digit segments.
- **Example**:
  ```html
  <brn-input-otp maxLength="6" [(ngModel)]="otp">
  	<hlm-input-otp-group>
  		<hlm-input-otp-slot [index]="0" />
  		<hlm-input-otp-slot [index]="1" />
  		<hlm-input-otp-slot [index]="2" />
  		<hlm-input-otp-separator />
  		<hlm-input-otp-slot [index]="3" />
  		<hlm-input-otp-slot [index]="4" />
  		<hlm-input-otp-slot [index]="5" />
  	</hlm-input-otp-group>
  </brn-input-otp>
  ```
- **Inputs**: `maxLength`, `transformPaste`, `inputMode`, `autofocus`.
- **Outputs**: `(completed)`.
- **Gotcha**: The root is `<brn-input-otp>` (Brain), not a Helm wrapper. Helm provides the slot/group/separator visuals only.

### Label

- **Pattern**: A (directive on `<label>`)
- **Import**: `HlmLabelImports` from `@spartan-ng/helm/label`
- **Use**: Form label with consistent typography and disabled-state styling. Outside of `<hlm-field>` only - inside Field, use `hlmFieldLabel`.
- **Example**:
  ```html
  <label hlmLabel for="email">Email address</label> <input hlmInput id="email" />
  ```
- **Gotcha**: Always pair `for=""` with the input's `id` for accessibility - or nest the input inside `<label>`.

### Native Select

- **Pattern**: B (`<hlm-native-select>` element + `[hlmNativeSelectOption]` on `<option>`)
- **Import**: `HlmNativeSelectImports` from `@spartan-ng/helm/native-select`
- **Use**: Styled wrapper for the native `<select>` element - for OS-native dropdown UX.
- **Example**:
  ```html
  <hlm-native-select size="default" [(ngModel)]="value">
  	<option hlmNativeSelectOption value="a">Option A</option>
  	<option hlmNativeSelectOption value="b">Option B</option>
  </hlm-native-select>
  ```
- **Inputs**: `size` (`'default' | 'sm'`).
- **Sub-directive**: `hlmNativeSelectOptGroup` for grouped options.
- **Gotcha**: Use `<hlm-select>` (compound) when you need full visual control over options - native `<option>` cannot be customized.

### Radio Group

- **Pattern**: B (compound)
- **Import**: `HlmRadioGroupImports` from `@spartan-ng/helm/radio-group`
- **Use**: Mutually exclusive choice among 2+ options.
- **Example**:
  ```html
  <hlm-radio-group [(ngModel)]="plan">
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
  ```
- **Item selector**: `<hlm-radio>` (not `<hlm-radio-group-item>`).
- **Item inputs**: `value` (required), `inputId`, `disabled`, ARIA attributes.
- **Item output**: `(change)` emits `BrnRadioChange<T>`.
- **Form integration**: Bind the group via `formControlName`; items don't need individual control names.
- **Gotcha**: Each `<hlm-radio>` requires a `<hlm-radio-indicator indicator />` child for the dot visual.

### Select

- **Pattern**: B (compound + portal)
- **Import**: `HlmSelectImports` from `@spartan-ng/helm/select`
- **Use**: Styled dropdown with full control over option rendering.
- **Example**:
  ```html
  <hlm-select [itemToString]="toLabel">
  	<hlm-select-trigger class="w-56">
  		<hlm-select-value placeholder="Pick a fruit" />
  	</hlm-select-trigger>
  	<hlm-select-content *hlmSelectPortal>
  		<hlm-select-group>
  			<hlm-select-label>Fruits</hlm-select-label>
  			@for (item of items; track item.value) {
  			<hlm-select-item [value]="item.value">{{ item.label }}</hlm-select-item>
  			}
  		</hlm-select-group>
  	</hlm-select-content>
  </hlm-select>
  ```
- **Multi-select**: use `<hlm-select-multiple>` (separate selector) - value is `T[] | null`. Custom value rendering via `<hlm-select-values>` plus `<ng-template hlmSelectValues>`.
- **Brain**: composes `BrnSelect` + `BrnPopover` + `BrnSelect*` sub-directives via `hostDirectives`.
- **`forceInvalid`**: `<hlm-select-trigger [forceInvalid]="emailCtrl.invalid && emailCtrl.touched">` forces the invalid visual state regardless of the underlying validity. The input is on the **trigger**, not on `<hlm-select>`.
- **Gotcha**: `itemToString` must be a stable reference (class field, never inline).

### Slider

- **Pattern**: B (`<hlm-slider>` element)
- **Import**: `HlmSliderImports` from `@spartan-ng/helm/slider`
- **Use**: Numeric range input.
- **Example**:
  ```html
  <hlm-slider [(value)]="volume" [min]="0" [max]="100" [step]="1" />
  ```
- **Gotcha**: Touch-drag works out of the box; mouse-wheel adjustment is opt-in via a Brain config.

### Switch

- **Pattern**: B (`<hlm-switch>` element)
- **Import**: `HlmSwitchImports` from `@spartan-ng/helm/switch`
- **Use**: On/off toggle. Visually distinct from Checkbox - use when the action takes effect immediately.
- **Example**:
  ```html
  <hlm-switch [(checked)]="darkMode" />
  ```
- **Gotcha**: When the action requires save (doesn't take effect immediately), use a Checkbox. Switch implies immediate effect.

### Textarea

- **Pattern**: A (directive on `<textarea>`)
- **Import**: `HlmTextareaImports` from `@spartan-ng/helm/textarea`
- **Use**: Styled multi-line text input.
- **Example**:
  ```html
  <textarea hlmTextarea placeholder="Type your message here." [(ngModel)]="message"></textarea>
  ```
- **Inputs**: `id`, `forceInvalid`.
- **Gotcha**: Textarea is its **own** directive and barrel (`hlmTextarea` / `HlmTextareaImports`) - not the Input directive (`hlmInput`). Auto-resize is not built in; set `rows` or rely on CSS `field-sizing: content`.

### Toggle

- **Pattern**: A (directive on `<button>`)
- **Import**: `HlmToggleImports` from `@spartan-ng/helm/toggle`
- **Use**: Pressable button with a persistent on/off state.
- **Example**:
  ```html
  <button hlmToggle variant="outline" [state]="bold" (stateChange)="bold = $event" aria-label="Bold">B</button>
  ```
- **Variants**: `'default' | 'outline'`.
- **Sizes**: `'sm' | 'default' | 'lg'`.
- **State API**: `state` input (`'on' | 'off'`) plus `(stateChange)` output.
- **Gotcha**: For icon-only toggles, always provide `aria-label`.

### Toggle Group

- **Pattern**: B (compound)
- **Import**: `HlmToggleGroupImports` from `@spartan-ng/helm/toggle-group`
- **Use**: Group of related toggles - single-select (radio-like) or multi-select.
- **Example**:
  ```html
  <hlm-toggle-group type="single" variant="outline" size="default" [(value)]="alignment">
  	<button hlmToggleGroupItem value="left" aria-label="Align left">L</button>
  	<button hlmToggleGroupItem value="center" aria-label="Align center">C</button>
  	<button hlmToggleGroupItem value="right" aria-label="Align right">R</button>
  </hlm-toggle-group>
  ```
- **Group inputs**: `type` (`'single' | 'multiple'`), `variant`, `size`, `orientation`, `spacing`, `disabled`.
- **Outputs**: `valueChange`, `stateChange`.
- **Gotcha**: `type="single"` → value is `string`. `type="multiple"` → value is `string[]`.

## See also

- [Helm conventions](helm-conventions.md) - shared template patterns and imports.
- [Forms integration](forms.md) - ReactiveForms / Signal Forms wiring.
- [Accessibility](accessibility.md) - keyboard and ARIA patterns.
- [Back to SKILL.md](../SKILL.md)
