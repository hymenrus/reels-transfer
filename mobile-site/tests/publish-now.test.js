import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('Hemen Paylaş tek dokunuşta ilerler ve browser confirm penceresi göstermez', () => {
  const start = source.indexOf("if (button.dataset.action === 'publish-now')");
  const end = source.indexOf("if (button.dataset.action === 'cancel')", start);
  assert.notEqual(start, -1, 'Hemen Paylaş click handler bulunmalı');
  assert.notEqual(end, -1, 'Hemen Paylaş handler sınırı bulunmalı');

  const handler = source.slice(start, end);
  assert.doesNotMatch(handler, /window\.confirm\s*\(/);
  assert.match(handler, /request_immediate_publish/);
  assert.match(handler, /functions\.invoke\('publish-now-trigger'/);
});

test('successful queue add clears URLs but retains and persists the caption draft', () => {
  const start = source.indexOf('async function addToQueue(form)');
  const end = source.indexOf('async function handleClick(event)', start);
  assert.notEqual(start, -1, 'Kuyruğa ekleme yordamı bulunmalı');
  assert.notEqual(end, -1, 'Kuyruğa ekleme yordamının sonu bulunmalı');

  const addToQueue = source.slice(start, end);
  const successStart = addToQueue.indexOf('if (failed === 0)');
  const successEnd = addToQueue.indexOf('await loadQueue(true)', successStart);
  assert.notEqual(successStart, -1, 'Başarılı ekleme dalı bulunmalı');
  assert.notEqual(successEnd, -1, 'Başarılı ekleme dalının sonu bulunmalı');

  const successBranch = addToQueue.slice(successStart, successEnd);
  assert.match(successBranch, /currentUrlInput\.value = ''/);
  assert.match(successBranch, /saveReelDraft\(\)/);
  assert.doesNotMatch(successBranch, /(?:captionInput|caption-input)\.value\s*=\s*''/);
  assert.match(source, /setCaptionForAccount\(/);
  assert.doesNotMatch(source, /caption-template-tags|data-video-tags|setTagsForAccount\(|tagsForAccount\(/);
  assert.doesNotMatch(source, /Hashtag|hashtag|@mention bloğu/);
  assert.match(source, /captionForReelUrl\(/);
  assert.match(source, /instagram_caption_templates/);
  assert.match(addToQueue, /p_caption:\s*captionByShortcode\.get\(item\.shortcodeKey\)/);
  assert.match(addToQueue, /reelCaptionTemplateSelections\[item\.shortcodeKey\]/);
  assert.match(addToQueue, /length > 2200/);
});

test('saved templates are shared per ReelFlow user rather than scoped to the selected Instagram account', () => {
  const loadStart = source.indexOf('async function loadCaptionTemplates()');
  const loadEnd = source.indexOf('function renderCaptionTemplates()', loadStart);
  const saveStart = source.indexOf('async function saveCaptionTemplate()');
  const saveEnd = source.indexOf('async function deleteCaptionTemplate()', saveStart);
  const deleteStart = saveEnd;
  const deleteEnd = source.indexOf('function renderInstagramAccount()', deleteStart);
  const load = source.slice(loadStart, loadEnd);
  const save = source.slice(saveStart, saveEnd);
  const remove = source.slice(deleteStart, deleteEnd);

  assert.match(load, /\.eq\('user_id', userId\)/);
  assert.doesNotMatch(load, /instagram_account_id/);
  assert.doesNotMatch(save, /instagram_account_id/);
  assert.doesNotMatch(remove, /instagram_account_id/);
});

test('new queue submissions pin every Reel to its captured target Instagram account', () => {
  const start = source.indexOf('async function addToQueue(form)');
  const end = source.indexOf('async function handleClick(event)', start);
  const addToQueue = source.slice(start, end);
  assert.match(addToQueue, /const assignments = resolveReelTargetAssignments\(parsed\.items, state\.reelAccountTargets, state\.instagram\.id\)/);
  assert.match(addToQueue, /p_instagram_account_id: targetByShortcode\.get\(item\.shortcodeKey\)/);
  assert.match(source, /assign_reel_account/);
  assert.match(source, /select\('id,instagram_account_id,uploaded_video_id,shortcode/);
});

test('each URL can target a different account and enqueue uses its own selected account ID', () => {
  const start = source.indexOf('async function addToQueue(form)');
  const end = source.indexOf('async function handleClick(event)', start);
  const addToQueue = source.slice(start, end);

  assert.match(source, /id="reel-target-panel"/);
  assert.match(source, /data-reel-target-select data-shortcode-key=/);
  assert.match(source, /data-reel-caption-template data-shortcode-key=/);
  assert.match(source, /data-reel-cover-select data-shortcode-key=/);
  assert.match(addToQueue, /resolveReelTargetAssignments\(parsed\.items, state\.reelAccountTargets, state\.instagram\.id\)/);
  assert.match(addToQueue, /p_instagram_account_id: targetByShortcode\.get\(item\.shortcodeKey\)/);
  assert.match(addToQueue, /p_caption: captionByShortcode\.get\(item\.shortcodeKey\)/);
  assert.match(addToQueue, /enqueue_reel_with_auto_cover/);
  assert.match(addToQueue, /p_cover_image_id: coverByShortcode\.get\(item\.shortcodeKey\)/);
  assert.match(addToQueue, /p_auto_select_cover: !state\.reelCoverImageSelections\[item\.shortcodeKey\]/);
  assert.match(source, /Rastgele · yüklenmiş kapaklardan/);
  assert.doesNotMatch(addToQueue, /const targetInstagramAccountId/);
  assert.match(source, /reelAccountTargets:\s*\{\s*\.\.\.state\.reelAccountTargets\s*\}/);
  assert.match(source, /reelCaptionTemplateSelections:\s*\{\s*\.\.\.state\.reelCaptionTemplateSelections\s*\}/);
  assert.match(source, /reelCoverImageSelections:\s*\{\s*\.\.\.state\.reelCoverImageSelections\s*\}/);
});

test('per-URL cover selector stays visible on mobile before an Instagram account is connected', () => {
  const start = source.indexOf('function renderReelTargetAssignments()');
  const end = source.indexOf('\nfunction updateStats()', start);
  const renderer = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(renderer, /const noAccountOption = connectedAccounts\.length \? ''/);
  assert.match(renderer, /data-reel-cover-select data-shortcode-key=/);
  assert.match(renderer, /if \(!items\.length\) \{\s*panel\.hidden = true;\s*panel\.innerHTML = '';/);
  assert.doesNotMatch(renderer, /URL başına kapak seçimi/);
  assert.match(renderer, /kapak ve açıklama seçimini şimdi yapabilirsin/);
  assert.doesNotMatch(renderer, /if \(!connectedAccounts\.length\)[\s\S]*?return;/);
  assert.match(source, /URL’leri ekleyince her bağlantı için hesap, açıklama ve kapak seçimi görünür/);
});

test('five dashboard sections are vertically ordered, independently collapsible, and the bottom dock is removed', () => {
  const sectionIds = ['general-section', 'add-section', 'video-library-section', 'queue-section', 'settings-section'];
  const sectionPositions = sectionIds.map((id) => source.indexOf(`id="${id}"`));
  const queuePosition = sectionPositions[3];
  const connectionPosition = sectionPositions[4];
  const footerPosition = source.indexOf('<footer class="app-footer">');
  const sideNavStart = source.indexOf('<nav class="side-nav"');
  const sideNavEnd = source.indexOf('</nav>', sideNavStart);
  const sideNav = source.slice(sideNavStart, sideNavEnd);
  const navPositions = sectionIds.map((id) => sideNav.indexOf(`data-scroll="${id}"`));
  const scrollStart = source.indexOf('if (button.dataset.scroll) {');
  const scrollEnd = source.indexOf('if (button.dataset.filter)', scrollStart);
  const scrollHandler = source.slice(scrollStart, scrollEnd);

  assert.ok(sectionPositions.every((position, index) => position >= 0 && (index === 0 || position > sectionPositions[index - 1])));
  assert.ok(navPositions.every((position, index) => position >= 0 && (index === 0 || position > navPositions[index - 1])));
  assert.ok(queuePosition >= 0 && connectionPosition > queuePosition && footerPosition > connectionPosition);
  assert.ok(sectionIds.every((id) => source.includes(`id="${id}"`)));
  assert.equal((source.match(/<details\b/g) || []).length, (source.match(/<\/details>/g) || []).length);
  assert.equal((source.match(/<summary\b/g) || []).length, (source.match(/<\/summary>/g) || []).length);
  assert.doesNotMatch(source, /<nav class="mobile-nav"/);
  assert.match(scrollHandler, /if \(target\?\.tagName === 'DETAILS'\) target\.open = true/);
  assert.match(scrollHandler, /prefers-reduced-motion: reduce/);
  assert.match(source, /connection-summary-meta/);
  assert.match(styles, /\.dashboard-section>summary\.dashboard-section-summary/);
  assert.match(styles, /\.section-disclosure-chevron/);
  assert.match(styles, /@media\(max-width:820px\)/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
});
