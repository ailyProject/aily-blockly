const fs = require('fs');
const path = require('path');

const EN_SECTION_TITLE = '### Changes';
const ZH_SECTION_TITLE = '### 更新内容';
const COMMITS_FILE = process.env.CHANGELOG_COMMITS_FILE || '/tmp/commits.txt';
const CHANGELOG_EN_FILE = process.env.CHANGELOG_EN_FILE || '/tmp/changelog_en.md';
const CHANGELOG_ZH_FILE = process.env.CHANGELOG_ZH_FILE || '/tmp/changelog_zh.md';

const EN_CATEGORY_ORDER = [
  '✨ New Features',
  '🐛 Bug Fixes',
  '⚡ Performance',
  '🔧 Improvements',
];
const ZH_CATEGORY_ORDER = [
  '✨ 新功能',
  '🐛 问题修复',
  '⚡ 性能优化',
  '🔧 体验改进',
];

const EN_CATEGORY_ALIASES = {
  '✨ New Features': '✨ New Features',
  'New Features': '✨ New Features',
  '### ✨ New Features': '✨ New Features',
  '### New Features': '✨ New Features',
  '🐛 Bug Fixes': '🐛 Bug Fixes',
  'Bug Fixes': '🐛 Bug Fixes',
  '### 🐛 Bug Fixes': '🐛 Bug Fixes',
  '### Bug Fixes': '🐛 Bug Fixes',
  '⚡ Performance': '⚡ Performance',
  'Performance': '⚡ Performance',
  '### ⚡ Performance': '⚡ Performance',
  '### Performance': '⚡ Performance',
  '🔧 Improvements': '🔧 Improvements',
  'Improvements': '🔧 Improvements',
  '### 🔧 Improvements': '🔧 Improvements',
  '### Improvements': '🔧 Improvements',
};

const ZH_CATEGORY_ALIASES = {
  '✨ 新功能': '✨ 新功能',
  '新功能': '✨ 新功能',
  '### ✨ 新功能': '✨ 新功能',
  '### 新功能': '✨ 新功能',
  '🐛 问题修复': '🐛 问题修复',
  '问题修复': '🐛 问题修复',
  '### 🐛 问题修复': '🐛 问题修复',
  '### 问题修复': '🐛 问题修复',
  '⚡ 性能优化': '⚡ 性能优化',
  '性能优化': '⚡ 性能优化',
  '### ⚡ 性能优化': '⚡ 性能优化',
  '### 性能优化': '⚡ 性能优化',
  '🔧 体验改进': '🔧 体验改进',
  '体验改进': '🔧 体验改进',
  '### 🔧 体验改进': '🔧 体验改进',
  '### 体验改进': '🔧 体验改进',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripThinkTags(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\/?think>/g, '')
    .trim();
}

function buildCompletionUrl(baseUrl, completionsPath) {
  const requestPath = (completionsPath || 'chat/completions').trim();
  if (requestPath.startsWith('http://') || requestPath.startsWith('https://')) {
    return requestPath;
  }
  return `${baseUrl.replace(/\/+$/, '')}/${requestPath.replace(/^\/+/, '')}`;
}

function canUseOpenAiSdk(openaiCtor, completionsPath) {
  const requestPath = (completionsPath || 'chat/completions').trim().replace(/^\/+|\/+$/g, '');
  return Boolean(openaiCtor) && requestPath === 'chat/completions';
}

async function loadOpenAiCtor() {
  try {
    const mod = await import('openai');
    return mod.default || mod.OpenAI;
  } catch {
    return null;
  }
}

function createOpenAiClient(openaiCtor, apiKey, baseUrl) {
  const options = {
    apiKey,
    timeout: 90_000,
    maxRetries: 0,
  };
  if (baseUrl) {
    options.baseURL = baseUrl.replace(/\/+$/, '');
  }
  return new openaiCtor(options);
}

function parseSdkCompletion(completion) {
  const choices = completion?.choices || [];
  if (!choices.length) {
    throw new Error('AI response missing choices');
  }
  let content = choices[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content.map(part => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join('');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI response content is empty');
  }
  return stripThinkTags(content);
}

function parseRestCompletion(data) {
  const choices = data?.choices || [];
  if (!choices.length) {
    throw new Error('AI response missing choices');
  }
  let content = choices[0]?.message?.content;
  if (content == null) {
    content = choices[0]?.text;
  }
  if (Array.isArray(content)) {
    content = content.map(part => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join('');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI response content is empty');
  }
  return stripThinkTags(content);
}

async function callRestCompletion(completionUrl, apiKey, payload) {
  const response = await fetch(completionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return parseRestCompletion(await response.json());
}

function buildRepairPrompt(version, rawChangelog, sectionTitle, categoryOrder, language) {
  const orderedCategories = categoryOrder.join(', ');
  return (
    `Rewrite the following ${language} desktop application changelog so it strictly matches the required Markdown format.\n\n` +
    `Required first line: ## ${version}\n` +
    `Required second line: ${sectionTitle}\n` +
    `Allowed category headings in order: ${orderedCategories}\n\n` +
    'Rules:\n' +
    '- Keep only user-facing release notes.\n' +
    '- Use bullet points only under category headings.\n' +
    '- Omit empty categories.\n' +
    '- Do not add explanations, summaries, or code fences.\n' +
    '- Output pure Markdown only.\n\n' +
    'Source changelog to repair:\n' +
    rawChangelog
  );
}

function normalizeChangelogOutput(rawOutput, version, sectionTitle, categoryAliases, categoryOrder) {
  const lines = stripThinkTags(rawOutput || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const categories = Object.fromEntries(categoryOrder.map(heading => [heading, []]));
  let currentCategory = null;
  let bulletCount = 0;
  let sawSectionTitle = false;
  let unexpectedContent = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === `## ${version}`) continue;

    if (line === sectionTitle || line.replace(/^#+/, '').trim() === sectionTitle.replace(/^#+/, '').trim()) {
      sawSectionTitle = true;
      continue;
    }

    let normalizedHeading = categoryAliases[line];
    if (!normalizedHeading) {
      normalizedHeading = categoryAliases[line.replace(/^#+/, '').trim()];
    }
    if (normalizedHeading) {
      currentCategory = normalizedHeading;
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      let bulletText = line.replace(/^[*-]\s+/, '').trim();
      while (bulletText.startsWith('- ') || bulletText.startsWith('* ')) {
        bulletText = bulletText.replace(/^[*-]\s+/, '').trim();
      }
      if (!bulletText) {
        unexpectedContent = true;
        continue;
      }
      if (!currentCategory) {
        currentCategory = categoryOrder[categoryOrder.length - 1];
      }
      categories[currentCategory].push(`- ${bulletText}`);
      bulletCount += 1;
      continue;
    }

    if (currentCategory && categories[currentCategory].length) {
      const bullets = categories[currentCategory];
      bullets[bullets.length - 1] += ` ${line}`;
      continue;
    }

    unexpectedContent = true;
  }

  const normalizedSections = [];
  for (const heading of categoryOrder) {
    const bullets = categories[heading];
    if (!bullets.length) continue;
    normalizedSections.push(heading, ...bullets, '');
  }

  if (!normalizedSections.length) {
    return { text: `## ${version}\n\n${sectionTitle}\n`, valid: false, bulletCount: 0 };
  }

  const text = `## ${version}\n\n${sectionTitle}\n\n${normalizedSections.join('\n').trimEnd()}\n`;
  return {
    text,
    valid: sawSectionTitle && bulletCount > 0 && !unexpectedContent,
    bulletCount,
  };
}

function buildFallbackChangelog(version, sectionTitle, categoryHeading, bulletText) {
  return {
    text: `## ${version}\n\n${sectionTitle}\n\n${categoryHeading}\n- ${bulletText}\n`,
    bulletCount: 1,
  };
}

function writeTextFile(filePath, content) {
  const parentDir = path.dirname(filePath);
  if (parentDir && parentDir !== '.') {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeFallbackChangelogs(version, enText, zhText) {
  writeTextFile(
    CHANGELOG_EN_FILE,
    buildFallbackChangelog(version, EN_SECTION_TITLE, '🔧 Improvements', enText).text,
  );
  writeTextFile(
    CHANGELOG_ZH_FILE,
    buildFallbackChangelog(version, ZH_SECTION_TITLE, '🔧 体验改进', zhText).text,
  );
}

function logInvalidChangelogPreview(label, rawOutput) {
  const preview = stripThinkTags(rawOutput || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  console.log(`--- Invalid ${label} Raw Preview ---`);
  console.log(preview ? preview.slice(0, 500) : '(empty)');
}

function logModelConfigs(requestLabel, modelConfigs) {
  const models = modelConfigs.map(config => config.model || '(unnamed-model)');
  console.log(`ℹ️ ${requestLabel}: available model configs (${modelConfigs.length}): ${JSON.stringify(models)}`);
}

async function callAiWithFallbacks(openaiCtor, modelConfigs, prompt, requestLabel = 'AI request') {
  let lastError = null;

  for (const [index, config] of modelConfigs.entries()) {
    const configIndex = index + 1;
    const { baseUrl, apiKey, model, completionsPath } = config;
    if (!apiKey || !model) {
      console.log(`⚠️ ${requestLabel}: model config #${configIndex} skipped (apiKey or model is empty)`);
      continue;
    }
    if (!baseUrl && !canUseOpenAiSdk(openaiCtor, completionsPath)) {
      console.log(`⚠️ ${requestLabel}: model config #${configIndex} skipped (baseUrl is empty and SDK is unavailable)`);
      continue;
    }

    const payload = {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.3,
    };
    const completionUrl = baseUrl ? buildCompletionUrl(baseUrl, completionsPath) : '';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        console.log(`→ ${requestLabel}: calling model config #${configIndex}: ${model} (attempt ${attempt}/3)`);
        let result;
        if (canUseOpenAiSdk(openaiCtor, completionsPath)) {
          const client = createOpenAiClient(openaiCtor, apiKey, baseUrl);
          result = parseSdkCompletion(await client.chat.completions.create(payload));
        } else {
          if (!openaiCtor) {
            console.log(`ℹ️ ${requestLabel}: OpenAI SDK is unavailable; using fetch fallback`);
          } else {
            console.log(`ℹ️ ${requestLabel}: custom completions path configured; using fetch fallback`);
          }
          result = await callRestCompletion(completionUrl, apiKey, payload);
        }

        console.log(`✓ ${requestLabel}: succeeded with model config #${configIndex} (${model})`);
        return { content: result, model, configIndex };
      } catch (error) {
        lastError = error;
        const status = error?.status;
        const retryable = !status || [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
        console.log(`⚠️ ${requestLabel}: model config #${configIndex} (${model}) failed on attempt ${attempt}: ${error.message}`);
        if (!retryable) break;
      }

      if (attempt < 3) {
        await sleep(2 ** attempt * 1000);
      }
    }

    console.log(`⚠️ ${requestLabel}: model config #${configIndex} (${model}) exhausted, trying next...`);
  }

  throw lastError || new Error('No valid model config available');
}

function readCommits() {
  try {
    return fs.readFileSync(COMMITS_FILE, 'utf8').trim();
  } catch {
    console.log('⚠️ Could not read commits.txt');
    return '';
  }
}

function getModelConfigs(openaiCtor) {
  const cfg = suffix => ({
    baseUrl: (process.env[`AI_BASE_URL${suffix}`] || '').replace(/\/+$/, ''),
    apiKey: process.env[`AI_API_KEY${suffix}`] || '',
    model: process.env[`AI_MODEL${suffix}`] || '',
    completionsPath: (process.env[`AI_COMPLETIONS_PATH${suffix}`] || '').trim(),
  });
  return [cfg(''), cfg('2'), cfg('3')].filter(config => (
    config.apiKey && config.model && (config.baseUrl || openaiCtor)
  ));
}

async function main() {
  const version = process.env.RELEASE_VERSION || '';
  const openaiCtor = await loadOpenAiCtor();
  const modelConfigs = getModelConfigs(openaiCtor);
  const commits = readCommits() || '(no commit records)';

  if (!modelConfigs.length) {
    console.log('⚠️ No AI model config is set, skipping AI generation');
    writeFallbackChangelogs(version, 'Maintenance and dependency updates.', '维护和依赖更新。');
    return;
  }

  console.log(`✓ ${modelConfigs.length} model config(s) available: ${JSON.stringify(modelConfigs.map(config => config.model))}`);

  logModelConfigs('Changelog generation', modelConfigs);
  const promptEn = (
    'You are a professional software release note writer for a desktop application (Electron + Angular). ' +
    'Analyze the following Git commit records and produce a polished, user-facing changelog IN ENGLISH ONLY.\n\n' +
    `Version: ${version}\n\n` +
    `Raw commit records:\n${commits}\n\n` +
    '## Your task\n' +
    'Understand **what changed for the end user**, then write a concise release note. ' +
    'Do NOT mechanically re-list commit messages — think about the actual impact and summarize.\n\n' +
    '## Filtering rules (MUST follow)\n' +
    'Completely IGNORE commits that are purely internal and invisible to users, including but not limited to:\n' +
    '- CI/CD pipeline changes (GitHub Actions, workflows, build scripts, signing, deployment)\n' +
    '- Code refactoring, renaming, restructuring with no behavior change\n' +
    '- Dependency version bumps (npm update, package-lock changes) unless they fix a known user-facing issue\n' +
    '- Typo fixes in code or comments (not in UI text)\n' +
    '- Linting, formatting, code style changes\n' +
    '- Merge commits, revert-then-redo sequences\n' +
    '- Test additions or modifications\n' +
    '- Documentation changes (README, dev docs) unless they are user-facing help docs\n' +
    '- Debug logging additions/removals\n' +
    'If all commit records are internal maintenance with no clear user-facing change, output exactly one bullet under 🔧 Improvements: Maintenance and dependency updates.\n\n' +
    '## Summarization rules\n' +
    '1. Group related commits (e.g. 5 commits about improving serial port connection) into ONE concise bullet point describing the net result.\n' +
    '2. Focus on WHAT the user can see/feel, not HOW it was implemented. ' +
    "Bad: 'Refactored WebSocket reconnection logic'. Good: 'Improved connection stability'.\n" +
    '3. Aim for 3–10 bullet points total. If fewer meaningful changes exist, output fewer. Quality over quantity.\n' +
    '4. If a feature was added then immediately fixed in follow-up commits, describe only the final working state.\n\n' +
    '## Output format\n' +
    '- Output must start with exactly these two lines:\n' +
    `  ## ${version}\n` +
    '  ### Changes\n' +
    '- After that, use ONLY these category headings and keep them in this exact order when present: ✨ New Features, 🐛 Bug Fixes, ⚡ Performance, 🔧 Improvements. Omit empty categories.\n' +
    '- Do not use any other headings, labels, intro text, outro text, summary sentence, or notes.\n' +
    '- Under each category, use bullet points only. No paragraphs outside bullets.\n' +
    '- Keep the total bullet count between 3 and 10 when possible.\n' +
    '- Do not duplicate categories or repeat the same change in multiple categories.\n' +
    '- Output pure Markdown only. No code block wrappers.\n' +
    '- Do NOT wrap output in <think> tags or any XML-like tags.'
  );

  let rawChangelogEn;
  try {
    const enResult = await callAiWithFallbacks(openaiCtor, modelConfigs, promptEn, 'English changelog generation');
    rawChangelogEn = enResult.content;
    console.log(`ℹ️ English changelog generation final model: ${enResult.model} (config #${enResult.configIndex})`);
    console.log('✓ English changelog generated successfully');
  } catch (error) {
    console.log(`⚠️ English changelog AI generation failed on all models: ${error.message}`);
    rawChangelogEn = `## ${version}\n\n${EN_SECTION_TITLE}\n\n- ${commits}`;
  }

  let en = normalizeChangelogOutput(rawChangelogEn, version, EN_SECTION_TITLE, EN_CATEGORY_ALIASES, EN_CATEGORY_ORDER);
  if (!en.valid) {
    console.log('⚠️ English changelog format invalid, retrying with repair prompt');
    logInvalidChangelogPreview('English changelog', rawChangelogEn);
    try {
      const repairedEnResult = await callAiWithFallbacks(
        openaiCtor,
        modelConfigs,
        buildRepairPrompt(version, rawChangelogEn, EN_SECTION_TITLE, EN_CATEGORY_ORDER, 'English'),
        'English changelog repair',
      );
      console.log(`ℹ️ English changelog repair final model: ${repairedEnResult.model} (config #${repairedEnResult.configIndex})`);
      en = normalizeChangelogOutput(repairedEnResult.content, version, EN_SECTION_TITLE, EN_CATEGORY_ALIASES, EN_CATEGORY_ORDER);
    } catch (error) {
      console.log(`⚠️ English changelog repair failed: ${error.message}`);
    }
  }

  if (!en.valid) {
    console.log('⚠️ Falling back to minimal English changelog due to invalid format');
    en = buildFallbackChangelog(version, EN_SECTION_TITLE, '🔧 Improvements', 'Maintenance and dependency updates.');
  }

  writeTextFile(CHANGELOG_EN_FILE, en.text);
  console.log('--- English Changelog Preview ---');
  console.log(en.text.slice(0, 500));

  logModelConfigs('Changelog translation', modelConfigs);
  const promptZh = (
    'You are a professional technical translator for desktop software release notes. ' +
    'Translate the following English changelog into Simplified Chinese.\n\n' +
    `Version: ${version}\n\n` +
    '## Source Markdown\n' +
    `${en.text}\n\n` +
    '## Translation requirements\n' +
    '1. Preserve the original Markdown structure exactly: keep the same headings, emoji category markers, bullet structure, and paragraph grouping.\n' +
    "2. Use these exact heading translations when they appear in the source: '### Changes' -> '### 更新内容', '✨ New Features' -> '✨ 新功能', '🐛 Bug Fixes' -> '🐛 问题修复', '⚡ Performance' -> '⚡ 性能优化', '🔧 Improvements' -> '🔧 体验改进'. Do not invent extra headings.\n" +
    '3. Keep the exact same number of sections and bullet points in the exact same order. Do not merge, split, drop, or add bullets.\n' +
    '4. Translate only the user-facing natural language into Simplified Chinese. Keep version numbers, file names, tag names, product names, API names, branch names, and technical identifiers unchanged unless they have a well-established Chinese translation.\n' +
    '5. Do not add, remove, infer, soften, or amplify meaning. The Chinese output must be a faithful translation of the English source only.\n' +
    '6. Output pure Markdown only. No code fences, no explanations, and no <think> tags or XML-like tags.'
  );

  let rawChangelogZh;
  try {
    const zhResult = await callAiWithFallbacks(openaiCtor, modelConfigs, promptZh, 'Chinese changelog translation');
    rawChangelogZh = zhResult.content;
    console.log(`ℹ️ Chinese changelog translation final model: ${zhResult.model} (config #${zhResult.configIndex})`);
    console.log('✓ Chinese changelog translated successfully');
  } catch (error) {
    console.log(`⚠️ Chinese changelog translation failed on all models: ${error.message}`);
    rawChangelogZh = `## ${version}\n\n${ZH_SECTION_TITLE}\n\n🔧 体验改进\n- （中文翻译生成失败，请查阅 CHANGELOG.md）\n`;
  }

  let zh = normalizeChangelogOutput(rawChangelogZh, version, ZH_SECTION_TITLE, ZH_CATEGORY_ALIASES, ZH_CATEGORY_ORDER);
  if (!zh.valid || zh.bulletCount !== en.bulletCount) {
    console.log('⚠️ Chinese changelog format invalid or bullet count mismatch, retrying with stricter translation');
    logInvalidChangelogPreview('Chinese changelog', rawChangelogZh);
    const strictPromptZh = (
      promptZh +
      '\n\n## Additional hard constraints\n' +
      `- The output must contain exactly ${en.bulletCount} bullet points in total.\n` +
      '- Keep every bullet aligned one-to-one with the English source.\n'
    );
    try {
      const repairedZhResult = await callAiWithFallbacks(openaiCtor, modelConfigs, strictPromptZh, 'Chinese changelog repair');
      console.log(`ℹ️ Chinese changelog repair final model: ${repairedZhResult.model} (config #${repairedZhResult.configIndex})`);
      zh = normalizeChangelogOutput(repairedZhResult.content, version, ZH_SECTION_TITLE, ZH_CATEGORY_ALIASES, ZH_CATEGORY_ORDER);
    } catch (error) {
      console.log(`⚠️ Chinese changelog repair failed: ${error.message}`);
    }
  }

  if (!zh.valid || zh.bulletCount !== en.bulletCount) {
    console.log('⚠️ Falling back to minimal Chinese changelog due to invalid format');
    zh = buildFallbackChangelog(version, ZH_SECTION_TITLE, '🔧 体验改进', '维护和依赖更新。');
  }

  writeTextFile(CHANGELOG_ZH_FILE, zh.text);
  console.log('--- Chinese Changelog Preview ---');
  console.log(zh.text.slice(0, 500));
}

main().catch(error => {
  console.log(`⚠️ Changelog generation encountered an unexpected error: ${error.message}`);
  try {
    writeFallbackChangelogs(
      process.env.RELEASE_VERSION || 'Unknown',
      'Changelog generation failed; please check the commit history.',
      'Changelog 生成失败，请检查提交历史。',
    );
  } catch {
    // The release step has a downstream fallback if these files still cannot be written.
  }
});
