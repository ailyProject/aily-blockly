import { OnboardingConfig } from '../services/onboarding.service';

/**
 * Guide 页面的新手引导配置
 */
export const GUIDE_ONBOARDING_CONFIG: OnboardingConfig = {
  steps: [
    {
      target: '.menu-box .btn:first-child',
      titleKey: 'GUIDE.ONBOARDING.STEP1_TITLE',
      descKey: 'GUIDE.ONBOARDING.STEP1_DESC',
      position: 'right'
    },
    {
      target: '.menu-box .btn:nth-child(2)',
      titleKey: 'GUIDE.ONBOARDING.STEP2_TITLE',
      descKey: 'GUIDE.ONBOARDING.STEP2_DESC',
      position: 'right'
    },
    {
      target: '.menu-box .btn:nth-child(3)',
      titleKey: 'GUIDE.ONBOARDING.STEP3_TITLE',
      descKey: 'GUIDE.ONBOARDING.STEP3_DESC',
      position: 'right'
    },
    {
      target: '.menu-box .btn:nth-child(4)',
      titleKey: 'GUIDE.ONBOARDING.STEP4_TITLE',
      descKey: 'GUIDE.ONBOARDING.STEP4_DESC',
      position: 'right'
    },
    {
      target: '.right-box .item:first-child',
      titleKey: 'GUIDE.ONBOARDING.STEP5_TITLE',
      descKey: 'GUIDE.ONBOARDING.STEP5_DESC',
      position: 'left'
    },
    {
      target: '.right-box .item:nth-child(2)',
      titleKey: 'GUIDE.ONBOARDING.STEP6_TITLE',
      descKey: 'GUIDE.ONBOARDING.STEP6_DESC',
      position: 'left'
    },
    {
      target: '.right-box .item:nth-child(3)',
      titleKey: 'GUIDE.ONBOARDING.STEP7_TITLE',
      descKey: 'GUIDE.ONBOARDING.STEP7_DESC',
      position: 'left'
    }
  ]
};

/**
 * Blockly 编辑器的新手引导配置
 */
export const BLOCKLY_ONBOARDING_CONFIG: OnboardingConfig = {
  steps: [
    {
      target: '.blocklyToolboxDiv',
      titleKey: 'BLOCKLY.ONBOARDING.TOOLBOX_TITLE',
      descKey: 'BLOCKLY.ONBOARDING.TOOLBOX_DESC',
      position: 'right'
    },
    {
      target: '.project-mangager-btn',
      titleKey: 'BLOCKLY.ONBOARDING.LIB_MANAGER_TITLE',
      descKey: 'BLOCKLY.ONBOARDING.LIB_MANAGER_DESC',
      position: 'top'
    },
    {
      target: '.blocklyWorkspace',
      titleKey: 'BLOCKLY.ONBOARDING.WORKSPACE_TITLE',
      descKey: 'BLOCKLY.ONBOARDING.WORKSPACE_DESC',
      position: 'left'
    },
    {
      target: '[data-action="compile"]',
      titleKey: 'BLOCKLY.ONBOARDING.BUILD_TITLE',
      descKey: 'BLOCKLY.ONBOARDING.BUILD_DESC',
      position: 'bottom'
    },
    {
      target: '[data-action="upload"]',
      titleKey: 'BLOCKLY.ONBOARDING.UPLOAD_TITLE',
      descKey: 'BLOCKLY.ONBOARDING.UPLOAD_DESC',
      position: 'bottom'
    },
  ]
};

/**
 * Aily Chat 的新手引导配置
 */
export const AILY_CHAT_ONBOARDING_CONFIG: OnboardingConfig = {
  steps: [
    {
      target: '.input-box textarea',
      titleKey: 'AILY_CHAT.ONBOARDING.STEP1_TITLE',
      descKey: 'AILY_CHAT.ONBOARDING.STEP1_DESC',
      position: 'top'
    },
    {
      target: '.input-box .btns .btn:first-child',
      titleKey: 'AILY_CHAT.ONBOARDING.STEP2_TITLE',
      descKey: 'AILY_CHAT.ONBOARDING.STEP2_DESC',
      position: 'top'
    },
    {
      target: '.input-box .btns .btn.mode',
      titleKey: 'AILY_CHAT.ONBOARDING.STEP3_TITLE',
      descKey: 'AILY_CHAT.ONBOARDING.STEP3_DESC',
      position: 'top'
    },
    {
      target: '.input-box .btns .btn.right',
      titleKey: 'AILY_CHAT.ONBOARDING.STEP4_TITLE',
      descKey: 'AILY_CHAT.ONBOARDING.STEP4_DESC',
      position: 'top'
    }
  ]
};
