import * as Blockly from 'blockly';

interface ToneInfo {
  display: string;
  color: string;
  position: number;
  isSharp: boolean;
}

type ToneMap = Record<string, ToneInfo>;

type TonePickerValidator = (newValue: string) => string | null;

/**
 * 音调选择器
 */
export class FieldTonePicker extends Blockly.FieldTextInput {
  private toneMap: ToneMap;
  private selectedTone: string;
  private pianoDiv: HTMLElement | null = null;

  /**
   * 构造函数
   */
  constructor(
    initialValue: string,
    validator?: TonePickerValidator | null,
    config?: Blockly.FieldConfig
  ) {
    const finalValidator = function(newValue: string): string | null {
      if (validator) {
        newValue = validator(newValue) || newValue;
      }
      return newValue;
    };

    // v13 validates the initial value in the base constructor. Defer it until
    // the tone lookup used by our validator has been initialized.
    super(Blockly.Field.SKIP_SETUP, finalValidator, config);

    this.selectedTone = initialValue;

    this.toneMap = {
      '131': { display: '1低C/C3', color: '#FF9900', position: 0, isSharp: false },
      '139': { display: '1低C#/C#3', color: '#FF6600', position: 1, isSharp: true },
      '147': { display: '2低D/D3', color: '#FF3300', position: 2, isSharp: false },
      '156': { display: '2低D#/D#3', color: '#FF0000', position: 3, isSharp: true },
      '165': { display: '3低E/E3', color: '#FF0066', position: 4, isSharp: false },
      '175': { display: '4低F/F3', color: '#CC00FF', position: 5, isSharp: false },
      '185': { display: '4低F#/F#3', color: '#9900FF', position: 6, isSharp: true },
      '196': { display: '5低G/G3', color: '#6600FF', position: 7, isSharp: false },
      '208': { display: '5低G#/G#3', color: '#3300FF', position: 8, isSharp: true },
      '220': { display: '6低A/A3', color: '#0000FF', position: 9, isSharp: false },
      '233': { display: '6低A#/A#3', color: '#0066FF', position: 10, isSharp: true },
      '247': { display: '7低B/B3', color: '#00CCFF', position: 11, isSharp: false },
      '262': { display: '1中C/C4', color: '#00FFCC', position: 12, isSharp: false },
      '277': { display: '1中C#/C#4', color: '#00FF66', position: 13, isSharp: true },//
      '294': { display: '2中D/D4', color: '#00FF33', position: 14, isSharp: false },
      '311': { display: '2中D#/D#4', color: '#00FF00', position: 15, isSharp: true },
      '330': { display: '3中E/E4', color: '#00CCFF', position: 16, isSharp: false },
      '349': { display: '4中F/F4', color: '#FFCC00', position: 17, isSharp: false },
      '370': { display: '4中F#/F#4', color: '#FF9900', position: 18, isSharp: true },//
      '392': { display: '5中G/G4', color: '#FF0066', position: 19, isSharp: false },
      '415': { display: '5中G#/G#4', color: '#FF0066', position: 20, isSharp: true },
      '440': { display: '6中A/A4', color: '#FF00FF', position: 21, isSharp: false },
      '466': { display: '6中A#/A#4', color: '#00CCFF', position: 22, isSharp: true },
      '494': { display: '7中B/B4', color: '#FF00FF', position: 23, isSharp: false },
      '523': { display: '1高C/C5', color: '#FF6600', position: 24, isSharp: false },
      '554': { display: '1高C#/C#5', color: '#FF6600', position: 25, isSharp: true },//
      '587': { display: '2高D/D5', color: '#FF3300', position: 26, isSharp: false },
      '622': { display: '2高D#/D#5', color: '#FF3300', position: 27, isSharp: true },
      '659': { display: '3高E/E5', color: '#FF0000', position: 28, isSharp: false },
      '698': { display: '4高F/F5', color: '#FF6600', position: 29, isSharp: false },
      '740': { display: '4高F#/F#5', color: '#FF6600', position: 30, isSharp: true },//
      '784': { display: '5高G/G5', color: '#FF0000', position: 31, isSharp: false },
      '831': { display: '5高G#/G#5', color: '#FF0000', position: 32, isSharp: true },
      '880': { display: '6高A/A5', color: '#FF6600', position: 33, isSharp: false },
      '932': { display: '6高A#/A#5', color: '#FF6600', position: 34, isSharp: true },
      '988': { display: '7高B/B5', color: '#FF6600', position: 35, isSharp: false },
    };

    if (!this.toneMap[initialValue]) {
      this.selectedTone = '131';
    }
    this.setValue(this.selectedTone);

    this.size_ = new Blockly.utils.Size(120, 25);
  }

  /**
   * 初始化DOM
   */
  override initView() {
    super.initView();

    const textElement = this.textElement_ as SVGTextElement;

    if (textElement) {
      textElement.style.cssText = `
        font-size: 14px;
        text-align: center;
      `;

      textElement.textContent = this.getDisplayText();
    }

    if (this.borderRect_) {
      this.borderRect_.setAttribute('rx', '4');
      this.borderRect_.setAttribute('ry', '4');
      this.borderRect_.setAttribute('fill', this.toneMap[this.selectedTone]?.color || '#FFFFFF');
      this.borderRect_.setAttribute('stroke', '#999999');
      this.borderRect_.setAttribute('stroke-width', '1');
    }
  }

  /**
   * 获取当前音调的显示文本
   */
  private getDisplayText(): string {
    return this.toneMap[this.selectedTone]?.display || this.selectedTone + ' Hz';
  }

  /**
   * 创建钢琴键盘UI
   */
  private createPianoKeyboard(): HTMLElement {
    const pianoDiv = document.createElement('div');
    pianoDiv.className = 'blocklyPianoKeyboard';
    pianoDiv.style.cssText = `
      width: 420px;
      height: 180px;
      position: relative;
      background-color: #f0f0f0;
      border-radius: 4px;
      overflow: hidden;
    `;

    const controlBar = document.createElement('div');
    controlBar.className = 'pianoControlBar';
    controlBar.style.cssText = `
      width: 100%;
      height: 30px;
      background-color: #1e8a5a;
      display: flex;
      align-items: center;
      padding: 0 10px;
      color: white;
      font-size: 12px;
    `;

    controlBar.innerHTML = `
      <span style="margin-right: 10px;">音调</span>
      <span style="margin-right: 5px;">${this.selectedTone} Hz</span>
    `;

    pianoDiv.appendChild(controlBar);

    const keyboardDiv = document.createElement('div');
    keyboardDiv.style.cssText = `
      position: relative;
      width: 100%;
      height: 120px;
      margin-top: 5px;
    `;
    pianoDiv.appendChild(keyboardDiv);

    const keys = [
      { note: '131', isSharp: false, position: 0 },
      { note: '139', isSharp: true, position: 0.7 },
      { note: '147', isSharp: false, position: 1 },
      { note: '156', isSharp: true, position: 1.7 },
      { note: '165', isSharp: false, position: 2 },
      { note: '175', isSharp: false, position: 3 },
      { note: '185', isSharp: true, position: 3.7 },
      { note: '196', isSharp: false, position: 4 },
      { note: '208', isSharp: true, position: 4.7 },
      { note: '220', isSharp: false, position: 5 },
      { note: '233', isSharp: true, position: 5.7 },
      { note: '247', isSharp: false, position: 6 },
      { note: '262', isSharp: false, position: 7 },
      { note: '277', isSharp: true, position: 7.7 },
      { note: '294', isSharp: false, position: 8 },
      { note: '311', isSharp: true, position: 8.7 },
      { note: '330', isSharp: false, position: 9 },
      { note: '349', isSharp: false, position: 10 },
      { note: '370', isSharp: true, position: 10.7 },
      { note: '392', isSharp: false, position: 11 },
      { note: '415', isSharp: true, position: 11.7 },
      { note: '440', isSharp: false, position: 12 },
      { note: '466', isSharp: true, position: 12.7 },
      { note: '494', isSharp: false, position: 13 },
      { note: '523', isSharp: false, position: 14 },
      { note: '554', isSharp: true, position: 14.7 },
      { note: '587', isSharp: false, position: 15 },
      { note: '622', isSharp: true, position: 15.7 },
      { note: '659', isSharp: false, position: 16 },
      { note: '698', isSharp: false, position: 17 },
      { note: '740', isSharp: true, position: 17.7 },
      { note: '784', isSharp: false, position: 18 },
      { note: '831', isSharp: true, position: 18.7 },
      { note: '880', isSharp: false, position: 19 },
      { note: '932', isSharp: true, position: 19.7 },
      { note: '988', isSharp: false, position: 20 },
    ];

    const whiteKeyWidth = 100 / keys.filter(v => !v.isSharp).length;
    const blackKeyWidth = whiteKeyWidth * 0.6;
    const whiteKeyHeight = '100%';
    const blackKeyHeight = '60%';

    // 白键
    keys.filter(key => !key.isSharp).forEach(key => {
      const keyElement = document.createElement('div');
      const keyColor = this.selectedTone === key.note ? this.toneMap[this.selectedTone]?.color : 'white';
      keyElement.className = 'pianoKey whiteKey';
      keyElement.setAttribute('data-note', key.note);
      keyElement.style.cssText = `
        position: absolute;
        width: ${whiteKeyWidth}%;
        height: ${whiteKeyHeight};
        left: ${key.position * whiteKeyWidth}%;
        background-color: ${keyColor};
        border: 1px solid #ccc;
        box-sizing: border-box;
        border-radius: 0 0 4px 4px;
        cursor: pointer;
      `;
      keyElement.addEventListener('click', e => this.handleKeyClick(e));
      keyboardDiv.appendChild(keyElement);
    });

    // 黑键
    keys.filter(key => key.isSharp).forEach(key => {
      const keyElement = document.createElement('div');
      const keyColor = this.selectedTone === key.note ? this.toneMap[this.selectedTone]?.color : 'black';
      keyElement.className = 'pianoKey blackKey';
      keyElement.setAttribute('data-note', key.note);
      keyElement.style.cssText = `
        position: absolute;
        width: ${blackKeyWidth}%;
        height: ${blackKeyHeight};
        left: ${key.position * whiteKeyWidth}%;
        background-color: ${keyColor};
        border: 1px solid #000;
        box-sizing: border-box;
        border-radius: 0 0 4px 4px;
        cursor: pointer;
        z-index: 2;
      `;
      keyElement.addEventListener('click', e => this.handleKeyClick(e));
      keyboardDiv.appendChild(keyElement);
    });

    const bottomBar = document.createElement('div');
    bottomBar.className = 'pianoBottomBar';
    bottomBar.style.cssText = `
      width: 100%;
      height: 24px;
      background-color: #ff6600;
      position: absolute;
      bottom: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      color: white;
      font-size: 14px;
    `;
    bottomBar.textContent = this.toneMap[this.selectedTone]?.display || this.selectedTone;
    pianoDiv.appendChild(bottomBar);

    this.pianoDiv = pianoDiv;
    return pianoDiv;
  }

  /**
   * 处理钢琴键点击事件
   */
  private handleKeyClick(e: Event): void {
    const target = e.target as HTMLElement;
    const note = target.getAttribute('data-note');

    if (note && this.toneMap[note]) {
      this.selectedTone = note;

      if (this.pianoDiv) {
        const bottomBar = this.pianoDiv.querySelector('.pianoBottomBar');
        if (bottomBar) {
          bottomBar.textContent = this.toneMap[note].display;
        }
      }

      this.setValue(note);
      Blockly.DropDownDiv.hideWithoutAnimation();
    }
  }

  /**
   * 方块颜色
   */
  private updateBlockColor_(tone: string): void {
    if (this.sourceBlock_ && this.toneMap[tone]) {
      this.sourceBlock_.setColour(this.toneMap[tone].color);
    }
  }

  /**
   * 编辑器
   */
  override showEditor_(e?: Event) {
    super.showEditor_(e, true, false);

    Blockly.DropDownDiv.hideWithoutAnimation();
    Blockly.DropDownDiv.clearContent();

    const container = document.createElement('div');
    container.appendChild(this.createPianoKeyboard());

    Blockly.DropDownDiv.getContentDiv().appendChild(container);

    Blockly.DropDownDiv.setColour('#f0f0f0', '#cccccc');
    Blockly.DropDownDiv.showPositionedByField(this, this.dropdownDispose_.bind(this));
  }

  /**
   * 处理下拉框关闭
   */
  private dropdownDispose_(): void {
    this.pianoDiv = null;
  }

  /**
   * 设置值
   */
  override setValue(newValue: string): void {
    if (this.sourceBlock_ && Blockly.Events.isEnabled()) {
      this.selectedTone = newValue;
    }
    super.setValue(newValue);
  }

  /**
   * 值更新处理
   */
  protected override doValueUpdate_(newValue: string): void {
    if (!/^\d+$/.test(newValue)) {
      newValue = '0';
    }
    super.doValueUpdate_(newValue);

    this.updateBlockColor_(newValue);

    this.selectedTone = newValue;
    if (this.textElement_) {
      this.textElement_.textContent = this.getDisplayText();
    }

    if (this.borderRect_) {
      this.borderRect_.setAttribute('fill', this.toneMap[newValue]?.color || '#FFFFFF');
    }
  }

  /**
   * 值验证处理
   */
  protected override doClassValidation_(newValue?: string): string | null {
    if (!newValue) return this.selectedTone;

    if (this.toneMap[newValue]) {
      return newValue;
    }

    return this.selectedTone;
  }

  /**
   * 判断是否可编辑
   */
  override isClickable(): boolean {
    return true;
  }

  /**
   * 字段类名，用于CSS样式
   */
  getCssClass(): string {
    return 'blocklyTonePicker blocklyDropdownText';
  }
}

Blockly.fieldRegistry.register('field_tone_picker', FieldTonePicker);

Blockly.Css.register(`
.pianoKey:hover {
  background-color: red !important;
}
`);

// TODO @coloz @lib-core-tone 12:18:field_tone_picker

// Blockly.Blocks['tone_selector'] =
// {
//   "type": "tone_selector",
//   "message0": "选择音调: %1",
//   "args0": [
//   {
//     "type": "field_tone_picker",
//     "name": "TONE",
//     "value": "131"
//   }
// ],
//   "colour": "#FF9900",
//   "tooltip": "选择音乐音调",
//   "helpUrl": ""
// }

// Blockly.Blocks['tone_selector'] = {
//   init: function() {
//     this.appendDummyInput()
//       .appendField('选择音调:')
//       .appendField(new FieldTonePicker('C3'), 'TONE');
//     this.setColour('#FF9900');
//     this.setTooltip('选择音乐音调');
//     this.setHelpUrl('');
//   }
// };

// if ((Blockly as any).JavaScript) {
//   (Blockly as any).JavaScript['tone_selector'] = function(block: any) {
//     const tone = block.getFieldValue('TONE');
//     return [`'${tone}'`, (Blockly as any).JavaScript.ORDER_ATOMIC];
//   };
// }
