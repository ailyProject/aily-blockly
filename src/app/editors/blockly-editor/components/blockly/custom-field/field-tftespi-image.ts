// TFT_eSPI images share the external binary storage and rendering lifecycle of
// the animation field. Keep this module as the dedicated import/translator
// entry point introduced by main without registering a second field class.
export {
  setTftEsPiAnimationFieldTranslator as setTftEsPiImageFieldTranslator,
} from './field-tftespi-animation';
