import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PUBLISHER_SETUP_READY } from './config.js';
import { estimateQueueEta, NO_REEL_COVER_IMAGE, pruneReelAccountTargets, pruneReelCaptionTemplateSelections, pruneReelCoverImageSelections, resolveReelTargetAssignments, selectInstagramAccount, setReelAccountTarget, setReelCoverImageSelection } from './queue-utils.js';
import { captionForAccount, captionForReelUrl, hasReelDraftContent, setCaptionForAccount, validateCaptionTemplate } from './caption-utils.js';
import { parseReelLines } from './url-utils.js';
import { formatVideoFileSize, mapWithConcurrency, MAX_VIDEO_IMPORTS_PER_BATCH, VIDEO_IMPORT_CONCURRENCY, VIDEO_STORAGE_BUCKET, VIDEO_COVER_BUCKET, MAX_COVER_IMAGES_PER_BATCH, coverImageStoragePath, createCoverImageId, validateCoverImageFile } from './uploaded-video-utils.js';
import './styles.css';

const root = document.querySelector('#app');
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const state = { session: null, rows: [], instagram: null, instagramAccounts: [], reelAccountTargets: {}, reelCaptionTemplateSelections: {}, reelCoverImageSelections: {}, captionTemplates: [], captionTemplatesLoading: false, captionTemplatesError: '', selectedCaptionTemplateId: '', uploadedVideos: [], videoImports: [], videoCoverImages: [], videoCoverImagesError: '', videoCoverUploadBusy: false, videoStorageUsage: null, uploadedVideosLoading: false, uploadedVideosError: '', uploadedVideoDrafts: {}, uploadedVideoDraftsUserId: '', videoImportBusy: false, videoImportFilter: 'all', videoLibraryFilter: '', preferNewestInstagramAccount: false, instagramConnectionMessage: null, filter: 'all', theme: localStorage.getItem('reelflow-theme') || 'dark', installPrompt: null, busy: false };
let instagramAccountLoadGeneration = 0;
let captionTemplateLoadGeneration = 0;
let videoLibraryLoadGeneration = 0;
let idleQueueRefreshTicks = 0;
let videoImportRefreshTicks = 0;
let videoStorageRefreshTicks = 0;
let videoStorageLoadGeneration = 0;
let authUserGeneration = 0;
document.documentElement.dataset.theme = state.theme;

const icon = (name, size = 20) => {
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    reel: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m10 8 6 4-6 4zM3 9h18M8 3l4 6M15 3l4 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="M12 9v4m0 4h.01"/><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.5-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.5.9l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 1.8Z" transform="translate(-1 -1)"/>',
    logout: '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
    external: '<path d="M14 3h7v7m0-7-9 9"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    spark: '<path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z"/><path d="m19 14 1.1 2.9L23 18l-2.9 1.1L19 22l-1.1-2.9L15 18l2.9-1.1L19 14Z"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function toast(message, type = 'info') {
  const holder = document.querySelector('#toast-host');
  if (!holder) return;
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.textContent = message;
  holder.append(node);
  setTimeout(() => node.classList.add('toast-out'), 2600);
  setTimeout(() => node.remove(), 3100);
}
function fmtDate(value) {
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function fmtHistoryDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
const REEL_DRAFT_STORAGE_PREFIX = 'reelflow-draft-v1';
const VIDEO_DRAFT_STORAGE_PREFIX = 'reelflow-video-drafts-v1';
function reelDraftStorageKey() {
  const userId = state.session?.user?.id;
  return userId ? `${REEL_DRAFT_STORAGE_PREFIX}:${userId}` : null;
}
function activeInstagramStorageKey() {
  const userId = state.session?.user?.id;
  return userId ? `reelflow-active-instagram-v1:${userId}` : null;
}
function saveActiveInstagramSelection(accountId) {
  const key = activeInstagramStorageKey();
  if (!key || !accountId) return;
  try { localStorage.setItem(key, accountId); } catch (error) {
    console.warn('Seçili Instagram hesabı bu cihazda saklanamadı:', error);
  }
}
function readReelDraft() {
  const key = reelDraftStorageKey();
  if (!key) return {};
  try {
    const draft = JSON.parse(localStorage.getItem(key) || '{}');
    return draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
  } catch (error) {
    console.warn('Reel taslağı bu cihazdan geri yüklenemedi:', error);
    return {};
  }
}
function saveReelDraft() {
  const key = reelDraftStorageKey();
  const urlInput = document.querySelector('#reel-input');
  const captionInput = document.querySelector('#caption-input');
  if (!key || !urlInput || !captionInput) return;
  const captionDraft = setCaptionForAccount({ ...readReelDraft(), urls: urlInput.value }, state.instagram?.id, captionInput.value);
  const items = parseReelLines(urlInput.value).items;
  state.reelAccountTargets = pruneReelAccountTargets(items, state.reelAccountTargets);
  state.reelCaptionTemplateSelections = pruneReelCaptionTemplateSelections(items, state.reelCaptionTemplateSelections);
  state.reelCoverImageSelections = pruneReelCoverImageSelections(items, state.reelCoverImageSelections);
  const draft = {
    ...captionDraft,
    reelAccountTargets: { ...state.reelAccountTargets },
    reelCaptionTemplateSelections: { ...state.reelCaptionTemplateSelections },
    reelCoverImageSelections: { ...state.reelCoverImageSelections },
  };
  try {
    if (!hasReelDraftContent(draft)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(draft));
  } catch (error) {
    console.warn('Reel taslağı bu cihazda saklanamadı:', error);
  }
}
function restoreReelDraft() {
  const key = reelDraftStorageKey();
  if (!key) return;
  try {
    const draft = readReelDraft();
    const items = parseReelLines(typeof draft.urls === 'string' ? draft.urls : '').items;
    state.reelAccountTargets = pruneReelAccountTargets(items, draft.reelAccountTargets);
    state.reelCaptionTemplateSelections = pruneReelCaptionTemplateSelections(items, draft.reelCaptionTemplateSelections);
    state.reelCoverImageSelections = pruneReelCoverImageSelections(items, draft.reelCoverImageSelections);
    const urlInput = document.querySelector('#reel-input');
    const captionInput = document.querySelector('#caption-input');
    if (urlInput && typeof draft.urls === 'string') urlInput.value = draft.urls;
    if (captionInput) captionInput.value = captionForAccount(draft, state.instagram?.id).slice(0, 2200);
    updateInputCounter(urlInput?.value || '');
    renderReelTargetAssignments();
    if (state.instagram?.id) saveReelDraft();
  } catch (error) {
    console.warn('Reel taslağı bu cihazdan geri yüklenemedi:', error);
  }
}
function statusMeta(status) {
  return ({
    queued: ['Sırada', 'queued'], processing: ['Yayınlanıyor', 'processing'],
    published: ['Yayınlandı', 'published'], failed: ['Hata', 'failed'], cancelled: ['İptal edildi', 'cancelled'],
  })[status] || ['Bilinmiyor', 'queued'];
}
function formatQueueEta(targetAt, priority, now = Date.now()) {
  if (priority) return 'Öncelikli · sıradaki otomatik turda';
  const minutes = Math.max(0, Math.ceil((targetAt - now) / 60_000));
  if (targetAt <= now) return 'Aralık doldu · sıradaki otomatik turda';
  const localTarget = new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(targetAt));
  if (minutes <= 5) return `En erken ${localTarget} · sıradaki otomatik turda`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days} gün`);
  if (hours) parts.push(`${hours} saat`);
  if (remainder && !days) parts.push(`${remainder} dk`);
  return `En erken ${localTarget} (yerel) · yaklaşık ${parts.join(' ')} kaldı`;
}
function renderLogin(message = '') {
  root.innerHTML = `
    <main class="auth-screen">
      <div class="auth-art" aria-hidden="true"></div>
      <section class="auth-card enter">
        <div class="brand-lockup"><span class="brand-mark">R</span><span>ReelFlow<span class="brand-sub">TRANSFER STUDIO</span></span></div>
        <span class="eyebrow">MOBİL REELS PANELİ</span>
        <h1>Kuyruğun,<br><em>kontrolünde.</em></h1>
        <p class="muted">E-postanı yaz. Yeni kullanıcılar kendi hesabını açabilir; giriş bağlantısı e-postana gelir.</p>
        ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}
        <form id="login-form" class="stack-form">
          <label for="login-email">E-posta adresi</label>
          <input id="login-email" type="email" required autocomplete="email" placeholder="sen@ornek.com" />
          <button class="button button-primary button-wide" type="submit">Giriş bağlantısı gönder <span>→</span></button>
        </form>
        <p class="fine-print">E-posta bağlantısı tek kullanımlıdır. Instagram parolanı ReelFlow'a girmezsin; Instagram'ı Meta'nın güvenli ekranından bağlarsın.</p>
        <div class="auth-foot">Telefon · Tablet · Bilgisayar <span>•</span> PWA desteği</div>
      </section>
    </main>
    <div id="toast-host" class="toast-host" aria-live="polite"></div>`;
  consumeInstagramCallback();
}

function renderShell() {
  const user = state.session.user;
  const email = user.email || 'Hesap';
  const initial = (email[0] || 'R').toUpperCase();
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand-lockup" href="#top" aria-label="ReelFlow ana sayfa"><span class="brand-mark">R</span><span>ReelFlow<span class="brand-sub">TRANSFER STUDIO</span></span></a>
        <div class="sidebar-label">ÇALIŞMA ALANI</div>
        <nav class="side-nav" aria-label="Ana menü">
          <button class="nav-item active" aria-current="location" data-scroll="top">${icon('grid')}<span>Genel bakış</span></button>
          <button class="nav-item" data-scroll="queue-section">${icon('reel')}<span>Reel kuyruğu</span><span id="nav-count" class="nav-count">0</span></button>
          <button class="nav-item" data-scroll="video-library-section">${icon('play')}<span>Video arşivi</span><span id="video-nav-count" class="nav-count">0</span></button>
          <button class="nav-item" data-scroll="settings-section">${icon('settings')}<span>Bağlantı durumu</span></button>
        </nav>
        <div class="sidebar-bottom">
          <div class="worker-mini"><span class="live-dot"></span><div><strong>Bulut işçisi</strong><small>${PUBLISHER_SETUP_READY ? 'Bağlandı' : 'Kurulum bekliyor'}</small></div></div>
          <div class="user-mini"><span class="avatar">${escapeHtml(initial)}</span><div class="user-label"><strong>${escapeHtml(email)}</strong><small>Güvenli oturum</small></div><button class="icon-button signout" title="Çıkış yap" aria-label="Çıkış yap">${icon('logout', 18)}</button></div>
        </div>
      </aside>
      <div class="main-column" id="top">
        <header class="topbar">
          <div class="mobile-brand brand-lockup"><span class="brand-mark">R</span><span>ReelFlow</span></div>
          <div class="breadcrumbs"><span>Kontrol paneli</span><span class="crumb-sep">/</span><strong>Genel bakış</strong></div>
          <div class="top-actions">
            <span class="connection-pill"><i class="live-dot"></i><span>Supabase bağlı</span></span>
            <button id="install-button" class="icon-button install-button" title="Uygulamayı yükle" aria-label="Uygulamayı yükle">${icon('reel', 18)}</button>
            <button id="theme-button" class="icon-button" title="Temayı değiştir" aria-label="Temayı değiştir">${icon(state.theme === 'dark' ? 'sun' : 'moon', 18)}</button>
            <button class="avatar top-avatar signout" title="Çıkış yap" aria-label="Çıkış yap">${escapeHtml(initial)}</button>
          </div>
        </header>
        <main class="dashboard">
          <section class="overview-section" id="overview-section">
            <div class="overview-section-heading"><span class="eyebrow">GENEL BAKIŞ</span><button type="button" class="section-toggle-button" data-section-toggle="overview-content" data-label-collapse="Genel bölümünü daralt" data-label-expand="Genel bölümünü genişlet" aria-controls="overview-content" aria-expanded="true" aria-label="Genel bölümünü daralt" title="Genel bölümünü daralt"><span class="section-toggle-glyph" aria-hidden="true">⌄</span></button></div>
            <div class="section-collapse-content" id="overview-content">
          <section class="hero-card enter">
            <div class="hero-copy"><div class="hero-kicker">${icon('spark', 15)} HER ŞEY TEK YERDE</div><h1>Reels akışın,<br><span>tek ekranda.</span></h1><p>Linkleri ekle, kuyruğu takip et. Daha önce eklenen Reel tekrar sıraya girmez.</p><a class="button button-light" href="#add-section" data-scroll="add-section">${icon('plus', 18)} Reel ekle</a></div>
            <div class="hero-orbit orbit-one"></div><div class="hero-orbit orbit-two"></div><div class="hero-sticker"><span class="sticker-play">▶</span><span>REELS<br><b>TRANSFER</b></span></div>
          </section>
          <section class="stats-grid" aria-label="Kuyruk özeti">
            <article class="stat-card stat-total"><div class="stat-top"><span>Toplam Reel</span><span class="stat-icon">${icon('reel', 18)}</span></div><strong id="stat-total">—</strong><small>Kayıtlı içerik</small></article>
            <article class="stat-card stat-queued"><div class="stat-top"><span>Kuyrukta</span><span class="stat-icon">${icon('clock', 18)}</span></div><strong id="stat-queued">—</strong><small>Sıradaki içerikler</small></article>
            <article class="stat-card stat-done"><div class="stat-top"><span>Yayınlandı</span><span class="stat-icon">${icon('check', 18)}</span></div><strong id="stat-published">—</strong><small>Tamamlananlar</small></article>
            <article class="stat-card stat-failed"><div class="stat-top"><span>Kontrol gerekli</span><span class="stat-icon">${icon('alert', 18)}</span></div><strong id="stat-failed">—</strong><small>Hata alan içerikler</small></article>
          </section>
            </div>
          </section>
          <section class="content-grid content-grid-single">
            <article class="panel add-panel" id="add-section">
              <div class="panel-heading"><div><span class="eyebrow">YENİ İÇERİK</span><h2>Kuyruğa Reel ekle</h2></div><div class="panel-heading-actions"><span class="heading-icon">${icon('plus', 20)}</span><button type="button" class="section-toggle-button" data-section-toggle="add-content" data-label-collapse="Reel ekle bölümünü daralt" data-label-expand="Reel ekle bölümünü genişlet" aria-controls="add-content" aria-expanded="true" aria-label="Reel ekle bölümünü daralt" title="Reel ekle bölümünü daralt"><span class="section-toggle-glyph" aria-hidden="true">⌄</span></button></div></div>
              <div class="section-collapse-content" id="add-content">
              <p class="panel-copy">Her satıra bir Instagram Reel bağlantısı yaz. URL’leri ekleyince her bağlantı için hesap, açıklama ve kapak seçimi görünür. Ayrı açıklama alanı, bu sefer eklediğin tüm Reels'lere uygulanır.</p>
              <form id="add-form">
                <label class="sr-only" for="reel-input">Reel bağlantıları</label>
                <textarea id="reel-input" rows="5" placeholder="https://www.instagram.com/reel/ABC123/&#10;https://www.instagram.com/reel/XYZ456/"></textarea>
                <div class="input-meta"><span id="input-counter">0 bağlantı</span><button type="button" id="paste-button" class="text-button">Panodan yapıştır</button></div>
                <section id="reel-target-panel" class="reel-target-panel" aria-live="polite" hidden></section>
                <label for="caption-input">Paylaşım açıklaması <span class="muted">(isteğe bağlı, tüm Reels'lere uygulanır)</span></label>
                <textarea id="caption-input" rows="3" maxlength="2200" placeholder="Bu sefer eklediğin Reels'ler için açıklama yaz…"></textarea>
                <section class="caption-template-panel" aria-label="Açıklama şablonları">
                  <div class="caption-template-heading"><strong>Kayıtlı açıklama şablonları</strong><small id="caption-template-status" class="caption-template-status" role="status" aria-live="polite">ReelFlow hesabı yükleniyor…</small></div>
                  <div class="caption-template-select-row"><label class="sr-only" for="caption-template-select">Açıklama şablonu seç</label><select id="caption-template-select" disabled><option value="">Şablon seç…</option></select><button type="button" id="delete-caption-template" class="caption-template-delete" disabled>Seçileni sil</button></div>
                  <div class="caption-template-save-row"><label class="sr-only" for="caption-template-name">Şablon adı</label><input id="caption-template-name" type="text" maxlength="60" placeholder="Şablon adı, ör. Kampanya" disabled /><button type="button" id="save-caption-template" class="button button-primary caption-template-save" disabled>Açıklamayı kaydet</button></div>
                  <small class="caption-template-note">Şablonlar aynı ReelFlow hesabındaki tüm Instagram hesaplarında ortaktır.</small>
                </section>
                <label class="rights-check"><input type="checkbox" id="rights-confirm" /><span>Bu videoları paylaşma hakkım var veya izin aldım.</span></label>
                <button class="button button-primary button-wide" type="submit" id="add-submit">${icon('plus', 18)} Kuyruğa ekle <span class="button-arrow">→</span></button>
              </form>
              <div class="privacy-note">${icon('check', 15)} URL’ler başarıyla kuyruğa eklenince temizlenir; açıklama taslağın bu cihazda, kayıtlı şablonların hesabında bulutta saklanır. Instagram parolan burada istenmez.</div>
              </div>
            </article>
          </section>
          <section class="panel video-library-panel" id="video-library-section">
            <div class="panel-heading"><div><span class="eyebrow">ÖZEL BULUT ARŞİVİ</span><h2>Video arşivi <span id="video-library-count" class="queue-count">0</span></h2></div><div class="panel-heading-actions"><span class="heading-icon">${icon('play', 19)}</span><button type="button" class="section-toggle-button" data-section-toggle="video-library-content" data-label-collapse="Video arşivi bölümünü daralt" data-label-expand="Video arşivi bölümünü genişlet" aria-controls="video-library-content" aria-expanded="true" aria-label="Video arşivi bölümünü daralt" title="Video arşivi bölümünü daralt"><span class="section-toggle-glyph" aria-hidden="true">⌄</span></button></div></div>
            <div class="section-collapse-content" id="video-library-content">
            <p class="panel-copy">Instagram Reel bağlantısını ekle; ReelFlow videoyu bulut işçisiyle özel arşivine indirir. Telefona indirmeden oynatabilir, istediğin zaman kuyruğa gönderebilirsin.</p>
            <div id="video-library-quota" class="video-library-quota">
              <div class="video-storage-usage-row"><div><strong id="video-storage-remaining">Depolama ölçülüyor…</strong><small id="video-storage-detail">Supabase Free proje kotası · 1 GB</small></div><button type="button" class="mini-button" data-action="refresh-storage-usage">Yenile</button></div>
              <div class="video-storage-meter" role="progressbar" aria-label="Proje depolama kullanımı" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="video-storage-meter-fill"></span></div>
              <small id="video-storage-updated">Kullanım proje genelinde ve ortak depolama alanında ölçülür.</small>
            </div>
            <form id="video-import-form" class="video-import-form">
              <label for="video-import-urls">Arşive kaydedilecek Instagram Reel bağlantıları</label>
              <textarea id="video-import-urls" rows="3" required placeholder="Her satıra bir Instagram Reel URL’si yapıştır\nhttps://www.instagram.com/reel/…/"></textarea>
              <div class="video-import-tools"><button type="button" class="mini-button" data-action="paste-video-import-urls">Panodan URL yapıştır</button><button type="button" class="mini-button" data-action="import-url-text-file">TXT listesi seç</button><input type="file" id="video-import-file" accept=".txt,text/plain" hidden /><small id="video-import-counter" class="video-import-counter" aria-live="polite">0 / 20 URL</small></div>
              <small class="video-upload-note">Her satıra bir Reel URL’si; tek seferde en fazla 20 bağlantı. TXT listesi yalnızca bu cihazda okunur, sunucuya yüklenmez. İşçi bir çalıştırmada en fazla 5 URL işler; kalanlar kuyrukta devam eder. Dosya başına sınır 50 MB.</small>
              <label class="rights-check video-import-rights"><input id="video-import-rights" type="checkbox" /><span>Bu videoları saklama ve paylaşma hakkım var veya izin aldım.</span></label>
              <button class="button button-primary" type="submit" id="video-import-submit">${icon('plus', 17)} Buluta kaydet</button>
            </form>
            <section class="video-covers-panel" aria-labelledby="video-covers-title">
              <div class="video-covers-heading"><div><span class="eyebrow">KAPAK KÜTÜPHANESİ</span><h3 id="video-covers-title">Reels kapakları</h3></div><small>JPEG · en fazla 8 MB · önerilen oran 9:16</small></div>
              <form id="video-cover-form" class="video-cover-form"><label for="video-cover-files">Birden fazla kapak görseli seç</label><input id="video-cover-files" type="file" accept="image/jpeg,.jpg,.jpeg" multiple /><small class="video-upload-note">Kapaklar hesabına ait özel bulutta saklanır. Instagram görseli ortadan kırpabilir; 9:16 önerilir. Tek seferde en fazla 20 JPEG.</small><button type="submit" class="button button-primary" id="video-cover-submit">Kapakları buluta yükle</button><small id="video-cover-upload-status" role="status" aria-live="polite"></small></form>
              <div id="video-cover-image-list" class="video-cover-image-list" aria-live="polite"></div>
            </section>
            <section class="video-history-panel" aria-labelledby="video-history-title">
              <div class="video-history-heading"><div><span class="eyebrow">SON 50 İŞLEM</span><h3 id="video-history-title">İndirme durumu ve geçmiş</h3></div><button type="button" class="mini-button" data-action="refresh-uploaded-videos" aria-label="İndirme geçmişini yenile">Yenile</button></div>
              <div class="video-history-filters" role="tablist" aria-label="İndirme geçmişi filtresi"><button type="button" class="video-history-filter active" data-import-filter="all" aria-pressed="true">Tümü <span id="video-history-count-all">0</span></button><button type="button" class="video-history-filter" data-import-filter="active" aria-pressed="false">Sırada / indiriliyor <span id="video-history-count-active">0</span></button><button type="button" class="video-history-filter" data-import-filter="ready" aria-pressed="false">Tamamlandı <span id="video-history-count-ready">0</span></button><button type="button" class="video-history-filter" data-import-filter="failed" aria-pressed="false">Hata <span id="video-history-count-failed">0</span></button></div>
              <div id="video-import-status-list" class="video-history-list" aria-live="polite"></div>
            </section>
            <div id="video-library-list" class="video-library-list"><div class="loading-row"><span class="spinner"></span> Video arşivi yükleniyor…</div></div>
            </div>
          </section>
          <section class="panel queue-panel" id="queue-section">
            <div class="queue-heading"><div><span class="eyebrow">İÇERİK MERKEZİ</span><h2>Reel kuyruğu <span id="queue-count" class="queue-count">0</span></h2></div><div class="queue-tools"><div class="search-wrap">${icon('search', 17)}<input type="search" id="queue-search" placeholder="Kuyrukta ara" aria-label="Kuyrukta ara" /></div><button class="icon-button refresh-button" id="refresh-button" title="Yenile" aria-label="Kuyruğu yenile">${icon('refresh', 17)}</button><button type="button" class="section-toggle-button" data-section-toggle="queue-content" data-label-collapse="Reel kuyruğu bölümünü daralt" data-label-expand="Reel kuyruğu bölümünü genişlet" aria-controls="queue-content" aria-expanded="true" aria-label="Reel kuyruğu bölümünü daralt" title="Reel kuyruğu bölümünü daralt"><span class="section-toggle-glyph" aria-hidden="true">⌄</span></button></div></div>
            <div class="section-collapse-content" id="queue-content">
            <div class="filter-row" role="tablist" aria-label="Kuyruk filtresi"><button class="filter-chip active" data-filter="all">Tümü</button><button class="filter-chip" data-filter="queued">Kuyrukta</button><button class="filter-chip" data-filter="processing">Yayınlanıyor</button><button class="filter-chip" data-filter="published">Yayınlandı</button><button class="filter-chip" data-filter="unavailable">Instagram’da yok</button><button class="filter-chip" data-filter="failed">Hata</button></div>
            <div id="queue-list" class="queue-list"><div class="loading-row"><span class="spinner"></span> Kuyruk yükleniyor…</div></div>
            <div id="queue-footer" class="queue-footer"></div>
            </div>
          </section>
          <details class="panel worker-panel connection-panel" id="settings-section">
            <summary class="connection-summary">
              <span class="connection-summary-copy"><span class="eyebrow">YAYIN DURUMU</span><strong>Bulut bağlantıları</strong><small>Instagram hesabı ve yayın altyapısı</small></span>
              <span class="connection-summary-meta"><span class="service-status ${PUBLISHER_SETUP_READY ? 'good' : 'pending'}">${PUBLISHER_SETUP_READY ? 'Hazır' : 'İncele'}</span><span class="connection-chevron" aria-hidden="true">⌄</span></span>
            </summary>
            <div class="connection-body">
              <div class="service-row"><span class="service-logo supabase-logo">S</span><div><strong>Supabase</strong><small>Güvenli kuyruk ve oturum</small></div><span class="service-status good">Bağlı</span></div>
              <div id="instagram-account-card" class="instagram-account-card"><span class="spinner"></span> Instagram bağlantısı kontrol ediliyor…</div>
              <div class="service-row"><span class="service-logo github-logo">GH</span><div><strong>GitHub Actions</strong><small>Bilgisayar kapalıyken işlem</small></div><span class="service-status ${PUBLISHER_SETUP_READY ? 'good' : 'pending'}">${PUBLISHER_SETUP_READY ? 'Hazır' : 'Kurulum gerekli'}</span></div>
              <div class="worker-note ${PUBLISHER_SETUP_READY ? 'note-ready' : ''}"><span class="note-icon">${PUBLISHER_SETUP_READY ? '✓' : 'i'}</span><p>${PUBLISHER_SETUP_READY ? 'Kuyruktaki içerikler bulut işçisi tarafından sırayla işleniyor.' : 'Arayüz ve kuyruk hazır. Otomatik yayın için GitHub Actions sırları ve Instagram API ayarları henüz bağlanmadı.'}</p></div>
              <div class="worker-interval">${icon('clock', 16)} <span>Kuyrukta tarih/saat ayarı yok — eklenenler sırayla işlenir.</span></div>
            </div>
          </details>
          <footer class="app-footer"><span>ReelFlow <span class="footer-dot">•</span> Mobil uyumlu web uygulaması</span><span>Instagram API üzerinden, iznin olan içerikler için</span></footer>
        </main>
        <nav class="mobile-nav" aria-label="Alt menü"><button class="mobile-nav-item active" aria-current="location" data-scroll="top">${icon('grid', 20)}<span>Genel</span></button><button class="mobile-nav-item" data-scroll="add-section">${icon('plus', 20)}<span>Ekle</span></button><button class="mobile-nav-item" data-scroll="video-library-section">${icon('play', 20)}<span>Arşiv</span></button><button class="mobile-nav-item" data-scroll="queue-section">${icon('reel', 20)}<span>Kuyruk</span></button><button class="mobile-nav-item" data-scroll="settings-section">${icon('settings', 20)}<span>Durum</span></button></nav>
      </div>
    </div>
    <div id="toast-host" class="toast-host" aria-live="polite"></div>`;
  restoreReelDraft();
  updateStats();
  renderQueue();
  renderInstagramAccount();
  renderCaptionTemplates();
  void loadCaptionTemplates();
  renderUploadedVideos();
  void loadUploadedVideos();
  consumeInstagramCallback();
  const input = document.querySelector('#reel-input');
  input?.addEventListener('input', () => updateInputCounter(input.value));
}

function updateInputCounter(value) {
  const lines = value.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).length;
  const target = document.querySelector('#input-counter');
  if (target) target.textContent = `${lines} bağlantı`;
}
function renderReelTargetAssignments() {
  const panel = document.querySelector('#reel-target-panel');
  const textarea = document.querySelector('#reel-input');
  if (!panel || !textarea) return;

  const items = parseReelLines(textarea.value).items;
  state.reelAccountTargets = pruneReelAccountTargets(items, state.reelAccountTargets);
  state.reelCaptionTemplateSelections = pruneReelCaptionTemplateSelections(items, state.reelCaptionTemplateSelections);
  state.reelCoverImageSelections = pruneReelCoverImageSelections(items, state.reelCoverImageSelections);
  if (!items.length) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;
  const connectedAccounts = state.instagramAccounts.filter((account) => account && !account.disconnected_at);
  const defaultAccountId = connectedAccounts.some((account) => account.id === state.instagram?.id)
    ? state.instagram.id
    : connectedAccounts[0]?.id || '';
  const rows = items.map((item) => {
    const targetId = state.reelAccountTargets[item.shortcodeKey] || defaultAccountId;
    const targetAccount = state.instagramAccounts.find((account) => account.id === targetId);
    const targetAvailable = connectedAccounts.some((account) => account.id === targetId);
    const staleOption = targetId && !targetAvailable ? `<option value="${escapeHtml(targetId)}" selected disabled>@${escapeHtml(targetAccount?.username || 'hesap')} · bağlantı kesildi</option>` : '';
    const options = connectedAccounts.map((account) => `<option value="${escapeHtml(account.id)}"${account.id === targetId ? ' selected' : ''}>@${escapeHtml(account.username)}</option>`).join('');
    const noAccountOption = connectedAccounts.length ? '' : `<option value=""${targetId ? '' : ' selected'} disabled>Önce Instagram hesabı bağla</option>`;
    const accountDisabled = connectedAccounts.length ? '' : ' disabled';
    const templateId = state.reelCaptionTemplateSelections[item.shortcodeKey] || '';
    const selectedTemplate = state.captionTemplates.find((template) => template.id === templateId);
    const staleTemplateOption = templateId && !selectedTemplate
      ? `<option value="${escapeHtml(templateId)}" selected disabled>Seçili şablon bulunamadı</option>`
      : '';
    const templateOptions = state.captionTemplates.map((template) => `<option value="${escapeHtml(template.id)}"${template.id === templateId ? ' selected' : ''}>${escapeHtml(template.name)}</option>`).join('');
    const templateDisabled = state.captionTemplatesLoading ? ' disabled' : '';
    const coverChoice = state.reelCoverImageSelections[item.shortcodeKey] || '';
    const coverId = coverChoice === NO_REEL_COVER_IMAGE ? '' : coverChoice;
    const selectedCover = state.videoCoverImages.find((cover) => cover.id === coverId);
    const staleCoverOption = coverId && !selectedCover
      ? `<option value="${escapeHtml(coverId)}" selected disabled>Seçili kapak yüklenemedi</option>` : '';
    const coverOptions = state.videoCoverImages.map((cover) => `<option value="${escapeHtml(cover.id)}"${cover.id === coverId ? ' selected' : ''}>${escapeHtml(cover.original_filename)}</option>`).join('');
    const coverPreview = selectedCover?.signedUrl
      ? `<span class="reel-cover-preview"><img src="${escapeHtml(selectedCover.signedUrl)}" alt="${escapeHtml(selectedCover.original_filename)}" loading="lazy" /><small>${escapeHtml(selectedCover.original_filename)}</small></span>`
      : selectedCover ? '<small class="reel-cover-note">Önizleme yenilenince açılır; seçilen kapak yayın sırasında kullanılır.</small>'
        : coverChoice === NO_REEL_COVER_IMAGE ? '<small class="reel-cover-note">Bu URL’de videonun kendi karesi kullanılacak.</small>'
          : state.videoCoverImages.length ? '<small class="reel-cover-note">Seçmezsen arşivindeki kapaklardan rastgele atanır.</small>'
            : '<small class="reel-cover-note">Kütüphanede kapak yok; videonun karesi kullanılacak.</small>';
    const coverDisabled = state.uploadedVideosLoading ? ' disabled' : '';
    const automaticCoverLabel = state.videoCoverImages.length ? 'Rastgele · yüklenmiş kapaklardan' : 'Kapak yok · videodan kare';
    const status = !connectedAccounts.length
      ? 'Önce Instagram hesabı bağla; kapak ve açıklama seçimini şimdi yapabilirsin.'
      : targetAvailable
      ? `Hedef hesap: @${escapeHtml(targetAccount?.username || '')}`
      : 'Bu hesap bağlantısı kesilmiş; yeniden bağla veya başka hedef seç.';
    return `<div class="reel-target-row"><div class="reel-target-info"><strong>/${escapeHtml(item.shortcode)}</strong><small class="${targetAvailable || !connectedAccounts.length ? '' : 'is-unavailable'}">${status}</small></div><label class="reel-target-field"><span>Yayın hesabı</span><select data-reel-target-select data-shortcode-key="${escapeHtml(item.shortcodeKey)}" aria-label="/${escapeHtml(item.shortcode)} yayın hesabı"${accountDisabled}>${staleOption}${noAccountOption}${options}</select></label><label class="reel-target-field"><span>Açıklama taslağı</span><select data-reel-caption-template data-shortcode-key="${escapeHtml(item.shortcodeKey)}" aria-label="/${escapeHtml(item.shortcode)} açıklama taslağı"${templateDisabled}>${staleTemplateOption}<option value=""${templateId ? '' : ' selected'}>Genel açıklama</option>${templateOptions}</select></label><label class="reel-target-field reel-cover-field"><span>Reels kapağı</span><select data-reel-cover-select data-shortcode-key="${escapeHtml(item.shortcodeKey)}" aria-label="/${escapeHtml(item.shortcode)} Reels kapağı"${coverDisabled}>${staleCoverOption}<option value=""${!coverChoice ? ' selected' : ''}>${automaticCoverLabel}</option><option value="${NO_REEL_COVER_IMAGE}"${coverChoice === NO_REEL_COVER_IMAGE ? ' selected' : ''}>Videonun karesini kullan</option>${coverOptions}</select>${coverPreview}</label></div>`;
  }).join('');
  const coverAction = state.videoCoverImages.length
    ? `${state.videoCoverImages.length} kayıtlı kapak`
    : '<a href="#video-library-section" data-scroll="video-library-section">Arşive kapak yükle →</a>';
  panel.innerHTML = `<div class="reel-target-heading"><strong>Her Reel için hesap, açıklama ve kapak</strong><small>Her URL’ye ayrı hesap ve açıklama seçebilirsin. Kapak seçmezsen arşivindeki az kullanılmış JPEG’lerden rastgele atanır; tüm kapaklar sırayla kullanılmadan aynı kapak tekrar seçilmez. İstersen URL’ye özel kapak seç veya videonun karesini kullan. Kapak görselleri kütüphanede saklanır; ${coverAction}. “Genel açıklama” seçiliyse üstteki ortak açıklama uygulanır.</small></div><div class="reel-target-list">${rows}</div>`;
}
function updateStats() {
  const counts = { total: state.rows.length, queued: 0, published: 0, failed: 0 };
  for (const row of state.rows) {
    if (row.status === 'queued') counts.queued++;
    if (row.status === 'published' && row.is_deleted_on_instagram !== true) counts.published++;
    if (row.status === 'failed') counts.failed++;
  }
  for (const [key, value] of Object.entries(counts)) {
    const node = document.querySelector(`#stat-${key}`);
    if (node) node.textContent = String(value);
  }
  const countNode = document.querySelector('#queue-count');
  const navCount = document.querySelector('#nav-count');
  if (countNode) countNode.textContent = String(state.rows.length);
  if (navCount) navCount.textContent = String(counts.queued);
  const videoNavCount = document.querySelector('#video-nav-count');
  const videoLibraryCount = document.querySelector('#video-library-count');
  if (videoNavCount) videoNavCount.textContent = String(state.uploadedVideos.length);
  if (videoLibraryCount) videoLibraryCount.textContent = String(state.uploadedVideos.length);
}
function renderQueue() {
  const list = document.querySelector('#queue-list');
  if (!list) return;
  const etaById = estimateQueueEta(state.rows, state.instagramAccounts);
  const accountById = new Map(state.instagramAccounts.map((account) => [account.id, account]));
  const query = (document.querySelector('#queue-search')?.value || '').trim().toLowerCase();
  const filtered = state.rows.filter((row) => {
    const unavailable = row.status === 'published' && row.is_deleted_on_instagram === true;
    const filterMatch = state.filter === 'all'
      || (state.filter === 'published' && row.status === 'published' && !unavailable)
      || (state.filter === 'unavailable' && unavailable)
      || (!['all', 'published', 'unavailable'].includes(state.filter) && row.status === state.filter);
    const accountName = accountById.get(row.instagram_account_id)?.username || '';
    const queryMatch = !query || `${row.shortcode} ${row.source_url} ${row.caption} ${accountName}`.toLowerCase().includes(query);
    return filterMatch && queryMatch;
  });
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-art">${icon('reel', 28)}</div><strong>${state.rows.length ? 'Bu filtrede içerik yok' : 'Kuyruk henüz boş'}</strong><p>${state.rows.length ? 'Başka bir durum filtresi seçebilirsin.' : 'İlk Reel bağlantını ekle; burada durumunu takip edersin.'}</p>${state.rows.length ? '' : '<a class="text-button" href="#add-section" data-scroll="add-section">Reel ekle →</a>'}</div>`;
  } else {
    list.innerHTML = filtered.map((row, index) => {
      const unavailable = row.status === 'published' && row.is_deleted_on_instagram === true;
      const [label, statusClass] = unavailable
        ? ['Instagram’da yok', 'unavailable']
        : row.status === 'queued' && row.publish_now
          ? ['Hemen paylaşılacak', 'queued']
          : statusMeta(row.status);
      const triggerAt = Date.parse(row.updated_at || '');
      const triggerRecentlySent = row.publish_now && row.stage === 'Hemen paylaşım tetiklendi'
        && Number.isFinite(triggerAt) && Date.now() - triggerAt < 120_000;
      const progress = Math.max(0, Math.min(100, Number(row.progress || 0)));
      const safeUrl = escapeHtml(row.source_url || '');
      const uploadedVideo = Boolean(row.uploaded_video_id);
      const savedVideo = uploadedVideo ? state.uploadedVideos.find((video) => video.id === row.uploaded_video_id) : null;
      const sourceAction = uploadedVideo
        ? (savedVideo?.storage_path
          ? `<button type="button" class="text-button reel-source-preview" data-action="preview-uploaded-video" data-id="${escapeHtml(row.uploaded_video_id)}">Özel videoyu oynat</button>`
          : `<span class="reel-source-note">${row.status === 'published' ? 'Yayınlandı · özgün dosya otomatik silindi' : 'Özel video arşivi'}</span>`)
        : `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">Kaynağı gör ${icon('external', 13)}</a>`;
      const targetAccount = accountById.get(row.instagram_account_id);
      const targetConnected = Boolean(targetAccount && !targetAccount.disconnected_at);
      const targetLabel = targetAccount
        ? `@${targetAccount.username}${targetAccount.disconnected_at ? ' · bağlantı kesildi' : ''}`
        : 'hesap seçilmedi';
      const assignAction = !targetConnected && state.instagram && ['queued', 'failed'].includes(row.status)
        ? `<button class="mini-button mini-assign" data-action="assign-account" data-id="${escapeHtml(row.id)}">Seçili hesaba ata</button>`
        : '';
      const actions = row.status === 'failed'
        ? `${targetConnected ? `<button class="mini-button" data-action="retry" data-id="${escapeHtml(row.id)}">Tekrar dene</button>` : ''}${assignAction}`
        : row.status === 'queued'
          ? `${targetConnected
            ? row.publish_now
              ? triggerRecentlySent
                ? `<button class="mini-button mini-now" disabled title="Bulut işçisi tetiklendi; sırada" data-id="${escapeHtml(row.id)}">Tetiklendi</button>`
                : `<button class="mini-button mini-now" title="Öncelikli Reel’i şimdi yeniden tetikle" data-action="publish-now-retrigger" data-id="${escapeHtml(row.id)}">Şimdi tetikle</button>`
              : `<button class="mini-button mini-now" title="Bu Reel için yayın aralığını atla" data-action="publish-now" data-id="${escapeHtml(row.id)}">Hemen paylaş</button>`
            : assignAction}<button class="mini-button mini-danger" data-action="cancel" data-id="${escapeHtml(row.id)}">Kaldır</button>`
          : '';
      const bar = row.status === 'processing' ? `<div class="progress-line"><span style="width:${progress}%"></span></div>` : '';
      const progressText = row.status === 'processing'
        ? `<small class="progress-caption">${escapeHtml(row.stage || 'İşleniyor')} · toplam ~%${progress}</small>`
        : row.status === 'queued' && etaById.has(row.id)
          ? `<small class="queue-eta">${icon('clock', 12)} ${escapeHtml(triggerRecentlySent ? 'Bulut işçisi tetiklendi; sıra bekleniyor' : formatQueueEta(etaById.get(row.id), Boolean(row.publish_now)))}</small>`
          : '';
      const error = row.status === 'failed' && row.error_message ? `<p class="error-note">${escapeHtml(row.error_message)}</p>` : '';
      return `<article class="reel-row enter" style="--row-index:${Math.min(index, 8)}"><div class="reel-thumb thumb-${index % 4}"><span class="thumb-play">▶</span><span class="thumb-label">${uploadedVideo ? 'CLOUD' : 'REEL'}</span></div><div class="reel-details"><div class="reel-title-line"><strong>${uploadedVideo ? 'Özel video' : `/${escapeHtml(row.shortcode)}`}</strong><span class="status-pill status-${statusClass}"><i></i>${label}</span></div><p class="reel-caption">${escapeHtml(row.caption || 'Açıklama eklenmedi')}</p><small class="reel-target-account ${targetConnected ? '' : 'is-unavailable'}">${icon('reel', 11)} Yayın hesabı: ${escapeHtml(targetLabel)}</small><div class="reel-meta"><span>${icon('clock', 13)} ${fmtDate(row.created_at)}</span>${sourceAction}</div>${bar}${progressText}${error}</div><div class="reel-actions">${actions}</div></article>`;
    }).join('');
  }
  const footer = document.querySelector('#queue-footer');
  if (footer) footer.textContent = state.rows.length ? `En yeni ${Math.min(state.rows.length, 200)} kayıt gösteriliyor · kuyruk durumu otomatik yenilenir · Instagram medya kontrolü yaklaşık 30 dakikada bir` : '';
  updateStats();
}

async function loadQueue(silent = false) {
  if (!state.session) return;
  const { data, error } = await supabase.from('reels_queue')
    .select('id,instagram_account_id,uploaded_video_id,shortcode,shortcode_key,source_url,caption,status,progress,stage,error_message,publish_now,is_deleted_on_instagram,published_instagram_user_id,published_at,instagram_deleted_at,created_at,updated_at')
    .eq('user_id', state.session.user.id).order('created_at', { ascending: false }).limit(200);
  if (error) {
    if (!silent) toast(`Kuyruk yüklenemedi: ${error.message}`, 'error');
    return;
  }
  const previousRows = new Map(state.rows.map((row) => [row.id, row]));
  state.rows = data || [];
  const newlyUnavailable = state.rows.filter((row) =>
    row.status === 'published'
    && row.is_deleted_on_instagram === true
    && previousRows.get(row.id)?.is_deleted_on_instagram !== true
  ).length;
  const restored = state.rows.filter((row) =>
    row.status === 'published'
    && row.is_deleted_on_instagram !== true
    && previousRows.get(row.id)?.is_deleted_on_instagram === true
  ).length;
  renderQueue();
  if (newlyUnavailable) toast(`${newlyUnavailable} Reel Instagram’da artık bulunmadığı için yayınlandı sayısından düşürüldü.`, 'info');
  if (restored) toast(`${restored} Reel Instagram’da yeniden bulundu; yayınlandı sayısına eklendi.`, 'success');
}

async function loadInstagramAccount() {
  if (!state.session) return;
  const userId = state.session.user.id;
  const previousAccountId = state.instagram?.id || '';
  const generation = ++instagramAccountLoadGeneration;
  const { data, error } = await supabase.from('instagram_accounts')
    .select('id,instagram_user_id,username,token_expires_at,connected_at,publish_interval_minutes,last_published_at,last_processed_at,last_media_sync_at,disconnected_at')
    .eq('user_id', userId).order('connected_at', { ascending: false }).limit(50);
  if (generation !== instagramAccountLoadGeneration || state.session?.user?.id !== userId) return;
  if (error) {
    if (state.instagram) saveReelDraft();
    state.instagram = null;
    state.instagramAccounts = [];
    state.selectedCaptionTemplateId = '';
    renderInstagramAccount();
    renderReelTargetAssignments();
    renderCaptionTemplates();
    renderQueue();
    toast('Instagram bağlantı durumu alınamadı. Sayfayı yenileyip tekrar dene.', 'error');
    return;
  }
  state.instagramAccounts = data || [];
  const key = activeInstagramStorageKey();
  let savedAccountId = '';
  try { savedAccountId = key ? localStorage.getItem(key) || '' : ''; } catch { /* Device storage may be restricted. */ }
  const selectedAccount = selectInstagramAccount(state.instagramAccounts, savedAccountId, state.preferNewestInstagramAccount);
  if (previousAccountId && previousAccountId !== selectedAccount?.id) saveReelDraft();
  state.instagram = selectedAccount;
  state.preferNewestInstagramAccount = false;
  if (state.instagram) saveActiveInstagramSelection(state.instagram.id);
  if (previousAccountId !== state.instagram?.id) {
    state.selectedCaptionTemplateId = '';
    restoreReelDraft();
  }
  renderInstagramAccount();
  renderReelTargetAssignments();
  renderCaptionTemplates();
  renderQueue();
  renderUploadedVideos();
}

async function loadCaptionTemplates() {
  const userId = state.session?.user?.id;
  const generation = ++captionTemplateLoadGeneration;
  state.captionTemplates = [];
  state.captionTemplatesError = '';
  state.selectedCaptionTemplateId = '';
  state.captionTemplatesLoading = Boolean(userId);
  renderCaptionTemplates();
  renderReelTargetAssignments();
  if (!userId) return;

  const { data, error } = await supabase.from('instagram_caption_templates')
    .select('id,name,caption,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (generation !== captionTemplateLoadGeneration || state.session?.user?.id !== userId) return;
  state.captionTemplatesLoading = false;
  state.captionTemplatesError = error ? 'Şablonlar yüklenemedi. Sayfayı yenileyip tekrar dene.' : '';
  state.captionTemplates = Array.isArray(data) ? data : [];
  renderCaptionTemplates();
  renderReelTargetAssignments();
  renderUploadedVideos();
}

function renderCaptionTemplates() {
  const select = document.querySelector('#caption-template-select');
  if (!select) return;
  const hasUser = Boolean(state.session?.user?.id);
  const options = state.captionTemplates.map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`).join('');
  const placeholder = state.captionTemplatesLoading ? 'Şablonlar yükleniyor…' : state.captionTemplates.length ? 'Bir şablon seç…' : 'Henüz kayıtlı şablon yok';
  select.innerHTML = `<option value="">${placeholder}</option>${options}`;
  select.disabled = !hasUser || state.captionTemplatesLoading || !state.captionTemplates.length;
  if (state.captionTemplates.some((template) => template.id === state.selectedCaptionTemplateId)) select.value = state.selectedCaptionTemplateId;
  else state.selectedCaptionTemplateId = '';

  const nameInput = document.querySelector('#caption-template-name');
  const saveButton = document.querySelector('#save-caption-template');
  const deleteButton = document.querySelector('#delete-caption-template');
  if (nameInput) nameInput.disabled = !hasUser || state.captionTemplatesLoading;
  if (saveButton) saveButton.disabled = !hasUser || state.captionTemplatesLoading;
  if (deleteButton) deleteButton.disabled = !hasUser || state.captionTemplatesLoading || !state.selectedCaptionTemplateId;

  const status = document.querySelector('#caption-template-status');
  if (!status) return;
  status.textContent = !hasUser
    ? 'Şablonlar için önce ReelFlow hesabına giriş yap.'
    : state.captionTemplatesLoading
      ? 'Ortak şablonlar buluttan yükleniyor…'
      : state.captionTemplatesError
        ? state.captionTemplatesError
        : state.captionTemplates.length
          ? `${state.captionTemplates.length} şablon tüm Instagram hesaplarında hazır.`
          : 'Henüz kayıtlı şablon yok.';
  status.dataset.state = state.captionTemplatesError ? 'error' : 'info';
}

function videoDraftStorageKey(userId = state.session?.user?.id) {
  return userId ? `${VIDEO_DRAFT_STORAGE_PREFIX}:${userId}` : null;
}

function loadVideoDraftsForUser(userId) {
  if (!userId || state.uploadedVideoDraftsUserId === userId) return;
  state.uploadedVideoDraftsUserId = userId;
  try {
    const value = JSON.parse(localStorage.getItem(videoDraftStorageKey(userId)) || '{}');
    state.uploadedVideoDrafts = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    state.uploadedVideoDrafts = {};
  }
}

function persistVideoDrafts() {
  const key = videoDraftStorageKey();
  if (!key) return;
  try {
    if (Object.keys(state.uploadedVideoDrafts).length) localStorage.setItem(key, JSON.stringify(state.uploadedVideoDrafts));
    else localStorage.removeItem(key);
  } catch (error) {
    console.warn('Video yayın taslakları bu cihazda saklanamadı:', error?.name || 'storage error');
  }
}

function saveVideoCardDraft(card) {
  const videoId = card?.dataset.videoId;
  if (!videoId || !state.session?.user?.id) return;
  state.uploadedVideoDrafts[videoId] = {
    accountId: card.querySelector('[data-video-account-select]')?.value || '',
    templateId: card.querySelector('[data-video-template-select]')?.value || '',
    coverImageId: card.querySelector('[data-video-cover-select]')?.value || '',
    caption: card.querySelector('[data-video-caption]')?.value || '',
    rightsConfirmed: card.querySelector('[data-video-rights]')?.checked === true,
  };
  persistVideoDrafts();
}

function formatStorageGigabytes(bytes) {
  return (Math.max(0, Number(bytes) || 0) / (1024 ** 3)).toLocaleString('tr-TR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function renderVideoStorageUsage() {
  const remaining = document.querySelector('#video-storage-remaining');
  const detail = document.querySelector('#video-storage-detail');
  const updated = document.querySelector('#video-storage-updated');
  const meter = document.querySelector('.video-storage-meter');
  const fill = document.querySelector('#video-storage-meter-fill');
  if (!remaining || !detail || !meter || !fill) return;
  const usage = state.videoStorageUsage;
  if (!usage) {
    remaining.textContent = 'Depolama bilgisi alınamadı';
    detail.textContent = 'Bağlantını kontrol edip yenile.';
    fill.style.width = '0%';
    meter.setAttribute('aria-valuenow', '0');
    if (updated) updated.textContent = 'Kota ölçümü henüz tamamlanmadı.';
    return;
  }
  const used = Math.max(0, Number(usage.usedBytes) || 0);
  const quota = Math.max(1, Number(usage.quotaBytes) || 1024 ** 3);
  const left = Math.max(0, Math.min(quota, Number(usage.remainingBytes) || 0));
  const percent = Math.min(100, Math.max(0, used / quota * 100));
  remaining.textContent = `Kalan ${formatStorageGigabytes(left)} GB`;
  const activeImports = state.videoImports.filter((job) => ['queued', 'processing'].includes(job.status)).length;
  detail.textContent = `${formatStorageGigabytes(used)} / ${formatStorageGigabytes(quota)} GB kullanılıyor · ${state.uploadedVideos.length} video arşivde${activeImports ? ` · ${activeImports} indirme sürüyor/sırada` : ''}`;
  fill.style.width = `${percent.toFixed(2)}%`;
  meter.setAttribute('aria-valuenow', String(Math.round(percent)));
  meter.classList.toggle('is-near-limit', percent >= 85);
  if (updated && usage.fetchedAt) {
    updated.textContent = `Proje genelindeki kullanım · Son ölçüm ${new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(usage.fetchedAt))}`;
  }
}

async function loadVideoStorageUsage(silent = true) {
  const userId = state.session?.user?.id;
  const generation = ++videoStorageLoadGeneration;
  if (!userId) return;
  try {
    const { data, error } = await supabase.rpc('reelflow_storage_usage');
    if (generation !== videoStorageLoadGeneration || state.session?.user?.id !== userId) return;
    const row = Array.isArray(data) ? data[0] : data;
    const usedBytes = Number(row?.used_bytes);
    const quotaBytes = Number(row?.quota_bytes);
    const remainingBytes = Number(row?.remaining_bytes);
    state.videoStorageUsage = error || ![usedBytes, quotaBytes, remainingBytes].every(Number.isFinite)
      ? null
      : { usedBytes, quotaBytes, remainingBytes, fetchedAt: Date.now() };
    renderVideoStorageUsage();
    if (error && !silent) toast('Bulut depolama kullanımı alınamadı. Bağlantını kontrol edip yeniden dene.', 'warn');
  } catch {
    if (generation !== videoStorageLoadGeneration || state.session?.user?.id !== userId) return;
    state.videoStorageUsage = null;
    renderVideoStorageUsage();
    if (!silent) toast('Bulut depolama kullanımı alınamadı. Bağlantını kontrol edip yeniden dene.', 'warn');
  }
}

function renderVideoCoverLibrary() {
  const holder = document.querySelector('#video-cover-image-list');
  if (!holder) return;
  if (state.videoCoverImagesError) {
    holder.innerHTML = `<div class="video-covers-empty">${escapeHtml(state.videoCoverImagesError)}</div>`;
    return;
  }
  if (!state.videoCoverImages.length) {
    holder.innerHTML = '<div class="video-covers-empty">Henüz kapak eklenmedi. JPG görsellerini buraya yükle; ardından her video kartından istediğini seç.</div>';
    return;
  }
  holder.innerHTML = state.videoCoverImages.map((cover) => `<article class="video-cover-item" data-cover-id="${escapeHtml(cover.id)}">
    ${cover.signedUrl ? `<img src="${escapeHtml(cover.signedUrl)}" alt="${escapeHtml(cover.original_filename)}" loading="lazy" />` : '<div class="video-cover-placeholder">Önizleme yenile</div>'}
    <div class="video-cover-item-meta"><strong title="${escapeHtml(cover.original_filename)}">${escapeHtml(cover.original_filename)}</strong><small>${formatVideoFileSize(cover.size_bytes)}${cover.created_at ? ` · ${escapeHtml(fmtDate(cover.created_at))}` : ''}</small></div>
    <button type="button" class="mini-button mini-danger" data-action="delete-video-cover" data-id="${escapeHtml(cover.id)}">Sil</button>
  </article>`).join('');
}

async function loadUploadedVideos(silent = false) {
  const userId = state.session?.user?.id;
  const generation = ++videoLibraryLoadGeneration;
  if (!userId) return;
  loadVideoDraftsForUser(userId);
  state.uploadedVideosLoading = true;
  state.uploadedVideosError = '';
  renderUploadedVideos();
  const [videoResult, importResult, coverResult] = await Promise.all([
    supabase.from('uploaded_videos')
      .select('id,user_id,original_filename,storage_path,mime_type,size_bytes,cleanup_pending,created_at,source_shortcode')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('video_import_jobs')
      .select('id,shortcode,status,progress,stage,error_message,attempts,uploaded_video_id,created_at,updated_at,finished_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('video_cover_images')
      .select('id,user_id,storage_path,original_filename,mime_type,size_bytes,cleanup_pending,created_at')
      .eq('user_id', userId).eq('cleanup_pending', false).order('created_at', { ascending: false }).limit(50),
  ]);
  if (generation !== videoLibraryLoadGeneration || state.session?.user?.id !== userId) return;
  state.uploadedVideosLoading = false;
  if (videoResult.error || importResult.error) {
    state.uploadedVideosError = 'Özel video arşivi yüklenemedi. Bağlantını kontrol edip yenile.';
    state.uploadedVideos = [];
    state.videoImports = [];
    if (!silent) toast(state.uploadedVideosError, 'error');
  } else {
    state.uploadedVideos = (Array.isArray(videoResult.data) ? videoResult.data : []).filter((video) => video.storage_path && !video.cleanup_pending);
    state.videoImports = Array.isArray(importResult.data) ? importResult.data : [];
  }
  state.videoCoverImagesError = coverResult.error ? 'Kapak kütüphanesi yüklenemedi; yenilemeyi dene.' : '';
  const covers = coverResult.error ? [] : (Array.isArray(coverResult.data) ? coverResult.data : []);
  if (covers.length) {
    try {
      const { data: signedCovers } = await supabase.storage.from(VIDEO_COVER_BUCKET)
        .createSignedUrls(covers.map((cover) => cover.storage_path), 86400);
      if (generation !== videoLibraryLoadGeneration || state.session?.user?.id !== userId) return;
      state.videoCoverImages = covers.map((cover, index) => ({
        ...cover, signedUrl: signedCovers?.[index]?.signedUrl || '',
      }));
    } catch {
      if (generation !== videoLibraryLoadGeneration || state.session?.user?.id !== userId) return;
      state.videoCoverImages = covers.map((cover) => ({ ...cover, signedUrl: '' }));
    }
  } else {
    state.videoCoverImages = [];
  }
  renderUploadedVideos();
  renderReelTargetAssignments();
  renderQueue();
  void loadVideoStorageUsage(true);
}

function renderVideoImportStatuses() {
  const holder = document.querySelector('#video-import-status-list');
  if (!holder) return;
  const activeStatuses = ['queued', 'processing'];
  const activeCount = state.videoImports.filter((job) => activeStatuses.includes(job.status)).length;
  const readyCount = state.videoImports.filter((job) => job.status === 'ready').length;
  const failedCount = state.videoImports.filter((job) => job.status === 'failed').length;
  const counts = { all: state.videoImports.length, active: activeCount, ready: readyCount, failed: failedCount };
  for (const [key, value] of Object.entries(counts)) {
    const node = document.querySelector(`#video-history-count-${key}`);
    if (node) node.textContent = String(value);
  }
  const selectedFilter = ['all', 'active', 'ready', 'failed'].includes(state.videoImportFilter) ? state.videoImportFilter : 'all';
  document.querySelectorAll('[data-import-filter]').forEach((button) => {
    const selected = button.dataset.importFilter === selectedFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });

  if (state.uploadedVideosLoading && !state.videoImports.length) {
    holder.innerHTML = '<div class="video-history-empty"><span class="spinner"></span><span>İndirme geçmişi yükleniyor…</span></div>';
    return;
  }
  if (!state.videoImports.length) {
    holder.innerHTML = '<div class="video-history-empty">Henüz bir indirme işlemi yok. Eklediğin Reel URL’lerinin durumu ve geçmişi burada görünecek.</div>';
    return;
  }

  const visibleJobs = state.videoImports.filter((job) => {
    if (selectedFilter === 'active') return activeStatuses.includes(job.status);
    if (selectedFilter === 'ready' || selectedFilter === 'failed') return job.status === selectedFilter;
    return true;
  });
  if (!visibleJobs.length) {
    holder.innerHTML = '<div class="video-history-empty">Bu filtrede gösterilecek indirme yok.</div>';
    return;
  }

  const statusLabels = { queued: 'Sırada', processing: 'İndiriliyor', ready: 'Tamamlandı', failed: 'Hata', cancelled: 'İptal edildi' };
  const statusClasses = { queued: 'is-queued', processing: 'is-processing', ready: 'is-ready', failed: 'is-failed', cancelled: 'is-cancelled' };
  holder.innerHTML = visibleJobs.map((job) => {
    const status = statusLabels[job.status] || 'Bilinmiyor';
    const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
    const detail = job.status === 'failed'
      ? (job.error_message || job.stage || 'Bu bağlantıdan video alınamadı. Tekrar deneyebilirsin.')
      : job.status === 'processing'
        ? `${progress}% · ${job.stage || 'Video işleniyor'}`
        : job.status === 'ready'
          ? (job.stage || 'Video özel bulut arşivine kaydedildi')
          : job.status === 'cancelled'
            ? (job.stage || 'İşlem iptal edildi')
            : (job.stage || 'Bulut işçisi sırayı bekliyor');
    const createdDate = job.created_at ? fmtHistoryDate(job.created_at) : '';
    const finishedDate = job.finished_at ? fmtHistoryDate(job.finished_at) : '';
    const attempts = Math.max(0, Number(job.attempts || 0));
    const meta = [createdDate ? `Eklendi ${createdDate}` : '', finishedDate ? `Bitti ${finishedDate}` : '', attempts ? `Deneme ${attempts}` : ''].filter(Boolean).join(' · ');
    const mark = job.status === 'ready' ? icon('check', 15) : job.status === 'failed' ? icon('alert', 15) : job.status === 'processing' ? '<span class="video-import-spinner" aria-hidden="true"></span>' : icon('clock', 15);
    const progressBar = activeStatuses.includes(job.status)
      ? `<div class="video-history-progress" role="progressbar" aria-label="İndirme ilerlemesi" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${job.status === 'queued' ? 0 : progress}%"></span></div>`
      : '';
    const retryButton = job.status === 'failed'
      ? `<button type="button" class="mini-button" data-action="retry-video-import" data-id="${escapeHtml(job.id)}">Tekrar dene</button>`
      : '';
    return `<article class="video-history-item ${statusClasses[job.status] || ''}"><span class="video-history-mark">${mark}</span><div class="video-history-main"><div class="video-history-title"><strong>/${escapeHtml(job.shortcode)}</strong><span>${escapeHtml(status)}</span></div><small class="video-history-detail">${escapeHtml(detail)}</small>${meta ? `<small class="video-history-meta">${escapeHtml(meta)}</small>` : ''}${progressBar}</div>${retryButton}</article>`;
  }).join('');
  const navCount = document.querySelector('#video-nav-count');
  const count = document.querySelector('#video-library-count');
  if (navCount) navCount.textContent = String(state.uploadedVideos.length + activeCount);
  if (count) count.textContent = String(state.uploadedVideos.length + activeCount);
}

function renderUploadedVideos() {
  const list = document.querySelector('#video-library-list');
  if (!list) return;
  const connected = state.instagramAccounts.filter((account) => account && !account.disconnected_at);
  const defaultAccountId = connected.some((account) => account.id === state.instagram?.id)
    ? state.instagram.id
    : connected[0]?.id || '';
  const activeImports = state.videoImports.filter((job) => ['queued', 'processing'].includes(job.status)).length;
  const count = document.querySelector('#video-library-count');
  const navCount = document.querySelector('#video-nav-count');
  renderVideoStorageUsage();
  renderVideoCoverLibrary();
  if (count) count.textContent = String(state.uploadedVideos.length + activeImports);
  if (navCount) navCount.textContent = String(state.uploadedVideos.length + activeImports);
  renderVideoImportStatuses();
  if (state.uploadedVideosLoading) {
    list.innerHTML = '<div class="loading-row"><span class="spinner"></span> Video arşivi yükleniyor…</div>';
    return;
  }
  if (state.uploadedVideosError) {
    list.innerHTML = `<div class="empty-state"><strong>${escapeHtml(state.uploadedVideosError)}</strong><button type="button" class="text-button" data-action="refresh-uploaded-videos">Tekrar dene</button></div>`;
    return;
  }
  if (!state.uploadedVideos.length) {
    list.innerHTML = '<div class="empty-state video-library-empty"><div class="empty-art">▶</div><strong>Arşiv henüz boş</strong><p>Instagram Reel URL’sini yukarıya yapıştır. Buluta kaydedilince buradan oynatabilir, hesabı ve açıklama taslağını seçerek kuyruğa gönderebilirsin.</p></div>';
    return;
  }

  list.innerHTML = state.uploadedVideos.map((video, index) => {
    const draft = state.uploadedVideoDrafts[video.id] || {};
    const selectedAccountId = connected.some((account) => account.id === draft.accountId) ? draft.accountId : defaultAccountId;
    const staleAccount = draft.accountId && !connected.some((account) => account.id === draft.accountId)
      ? `<option value="${escapeHtml(draft.accountId)}" selected disabled>Seçili hesap bağlı değil</option>` : '';
    const accountOptions = connected.map((account) => `<option value="${escapeHtml(account.id)}"${account.id === selectedAccountId ? ' selected' : ''}>@${escapeHtml(account.username)}</option>`).join('');
    const selectedTemplateId = draft.templateId || '';
    const templateExists = state.captionTemplates.some((template) => template.id === selectedTemplateId);
    const staleTemplate = selectedTemplateId && !templateExists
      ? `<option value="${escapeHtml(selectedTemplateId)}" selected disabled>Seçili şablon bulunamadı</option>` : '';
    const templateOptions = state.captionTemplates.map((template) => `<option value="${escapeHtml(template.id)}"${template.id === selectedTemplateId ? ' selected' : ''}>${escapeHtml(template.name)}</option>`).join('');
    const selectedCoverId = draft.coverImageId || '';
    const selectedCover = state.videoCoverImages.find((cover) => cover.id === selectedCoverId);
    const staleCoverOption = selectedCoverId && !selectedCover
      ? `<option value="${escapeHtml(selectedCoverId)}" selected disabled>Seçili kapak bulunamadı</option>` : '';
    const coverOptions = state.videoCoverImages.map((cover) => `<option value="${escapeHtml(cover.id)}"${cover.id === selectedCoverId ? ' selected' : ''}>${escapeHtml(cover.original_filename)}</option>`).join('');
    const coverPreview = selectedCover?.signedUrl
      ? `<img src="${escapeHtml(selectedCover.signedUrl)}" alt="${escapeHtml(selectedCover.original_filename)}" loading="lazy" />`
      : selectedCover ? '<small>Kapak önizlemesi yenilemede tekrar yüklenir.</small>' : '<small>Seçilmezse Instagram videonun karesini kullanır.</small>';
    const date = video.created_at ? fmtDate(video.created_at) : '';
    const fileAvailable = Boolean(video.storage_path) && !video.cleanup_pending;
    const controlsDisabled = !fileAvailable || connected.length === 0 ? ' disabled' : '';
    const storageStatus = video.cleanup_pending ? 'Yayın sonrası temizlik sürüyor' : fileAvailable ? 'Özel bulut kopyası hazır' : 'Dosya depodan kaldırıldı';
    return `<article class="video-library-card enter" data-video-card data-video-id="${escapeHtml(video.id)}" style="--row-index:${Math.min(index, 8)}">
      <div class="video-card-heading"><div class="video-card-mark">${icon('reel', 18)}</div><div class="video-card-title"><strong>${escapeHtml(video.original_filename)}</strong><small>${formatVideoFileSize(video.size_bytes)}${date ? ` · ${escapeHtml(date)}` : ''}</small><small class="video-storage-state">${escapeHtml(storageStatus)}</small></div></div>
      <div class="video-card-fields">
        <label class="video-card-field"><span>Yayın hesabı</span><select data-video-account-select data-video-id="${escapeHtml(video.id)}" aria-label="${escapeHtml(video.original_filename)} yayın hesabı"${controlsDisabled}>${staleAccount}${connected.length ? accountOptions : '<option value="">Önce Instagram hesabı bağla</option>'}</select></label>
        <label class="video-card-field"><span>Açıklama şablonu</span><select data-video-template-select data-video-id="${escapeHtml(video.id)}" aria-label="${escapeHtml(video.original_filename)} açıklama şablonu"${state.captionTemplatesLoading ? ' disabled' : ''}>${staleTemplate}<option value=""${selectedTemplateId ? '' : ' selected'}>Şablon seç…</option>${templateOptions}</select></label>
        <label class="video-card-field video-card-cover-field"><span>Reels kapağı</span><select data-video-cover-select data-video-id="${escapeHtml(video.id)}" aria-label="${escapeHtml(video.original_filename)} Reels kapağı"${fileAvailable ? '' : ' disabled'}>${staleCoverOption}<option value=""${selectedCoverId ? '' : ' selected'}>Videonun karesini kullan</option>${coverOptions}</select><span class="video-cover-selected-preview" data-video-cover-preview>${coverPreview}</span></label>
        <label class="video-card-field video-card-caption"><span>Paylaşım açıklaması</span><textarea data-video-caption data-video-id="${escapeHtml(video.id)}" maxlength="2200" rows="2" placeholder="Bu video için açıklama…">${escapeHtml(draft.caption || '')}</textarea></label>
      </div>
      <label class="rights-check video-card-rights"><input type="checkbox" data-video-rights data-video-id="${escapeHtml(video.id)}"${draft.rightsConfirmed ? ' checked' : ''} /><span>Bu videoyu paylaşma hakkım var veya izin aldım.</span></label>
      <div class="video-card-actions"><button type="button" class="mini-button" data-action="preview-uploaded-video" data-id="${escapeHtml(video.id)}"${fileAvailable ? '' : ' disabled'}>${icon('play', 13)} ${fileAvailable ? 'Oynat' : 'Dosya silindi'}</button><button type="button" class="mini-button video-queue-button" data-action="queue-uploaded-video" data-id="${escapeHtml(video.id)}"${controlsDisabled}>Kuyruğa ekle</button><button type="button" class="mini-button mini-danger" data-action="delete-uploaded-video" data-id="${escapeHtml(video.id)}"${fileAvailable ? '' : ' disabled'}>Sil</button></div>
    </article>`;
  }).join('');
}

async function enqueueVideoImports(form) {
  if (state.videoImportBusy) return;
  const userId = state.session?.user?.id;
  const userGeneration = authUserGeneration;
  const input = form.querySelector('#video-import-urls');
  const rights = form.querySelector('#video-import-rights');
  const button = form.querySelector('#video-import-submit');
  const parsed = parseReelLines(input?.value || '');
  if (!userId) {
    toast('Önce ReelFlow hesabına giriş yap.', 'warn');
    return;
  }
  if (!parsed.items.length) {
    toast(parsed.invalid[0]?.reason || 'Arşive eklemek için bir Instagram Reel URL’si gir.', 'warn');
    return;
  }
  if (parsed.items.length > MAX_VIDEO_IMPORTS_PER_BATCH) {
    toast(`Tek seferde en fazla ${MAX_VIDEO_IMPORTS_PER_BATCH} farklı URL ekleyebilirsin. Listeyi bölüp tekrar dene.`, 'warn');
    return;
  }
  if (!rights?.checked) {
    toast('Devam etmek için videoları saklama/paylaşma hakkını onayla.', 'warn');
    rights?.focus();
    return;
  }
  state.videoImportBusy = true;
  form.querySelectorAll('button, textarea, input').forEach((control) => { control.disabled = true; });
  if (button) button.textContent = `Kuyruğa ekleniyor 0/${parsed.items.length}…`;
  let duplicate = parsed.duplicates;
  let failed = parsed.invalid.length;
  let completed = 0;
  const results = await mapWithConcurrency(parsed.items, VIDEO_IMPORT_CONCURRENCY, async (item) => {
    try {
      if (authUserGeneration !== userGeneration || state.session?.user?.id !== userId) return { kind: 'stale' };
      const { data, error } = await supabase.rpc('enqueue_video_import', {
        p_source_url: item.url,
        p_rights_confirmed: true,
        p_expected_user_id: userId,
      });
      if (error) {
        return error.code === '23505' || /video_import_duplicate|already archived/i.test(error.message || '')
          ? { kind: 'duplicate' }
          : { kind: 'failed' };
      }
      return data ? { kind: 'added', id: typeof data === 'string' ? data : '' } : { kind: 'duplicate' };
    } catch {
      return { kind: 'failed' };
    } finally {
      completed += 1;
      if (button && authUserGeneration === userGeneration && state.session?.user?.id === userId) {
        button.textContent = `Kuyruğa ekleniyor ${completed}/${parsed.items.length}…`;
      }
    }
  });
  if (authUserGeneration !== userGeneration || state.session?.user?.id !== userId) return;
  let added = 0;
  const addedImportIds = [];
  for (const result of results) {
    if (result?.kind === 'added') {
      added += 1;
      if (result.id) addedImportIds.push(result.id);
    } else if (result?.kind === 'duplicate') duplicate += 1;
    else if (result?.kind === 'failed') failed += 1;
  }
  let workerTriggered = false;
  if (addedImportIds.length) {
    if (button) button.textContent = 'Bulut işçisi başlatılıyor…';
    try {
      const { data: triggerData, error: triggerError } = await supabase.functions.invoke('publish-now-trigger', {
        body: { video_import_id: addedImportIds[0] },
      });
      workerTriggered = !triggerError && !triggerData?.error;
    } catch {
      workerTriggered = false;
    }
    if (authUserGeneration !== userGeneration || state.session?.user?.id !== userId) return;
  }
  state.videoImportBusy = false;
  if (failed === 0) {
    if (input) input.value = '';
    if (rights) rights.checked = false;
    updateVideoImportCounter();
  }
  form.querySelectorAll('button, textarea, input').forEach((control) => { control.disabled = false; });
  if (button) button.innerHTML = `${icon('plus', 17)} Buluta kaydet`;
  await loadUploadedVideos(true);
  const parts = [];
  if (added) parts.push(`${added} Reel bulut indirme kuyruğuna eklendi`);
  if (added) parts.push(workerTriggered ? 'Bulut işçisi tetiklendi (tur başına en çok 5 URL; kalanı kuyrukta)' : 'Otomatik işçi turunda indirilecek');
  if (duplicate) parts.push(`${duplicate} zaten arşivde veya sırada`);
  if (failed) parts.push(`${failed} bağlantı eklenemedi`);
  toast(parts.join(' · ') || 'Arşiv kuyruğu değişmedi.', failed ? 'warn' : 'success');
  if (failed && parsed.invalid[0]?.reason) toast(parsed.invalid[0].reason, 'warn');
}

function updateVideoImportCounter() {
  const input = document.querySelector('#video-import-urls');
  const counter = document.querySelector('#video-import-counter');
  if (!input || !counter) return;
  const count = parseReelLines(input.value).items.length;
  counter.textContent = `${count} / ${MAX_VIDEO_IMPORTS_PER_BATCH} URL`;
  counter.classList.toggle('is-over-limit', count > MAX_VIDEO_IMPORTS_PER_BATCH);
}

function appendVideoImportText(rawText) {
  const input = document.querySelector('#video-import-urls');
  const text = String(rawText || '').replace(/^\uFEFF/, '').trim();
  if (!input || !text) {
    toast('Metinde eklenecek URL bulunamadı.', 'warn');
    return;
  }
  if (text.length > 1024 * 1024) {
    toast('URL listesi 1 MB’tan küçük olmalı.', 'warn');
    return;
  }
  const combined = [input.value.trim(), text].filter(Boolean).join('\n');
  const beforeCount = parseReelLines(input.value).items.length;
  const parsed = parseReelLines(combined);
  if (parsed.items.length > MAX_VIDEO_IMPORTS_PER_BATCH) {
    toast(`Tek seferde en fazla ${MAX_VIDEO_IMPORTS_PER_BATCH} farklı URL ekleyebilirsin. Listeyi böl.`, 'warn');
    return;
  }
  input.value = combined;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const addedCount = Math.max(0, parsed.items.length - beforeCount);
  toast(addedCount ? `${addedCount} URL toplu listeye eklendi.` : 'Bu listedeki URL’ler zaten ekli veya geçersiz.', addedCount ? 'success' : 'info');
}

async function retryVideoImport(importId) {
  const button = [...document.querySelectorAll('[data-action="retry-video-import"]')]
    .find((item) => item.dataset.id === importId);
  if (button) { button.disabled = true; button.textContent = 'Tekrar sıraya alınıyor…'; }
  let data = null;
  let error = null;
  try {
    ({ data, error } = await supabase.rpc('retry_video_import', { p_import_id: importId }));
  } catch {
    error = new Error('network_error');
  }
  if (error) toast('Bulut indirme tekrar başlatılamadı. Bağlantıyı kontrol edip yeniden dene.', 'error');
  else if (data) toast('Instagram bağlantısı yeniden bulut kuyruğuna alındı.', 'success');
  else toast('Bu indirme artık tekrar denenemiyor; arşiv durumunu yeniledim.', 'info');
  await loadUploadedVideos(true);
}

async function previewUploadedVideo(videoId) {
  const userId = state.session?.user?.id;
  const userGeneration = authUserGeneration;
  const video = state.uploadedVideos.find((item) => item.id === videoId && item.storage_path && !item.cleanup_pending);
  if (!userId || !video) {
    toast('Bu video arşivde bulunamadı; listeyi yenile.', 'warn');
    return;
  }
  const { data, error } = await supabase.storage.from(VIDEO_STORAGE_BUCKET).createSignedUrl(video.storage_path, 3600);
  if (authUserGeneration !== userGeneration || state.session?.user?.id !== userId
      || !state.uploadedVideos.some((item) => item.id === videoId && item.storage_path === video.storage_path)) return;
  const signedUrl = data?.signedUrl || data?.signedURL;
  if (error || !signedUrl) {
    toast('Video için güvenli oynatma bağlantısı oluşturulamadı.', 'error');
    return;
  }
  closeVideoPreview();
  const modal = document.createElement('div');
  modal.id = 'video-preview-modal';
  modal.className = 'video-preview-modal';
  modal.innerHTML = `<section class="video-preview-dialog" role="dialog" aria-modal="true" aria-label="Video oynatıcı"><div class="video-preview-heading"><strong>${escapeHtml(video.original_filename)}</strong><button type="button" class="icon-button" data-action="close-video-preview" aria-label="Oynatıcıyı kapat">×</button></div><video src="${escapeHtml(signedUrl)}" controls controlslist="nodownload" playsinline preload="metadata"></video><small>Bağlantı özel ve süreli; oynatım için videonun tamamı telefona indirilmez.</small></section>`;
  root.append(modal);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeVideoPreview(); });
}

function closeVideoPreview() {
  const modal = document.querySelector('#video-preview-modal');
  const player = modal?.querySelector('video');
  if (player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  modal?.remove();
}

async function uploadVideoCovers(form) {
  if (state.videoCoverUploadBusy) return;
  const userId = state.session?.user?.id;
  const userGeneration = authUserGeneration;
  const input = form.querySelector('#video-cover-files');
  const files = Array.from(input?.files || []);
  const status = form.querySelector('#video-cover-upload-status');
  const button = form.querySelector('#video-cover-submit');
  if (!userId) return toast('Önce ReelFlow hesabına giriş yap.', 'warn');
  if (!files.length) return toast('Yüklemek için JPEG kapak görselleri seç.', 'warn');
  if (files.length > MAX_COVER_IMAGES_PER_BATCH) {
    return toast(`Tek seferde en fazla ${MAX_COVER_IMAGES_PER_BATCH} kapak görseli seçebilirsin.`, 'warn');
  }
  const invalid = files.map((file) => validateCoverImageFile(file)).find(Boolean);
  if (invalid) return toast(invalid, 'warn');

  state.videoCoverUploadBusy = true;
  form.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
  if (status) status.textContent = `0 / ${files.length} kapak yükleniyor…`;
  let completed = 0;
  try {
    const results = await mapWithConcurrency(files, 3, async (file) => {
      if (authUserGeneration !== userGeneration || state.session?.user?.id !== userId) return 'stale';
      let coverId;
      try { coverId = createCoverImageId(); } catch { return 'failed'; }
      const storagePath = coverImageStoragePath(userId, coverId);
      try {
        const { error: uploadError } = await supabase.storage.from(VIDEO_COVER_BUCKET).upload(storagePath, file, {
          cacheControl: '3600', contentType: 'image/jpeg', upsert: false,
        });
        if (uploadError) return 'failed';
        if (authUserGeneration !== userGeneration || state.session?.user?.id !== userId) {
          await supabase.storage.from(VIDEO_COVER_BUCKET).remove([storagePath]);
          return 'stale';
        }
        const { error: metadataError } = await supabase.from('video_cover_images').insert({
          id: coverId, user_id: userId, storage_path: storagePath,
          original_filename: Array.from(String(file.name || 'reels-cover.jpg')).slice(0, 255).join(''),
          mime_type: 'image/jpeg', size_bytes: Number(file.size),
        });
        if (metadataError) {
          await supabase.storage.from(VIDEO_COVER_BUCKET).remove([storagePath]);
          return 'failed';
        }
        return 'uploaded';
      } catch {
        return 'failed';
      } finally {
        completed += 1;
        if (status && authUserGeneration === userGeneration && state.session?.user?.id === userId) {
          status.textContent = `${completed} / ${files.length} kapak işlendi…`;
        }
      }
    });
    if (authUserGeneration !== userGeneration || state.session?.user?.id !== userId) return;
    const uploaded = results.filter((result) => result === 'uploaded').length;
    const failed = results.filter((result) => result === 'failed').length;
    if (status) status.textContent = `${uploaded} kapak buluta kaydedildi${failed ? ` · ${failed} yüklenemedi` : ''}.`;
    if (input) input.value = '';
    toast(failed ? `${uploaded} kapak yüklendi; ${failed} dosya başarısız oldu.` : `${uploaded} kapak özel buluta kaydedildi.`, failed ? 'warn' : 'success');
    await loadUploadedVideos(true);
  } finally {
    if (authUserGeneration === userGeneration && state.session?.user?.id === userId) {
      state.videoCoverUploadBusy = false;
      form.querySelectorAll('button, input').forEach((control) => { control.disabled = false; });
      if (button) button.textContent = 'Kapakları buluta yükle';
    }
  }
}

async function deleteVideoCover(coverId) {
  const cover = state.videoCoverImages.find((item) => item.id === coverId);
  if (!cover) return;
  if (!window.confirm(`“${cover.original_filename}” kapak görseli kalıcı olarak silinsin mi?`)) return;
  const { data, error } = await supabase.rpc('claim_video_cover_cleanup', { p_cover_image_id: coverId });
  if (error) {
    toast(error.message?.includes('cover_in_use')
      ? 'Bu kapak sıradaki veya yayınlanmakta olan bir videoda kullanılıyor.'
      : 'Kapak silme işlemi başlatılamadı; tekrar dene.', 'warn');
    return;
  }
  const storagePath = Array.isArray(data) ? data[0]?.storage_path : data?.storage_path;
  if (!storagePath) return toast('Kapak zaten silinmiş veya işlem sürüyor.', 'info');
  const { error: removeError } = await supabase.storage.from(VIDEO_COVER_BUCKET).remove([storagePath]);
  if (removeError) {
    await supabase.rpc('release_video_cover_cleanup', { p_cover_image_id: coverId });
    toast('Kapak depolamadan silinemedi; işlem geri alındı. Yeniden dene.', 'error');
    return;
  }
  const { data: finished, error: finishError } = await supabase.rpc('finish_video_cover_cleanup', { p_cover_image_id: coverId });
  if (finishError || !finished) toast('Görsel silindi; arşiv kaydı yenilemede tamamlanacak.', 'warn');
  else toast('Kapak bulut arşivinden silindi.', 'success');
  await loadUploadedVideos(true);
}

function renderSelectedCoverPreview(card) {
  const holder = card?.querySelector('[data-video-cover-preview]');
  const coverId = card?.querySelector('[data-video-cover-select]')?.value || '';
  if (!holder) return;
  const cover = state.videoCoverImages.find((item) => item.id === coverId);
  holder.innerHTML = cover?.signedUrl
    ? `<img src="${escapeHtml(cover.signedUrl)}" alt="${escapeHtml(cover.original_filename)}" loading="lazy" />`
    : cover ? '<small>Kapak önizlemesi yenilemede tekrar yüklenir.</small>' : '<small>Seçilmezse Instagram videonun karesini kullanır.</small>';
}

async function queueUploadedVideo(videoId) {
  const card = [...document.querySelectorAll('[data-video-card]')].find((item) => item.dataset.videoId === videoId);
  const video = state.uploadedVideos.find((item) => item.id === videoId && item.storage_path && !item.cleanup_pending);
  if (!card || !video) return;
  const accountId = card.querySelector('[data-video-account-select]')?.value || '';
  const templateId = card.querySelector('[data-video-template-select]')?.value || '';
  const captionInput = card.querySelector('[data-video-caption]');
  const rights = card.querySelector('[data-video-rights]');
  const button = card.querySelector('[data-action="queue-uploaded-video"]');
  if (!state.instagramAccounts.some((account) => account.id === accountId && !account.disconnected_at)) {
    toast('Bu video için bağlı bir Instagram hesabı seç.', 'warn');
    return;
  }
  const template = templateId ? state.captionTemplates.find((item) => item.id === templateId) : null;
  if (templateId && !template) {
    toast('Seçilen açıklama şablonu bulunamadı; başka bir şablon seç.', 'warn');
    return;
  }
  const caption = String(captionInput?.value || '').trim();
  if (caption.length > 2200) {
    toast('Açıklama 2200 karakter sınırını aşıyor.', 'warn');
    return;
  }
  if (!rights?.checked) {
    toast('Devam etmek için bu videoyu paylaşma hakkını onayla.', 'warn');
    rights?.focus();
    return;
  }
  saveVideoCardDraft(card);
  if (button) { button.disabled = true; button.textContent = 'Kuyruğa ekleniyor…'; }
  const { data, error } = await supabase.rpc('enqueue_uploaded_video_with_cover', {
    p_uploaded_video_id: videoId,
    p_instagram_account_id: accountId,
    p_caption: caption,
    p_rights_confirmed: true,
    p_cover_image_id: card.querySelector('[data-video-cover-select]')?.value || null,
  });
  if (button) { button.disabled = false; button.textContent = 'Kuyruğa ekle'; }
  if (error) {
    toast('Video kuyruğa eklenemedi. Hesabını ve arşiv durumunu kontrol et.', 'error');
    return;
  }
  if (!data) {
    toast('Bu video seçilen Instagram hesabı için daha önce kuyruğa eklenmiş.', 'info');
    return;
  }
  toast(`Video @${state.instagramAccounts.find((account) => account.id === accountId)?.username || 'Instagram'} hesabının kuyruğuna eklendi.`, 'success');
  await loadQueue(true);
}

async function deleteUploadedVideo(videoId) {
  const video = state.uploadedVideos.find((item) => item.id === videoId && item.storage_path && !item.cleanup_pending);
  if (!video) return;
  const confirmed = window.confirm(`“${video.original_filename}” dosyası kalıcı olarak silinsin mi? Kuyrukta olan videoyu önce kuyruktan kaldırmalısın; başarısız kayıtlar bu onayla iptal edilir.`);
  if (!confirmed) return;
  const { data, error } = await supabase.rpc('claim_uploaded_video_cleanup', { p_uploaded_video_id: videoId });
  if (error) {
    toast(error.message?.includes('video_in_use')
      ? 'Bu video kuyrukta veya şu anda yayınlanıyor. Önce kuyruk kartından kaldır.'
      : 'Video silme işlemi başlatılamadı; tekrar dene.', 'warn');
    return;
  }
  const storagePath = Array.isArray(data) ? data[0]?.storage_path : data?.storage_path;
  if (!storagePath) {
    toast('Video zaten silinmiş veya işlem sürüyor.', 'info');
    await loadUploadedVideos(true);
    return;
  }
  const { error: storageError } = await supabase.storage.from(VIDEO_STORAGE_BUCKET).remove([storagePath]);
  if (storageError) {
    await supabase.rpc('release_uploaded_video_cleanup', { p_uploaded_video_id: videoId });
    toast('Video depolamadan silinemedi; kayıt korunuyor.', 'error');
    return;
  }
  const { error: finishError } = await supabase.rpc('finish_uploaded_video_cleanup', { p_uploaded_video_id: videoId });
  if (finishError) toast('Dosya silindi; arşiv durumu sonraki eşitlemede tamamlanacak.', 'warn');
  else toast('Video bulut arşivinden silindi.', 'success');
  await loadUploadedVideos(true);
  await loadQueue(true);
}

async function saveCaptionTemplate() {
  const userId = state.session?.user?.id;
  const nameInput = document.querySelector('#caption-template-name');
  const captionInput = document.querySelector('#caption-input');
  const button = document.querySelector('#save-caption-template');
  if (!userId || !nameInput || !captionInput) {
    toast('Şablon kaydetmek için ReelFlow hesabına giriş yap.', 'warn');
    return;
  }
  const valid = validateCaptionTemplate(nameInput.value, captionInput.value);
  if (!valid.ok) {
    const messages = {
      name_required: 'Şablonu kaydetmek için bir ad yaz.',
      name_too_long: 'Şablon adı en fazla 60 karakter olabilir.',
      caption_required: 'Önce bir açıklama yaz.',
      caption_too_long: 'Açıklama en fazla 2200 karakter olabilir.',
      combined_too_long: 'Açıklama Instagram sınırı olan 2200 karakteri aşıyor.',
    };
    toast(messages[valid.reason] || 'Şablon bilgilerini kontrol et.', 'warn');
    if (valid.reason.startsWith('name_')) nameInput.focus();
    else captionInput.focus();
    return;
  }

  const existing = state.captionTemplates.find((template) => template.name.toLocaleLowerCase('tr-TR') === valid.name.toLocaleLowerCase('tr-TR'));
  if (button) { button.disabled = true; button.textContent = 'Kaydediliyor…'; }
  const query = existing
    ? supabase.from('instagram_caption_templates').update({ name: valid.name, caption: valid.caption, updated_at: new Date().toISOString() }).eq('id', existing.id).eq('user_id', userId)
    : supabase.from('instagram_caption_templates').insert({ user_id: userId, name: valid.name, caption: valid.caption });
  const { data, error } = await query.select('id,name,caption,updated_at').single();
  if (button) button.textContent = 'Açıklamayı kaydet';
  renderCaptionTemplates();
  if (state.session?.user?.id !== userId) return;
  if (error || !data) {
    toast(error?.code === '23505' ? 'Bu isimde bir şablon zaten var; mevcut şablon adını kullan.' : 'Şablon kaydedilemedi. Bağlantını kontrol edip tekrar dene.', 'error');
    return;
  }
  state.captionTemplates = [data, ...state.captionTemplates.filter((template) => template.id !== data.id)]
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  state.selectedCaptionTemplateId = data.id;
  nameInput.value = '';
  saveReelDraft();
  renderCaptionTemplates();
  renderReelTargetAssignments();
  toast(existing ? 'Ortak açıklama şablonu güncellendi.' : 'Şablon kaydedildi; tüm Instagram hesaplarında ve diğer cihazlarında görünür.', 'success');
}

async function deleteCaptionTemplate() {
  const userId = state.session?.user?.id;
  const templateId = state.selectedCaptionTemplateId;
  const template = state.captionTemplates.find((item) => item.id === templateId);
  if (!userId || !template) return;
  const button = document.querySelector('#delete-caption-template');
  if (button) { button.disabled = true; button.textContent = 'Siliniyor…'; }
  const { error } = await supabase.from('instagram_caption_templates').delete()
    .eq('id', templateId).eq('user_id', userId);
  if (button) button.textContent = 'Seçileni sil';
  if (state.session?.user?.id !== userId) return;
  if (error) {
    toast('Şablon silinemedi. Tekrar dene.', 'error');
    renderCaptionTemplates();
    return;
  }
  state.captionTemplates = state.captionTemplates.filter((item) => item.id !== templateId);
  state.reelCaptionTemplateSelections = Object.fromEntries(Object.entries(state.reelCaptionTemplateSelections).filter(([, selectedId]) => selectedId !== templateId));
  state.selectedCaptionTemplateId = '';
  saveReelDraft();
  renderCaptionTemplates();
  renderReelTargetAssignments();
  toast('Şablon silindi. Açıklama alanındaki metin korundu.', 'success');
}

function renderInstagramAccount() {
  const card = document.querySelector('#instagram-account-card');
  if (!card) return;
  const connected = state.instagramAccounts.filter((account) => !account.disconnected_at);
  if (state.instagram) {
    const intervals = [[60, '1 saat'], [180, '3 saat'], [360, '6 saat'], [720, '12 saat'], [1440, '1 gün'], [2880, '2 gün']];
    const selectedInterval = Number(state.instagram.publish_interval_minutes || 360);
    const options = intervals.map(([minutes, label]) => `<option value="${minutes}" ${selectedInterval === minutes ? 'selected' : ''}>${label}</option>`).join('');
    const accountChoices = connected.map((account) => `<button type="button" class="ig-account-choice ${account.id === state.instagram.id ? 'is-active' : ''}" data-action="switch-account" data-account-id="${escapeHtml(account.id)}" aria-pressed="${account.id === state.instagram.id}">@${escapeHtml(account.username)}</button>`).join('');
    card.innerHTML = `<div class="instagram-account-top"><div class="instagram-account-copy"><span class="ig-connected-mark">✓</span><div><strong>@${escapeHtml(state.instagram.username)}</strong><small>Instagram profesyonel hesabı bağlı · token bitişi ${fmtDate(state.instagram.token_expires_at)}</small></div></div><button type="button" id="instagram-disconnect-button" class="mini-button mini-danger">Seçili hesabı kes</button></div><div class="ig-account-select-row"><div><strong>Yayın hesabı</strong><small>Bir hesaba dokun; yeni Reels o hesaba gider. Kuyruktaki mevcut Reels değişmez.</small></div><div class="ig-account-choices" role="group" aria-label="Yeni Reels için yayın hesabı">${accountChoices}</div></div><div class="ig-account-actions"><button type="button" id="instagram-connect-button" class="mini-button ig-add-account">${icon('plus', 13)} Hesap ekle</button></div><label class="ig-interval-row" for="publish-interval-select"><span><strong>@${escapeHtml(state.instagram.username)} · Reels aralığı</strong><small>Yalnızca seçili hesabın normal aralığıdır; “Hemen paylaş” tek Reel’in beklemesini atlar.</small></span><select id="publish-interval-select" class="ig-interval-select" aria-label="Seçili hesabın Reels aralığı">${options}</select></label><p id="instagram-connect-status" class="oauth-status" role="status" aria-live="polite"></p>`;
  } else {
    const disconnected = state.instagramAccounts[0];
    const title = disconnected ? `@${escapeHtml(disconnected.username)} hesabının bağlantısı kesilmiş` : 'Instagram hesabını bağla';
    const detail = disconnected
      ? 'Kuyruk geçmişi korunuyor. Hesabı yeniden bağlayabilir veya başka bir Instagram hesabı ekleyebilirsin.'
      : 'Business veya Creator hesabı gerekir. Meta uygulaması test modunda olduğundan Instagram Tester davetini kabul etmiş hesaplar bağlanabilir.';
    card.innerHTML = `<div class="instagram-account-copy"><span class="ig-pending-mark">IG</span><div><strong>${title}</strong><small>${detail}</small></div></div><button type="button" id="instagram-connect-button" class="button button-primary ig-connect-button">${icon('reel', 16)} ${disconnected ? 'Instagram hesabı bağla' : 'Hesabımı bağla'}</button><p id="instagram-connect-status" class="oauth-status" role="status" aria-live="polite"></p>`;
  }
  const connectButton = card.querySelector('#instagram-connect-button');
  connectButton?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!connectButton.disabled) void connectInstagram();
  });
  const oauthStatus = card.querySelector('#instagram-connect-status');
  if (oauthStatus && state.instagramConnectionMessage) {
    oauthStatus.textContent = `${state.instagramConnectionMessage.message} (kod: ${state.instagramConnectionMessage.result})`;
    oauthStatus.dataset.state = state.instagramConnectionMessage.type;
    oauthStatus.dataset.result = state.instagramConnectionMessage.result;
  }
  const addButton = document.querySelector('#add-submit');
  if (addButton) addButton.disabled = !state.instagram;
}

async function savePublishInterval(minutes) {
  const allowed = [60, 180, 360, 720, 1440, 2880];
  if (!state.session || !state.instagram || !allowed.includes(minutes)) return;
  const select = document.querySelector('#publish-interval-select');
  if (select) select.disabled = true;
  const { data, error } = await supabase.from('instagram_accounts')
    .update({ publish_interval_minutes: minutes })
    .eq('id', state.instagram.id)
    .eq('user_id', state.session.user.id)
    .select('id,publish_interval_minutes').maybeSingle();
  if (error || !data) {
    toast('Yayın aralığı kaydedilemedi. Tekrar dene.', 'error');
    await loadInstagramAccount();
    return;
  }
  state.instagram = { ...state.instagram, publish_interval_minutes: data.publish_interval_minutes };
  state.instagramAccounts = state.instagramAccounts.map((account) => account.id === data.id ? { ...account, publish_interval_minutes: data.publish_interval_minutes } : account);
  renderInstagramAccount();
  renderQueue();
  const label = { 60: '1 saat', 180: '3 saat', 360: '6 saat', 720: '12 saat', 1440: '1 gün', 2880: '2 gün' }[minutes];
  toast(`Reels aralığı ${label} olarak kaydedildi.`, 'success');
}

async function connectInstagram() {
  const button = document.querySelector('#instagram-connect-button');
  const status = document.querySelector('#instagram-connect-status');
  state.instagramConnectionMessage = null;
  const setStatus = (message, type = 'info') => {
    if (!status?.isConnected) return;
    status.textContent = message;
    status.dataset.state = type;
  };
  if (!state.session) {
    setStatus('Önce ReelFlow hesabına giriş yap.', 'error');
    toast('Önce ReelFlow hesabına giriş yap.', 'error');
    return;
  }
  if (button) { button.disabled = true; button.textContent = 'Güvenli bağlantı hazırlanıyor…'; }
  setStatus('Instagram bağlantı isteği gönderiliyor…', 'loading');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let result;
  try {
    result = await supabase.functions.invoke('instagram-oauth-start', {
      body: {},
      signal: controller.signal,
    });
  } catch (requestError) {
    const message = controller.signal.aborted
      ? 'Instagram bağlantı servisi 15 saniyede yanıt vermedi. İnternetini kontrol edip yeniden dene.'
      : 'Bağlantı isteği Supabase’e ulaşmadı. İnternetini kontrol et veya başka bir tarayıcıdan yeniden dene.';
    renderInstagramAccount();
    const nextStatus = document.querySelector('#instagram-connect-status');
    if (nextStatus) { nextStatus.textContent = message; nextStatus.dataset.state = 'error'; }
    toast(message, 'error');
    console.warn('Instagram OAuth başlangıç isteği başarısız:', requestError?.name || 'network error');
    return;
  } finally {
    clearTimeout(timeoutId);
  }
  const { data, error } = result || {};
  if (error || data?.error || !data?.authorization_url) {
    let message = controller.signal.aborted
      ? 'Instagram bağlantı servisi 15 saniyede yanıt vermedi. İnternetini kontrol edip yeniden dene.'
      : (data?.error || error?.message || 'Instagram bağlantısı başlatılamadı.');
    try {
      const response = error?.context;
      if (!controller.signal.aborted && !data?.error && response && typeof response.clone === 'function') {
        const detail = await response.clone().json();
        message = detail?.error || message;
      }
    } catch { /* Keep the generic safe message. */ }
    renderInstagramAccount();
    const nextStatus = document.querySelector('#instagram-connect-status');
    if (nextStatus) { nextStatus.textContent = message; nextStatus.dataset.state = 'error'; }
    toast(message, 'error');
    return;
  }
  let authorizationUrl;
  try {
    authorizationUrl = new URL(data.authorization_url);
    if (authorizationUrl.origin !== 'https://www.instagram.com') throw new Error('Unexpected authorization origin');
  } catch {
    renderInstagramAccount();
    const message = 'Güvenli Instagram giriş adresi alınamadı. Tekrar dene.';
    const nextStatus = document.querySelector('#instagram-connect-status');
    if (nextStatus) { nextStatus.textContent = message; nextStatus.dataset.state = 'error'; }
    toast(message, 'error');
    return;
  }
  try {
    setStatus('Instagram giriş ekranına yönlendiriliyorsun…', 'loading');
    window.location.assign(authorizationUrl.href);
  } catch (navigationError) {
    const message = 'Instagram giriş ekranı açılamadı. Bağlantıyı yeniden dene.';
    renderInstagramAccount();
    const nextStatus = document.querySelector('#instagram-connect-status');
    if (nextStatus) { nextStatus.textContent = message; nextStatus.dataset.state = 'error'; }
    toast(message, 'error');
    console.warn('Instagram OAuth yönlendirmesi başarısız:', navigationError?.name || 'navigation error');
  }
}

async function disconnectInstagram() {
  const button = document.querySelector('#instagram-disconnect-button');
  const accountId = state.instagram?.id;
  if (!accountId) return;
  saveReelDraft();
  if (button) { button.disabled = true; button.textContent = 'Kaldırılıyor…'; }
  const { data, error } = await supabase.functions.invoke('instagram-disconnect', { body: { account_id: accountId } });
  if (error || data?.error) {
    toast('Instagram bağlantısı kaldırılamadı. Tekrar dene.', 'error');
    renderInstagramAccount();
    return;
  }
  try { localStorage.removeItem(activeInstagramStorageKey()); } catch { /* Storage may be restricted. */ }
  await loadInstagramAccount();
  await loadQueue(true);
  toast('Seçili Instagram hesabının bağlantısı kesildi; diğer kayıtlı hesapların ve kuyruk geçmişin korundu.', 'success');
}

function consumeInstagramCallback() {
  const url = new URL(window.location.href);
  const result = url.searchParams.get('instagram');
  if (!result) return;
  if (result === 'connected') state.preferNewestInstagramAccount = true;
  url.searchParams.delete('instagram');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  const messages = {
    connected: ['Instagram hesabın bağlandı.', 'success'],
    cancelled: ['Instagram izin ekranı tamamlanmadı. Test modunda hesabın Instagram Testers listesinde ve daveti kabul edilmiş olmalı; Business/Creator hesabı kullan.', 'warn'],
    setup_required: ['Instagram bağlantısı henüz hazır değil; site yöneticisinin Meta App ayarlarını tamamlaması gerekiyor.', 'warn'],
    permissions_missing: ['İzinler eksik. Test modunda her Instagram hesabı Instagram Testers listesinde olmalı ve daveti kabul etmeli; hesap Business/Creator olmalı.', 'warn'],
    account_already_linked: ['Bu Instagram hesabı başka bir ReelFlow hesabına bağlı. Doğru ReelFlow oturumuyla giriş yapıp yeniden dene.', 'error'],
    connection_save_failed: ['Instagram doğrulandı ama hesap ReelFlow’a kaydedilemedi. Tekrar dene; sürerse yalnızca bu ekrandaki hata mesajını paylaş.', 'error'],
    state_invalid: ['Güvenli bağlantı süresi doldu. Yeniden bağlanmayı dene.', 'error'],
    token_exchange_failed: ['Meta giriş kodu doğrulanamadı. Yeniden bağlanmayı dene.', 'error'],
    long_token_failed: ['Instagram erişimi güvenli şekilde uzatılamadı.', 'error'],
    profile_lookup_failed: ['Meta hesap profilini okuyamadı. Hesabın Business/Creator olduğundan ve tester davetini kabul ettiğinden emin ol.', 'error'],
    connection_failed: ['Instagram bağlantısı tamamlanamadı.', 'error'],
  };
  const safeResult = Object.hasOwn(messages, result) ? result : 'unknown';
  const [message, type] = messages[safeResult] || ['Instagram bağlantısı tamamlanamadı.', 'error'];
  state.instagramConnectionMessage = { message, type, result: safeResult };
  const status = document.querySelector('#instagram-connect-status');
  if (status) {
    status.textContent = `${message} (kod: ${safeResult})`;
    status.dataset.state = type;
    status.dataset.result = safeResult;
  }
  toast(message, type);
  requestAnimationFrame(() => document.querySelector('#instagram-account-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

async function addToQueue(form) {
  if (state.busy) return;
  if (!state.instagram) {
    toast('Önce kendi Instagram profesyonel hesabını bağla.', 'warn');
    return;
  }
  const textarea = form.querySelector('#reel-input');
  const captionInput = form.querySelector('#caption-input');
  const sharedCaption = captionInput.value.trim();
  const rights = form.querySelector('#rights-confirm');
  const parsed = parseReelLines(textarea.value);
  if (!parsed.items.length) {
    toast(parsed.invalid.length ? parsed.invalid[0].reason : 'Önce bir Reel bağlantısı ekle.', 'error');
    return;
  }
  state.reelAccountTargets = pruneReelAccountTargets(parsed.items, state.reelAccountTargets);
  state.reelCaptionTemplateSelections = pruneReelCaptionTemplateSelections(parsed.items, state.reelCaptionTemplateSelections);
  state.reelCoverImageSelections = pruneReelCoverImageSelections(parsed.items, state.reelCoverImageSelections);
  const assignments = resolveReelTargetAssignments(parsed.items, state.reelAccountTargets, state.instagram.id);
  const connectedAccountIds = new Set(state.instagramAccounts.filter((account) => account && !account.disconnected_at).map((account) => account.id));
  const unavailableAssignment = assignments.find((assignment) => !connectedAccountIds.has(assignment.instagramAccountId));
  if (unavailableAssignment) {
    toast(`/${unavailableAssignment.shortcodeKey} hedef hesabı bağlı değil. Tekrar bağla veya başka hesap seç.`, 'error');
    renderReelTargetAssignments();
    return;
  }
  const targetByShortcode = new Map(assignments.map((assignment) => [assignment.shortcodeKey, assignment.instagramAccountId]));
  const selectedTemplateEntries = parsed.items.map((item) => [item, state.reelCaptionTemplateSelections[item.shortcodeKey] || '']);
  if (state.captionTemplatesLoading && selectedTemplateEntries.some(([, templateId]) => templateId)) {
    toast('Kayıtlı açıklama şablonları yükleniyor; birkaç saniye sonra tekrar dene.', 'warn');
    return;
  }
  const templateById = new Map(state.captionTemplates.map((template) => [template.id, template]));
  const missingTemplateEntry = selectedTemplateEntries.find(([, templateId]) => templateId && !templateById.has(templateId));
  if (missingTemplateEntry) {
    toast(`/${missingTemplateEntry[0].shortcodeKey} için seçilen açıklama şablonu bulunamadı. Başka bir şablon seç.`, 'error');
    renderReelTargetAssignments();
    return;
  }
  const captionByShortcode = new Map(parsed.items.map((item) => {
    const templateId = state.reelCaptionTemplateSelections[item.shortcodeKey];
    const template = templateId ? templateById.get(templateId) : null;
    return [item.shortcodeKey, captionForReelUrl(item.caption, sharedCaption, '', template)];
  }));
  const tooLongItem = parsed.items.find((item) => captionByShortcode.get(item.shortcodeKey).length > 2200);
  if (tooLongItem) {
    toast(`/${tooLongItem.shortcodeKey} açıklaması 2200 karakter sınırını aşıyor. Daha kısa bir şablon seç veya açıklamayı kısalt.`, 'error');
    [...document.querySelectorAll('[data-reel-caption-template]')]
      .find((select) => select.dataset.shortcodeKey === tooLongItem.shortcodeKey)?.focus();
    return;
  }
  const selectedCoverEntries = parsed.items.map((item) => [item, state.reelCoverImageSelections[item.shortcodeKey] || '']);
  if (state.uploadedVideosLoading && selectedCoverEntries.some(([, coverChoice]) => coverChoice !== NO_REEL_COVER_IMAGE)) {
    toast('Kapak kütüphanesi yükleniyor; birkaç saniye sonra tekrar dene.', 'warn');
    return;
  }
  const needsAutomaticCover = selectedCoverEntries.some(([, coverId]) => !coverId);
  if (state.videoCoverImagesError && needsAutomaticCover) {
    toast('Kapak kütüphanesi okunamadı. Yenileyip tekrar dene; seçim yapılmadan paylaşım rastgele kapaksız gönderilmesin.', 'error');
    return;
  }
  const coverIds = new Set(state.videoCoverImages.map((cover) => cover.id));
  const missingCoverEntry = selectedCoverEntries.find(([, coverId]) => coverId && coverId !== NO_REEL_COVER_IMAGE && !coverIds.has(coverId));
  if (missingCoverEntry) {
    toast(`/${missingCoverEntry[0].shortcodeKey} için seçilen kapak artık kütüphanede yok. Başka kapak seç veya seçimi kaldır.`, 'error');
    renderReelTargetAssignments();
    return;
  }
  const coverByShortcode = new Map(selectedCoverEntries.map(([item, coverChoice]) => [
    item.shortcodeKey,
    coverChoice && coverChoice !== NO_REEL_COVER_IMAGE ? coverChoice : null,
  ]));
  if (!rights.checked) {
    toast('Devam etmek için içerik paylaşma hakkını onayla.', 'error');
    rights.focus();
    return;
  }
  if (needsAutomaticCover && !state.videoCoverImages.length) {
    toast('Arşivde kayıtlı kapak bulunamadı; bu Reels videonun kendi karesiyle gönderilecek.', 'warn');
  }
  const button = form.querySelector('#add-submit');
  state.busy = true;
  button.disabled = true;
  button.innerHTML = '<span class="spinner spinner-dark"></span> Kontrol ediliyor…';
  let added = 0;
  let duplicate = parsed.duplicates;
  let failed = parsed.invalid.length;
  const invalidSample = parsed.invalid[0]?.reason;
  for (const item of parsed.items) {
    const { data, error } = await supabase.rpc('enqueue_reel_with_auto_cover', {
      p_shortcode: item.shortcode,
      p_source_url: item.url,
      p_caption: captionByShortcode.get(item.shortcodeKey),
      p_rights_confirmed: true,
      p_instagram_account_id: targetByShortcode.get(item.shortcodeKey),
      p_cover_image_id: coverByShortcode.get(item.shortcodeKey),
      p_auto_select_cover: !state.reelCoverImageSelections[item.shortcodeKey],
    });
    if (error) {
      failed++;
      console.error('Reel ekleme hatası:', error.message);
    } else if (data) {
      added++;
    } else {
      duplicate++;
    }
  }
  state.busy = false;
  button.disabled = false;
  button.innerHTML = `${icon('plus', 18)} Kuyruğa ekle <span class="button-arrow">→</span>`;
  if (failed === 0) {
    const currentForm = document.querySelector('#add-form');
    const currentUrlInput = currentForm?.querySelector('#reel-input');
    const currentRightsInput = currentForm?.querySelector('#rights-confirm');
    // Keep the caption for the next batch; clear only the successfully processed URL list.
    if (currentUrlInput) currentUrlInput.value = '';
    if (currentRightsInput) currentRightsInput.checked = false;
    state.reelAccountTargets = {};
    state.reelCaptionTemplateSelections = {};
    state.reelCoverImageSelections = {};
    saveReelDraft();
    updateInputCounter('');
    renderReelTargetAssignments();
  } else {
    saveReelDraft();
  }
  await loadQueue(true);
  const parts = [];
  if (added) parts.push(`${added} yeni Reel eklendi`);
  if (duplicate) parts.push(`${duplicate} tekrar atlandı`);
  if (failed) parts.push(`${failed} satır eklenemedi`);
  if (failed) parts.push('Taslak korundu');
  toast(parts.join(' · ') || 'Kuyruk değişmedi.', failed ? 'warn' : 'success');
  if (failed && invalidSample) toast(invalidSample, 'warn');
}

function setSectionExpanded(button, expanded) {
  const content = document.getElementById(button.dataset.sectionToggle);
  if (!content) return false;
  content.hidden = !expanded;
  button.setAttribute('aria-expanded', String(expanded));
  const label = expanded ? button.dataset.labelCollapse : button.dataset.labelExpand;
  button.setAttribute('aria-label', label);
  button.title = label;
  return true;
}

async function handleClick(event) {
  const button = event.target.closest('button, a');
  if (!button) return;
  if (button.dataset.sectionToggle) {
    setSectionExpanded(button, button.getAttribute('aria-expanded') !== 'true');
    return;
  }
  if (button.matches('.signout')) {
    await supabase.auth.signOut();
    return;
  }
  if (button.dataset.action === 'close-video-preview') {
    closeVideoPreview();
    return;
  }
  if (button.dataset.action === 'preview-uploaded-video') {
    await previewUploadedVideo(button.dataset.id);
    return;
  }
  if (button.dataset.action === 'queue-uploaded-video') {
    await queueUploadedVideo(button.dataset.id);
    return;
  }
  if (button.dataset.action === 'delete-uploaded-video') {
    await deleteUploadedVideo(button.dataset.id);
    return;
  }
  if (button.dataset.action === 'refresh-uploaded-videos') {
    await loadUploadedVideos();
    return;
  }
  if (button.dataset.importFilter) {
    state.videoImportFilter = button.dataset.importFilter;
    renderVideoImportStatuses();
    return;
  }
  if (button.dataset.action === 'retry-video-import') {
    await retryVideoImport(button.dataset.id);
    return;
  }
  if (button.dataset.action === 'refresh-storage-usage') {
    button.disabled = true;
    await loadVideoStorageUsage(false);
    button.disabled = false;
    return;
  }
  if (button.dataset.action === 'delete-video-cover') {
    await deleteVideoCover(button.dataset.id);
    return;
  }
  if (button.dataset.action === 'paste-video-import-urls') {
    try {
      appendVideoImportText(await navigator.clipboard.readText());
    } catch {
      toast('Panoya erişim izni verilmedi. URL listesini kutuya yapıştırabilirsin.', 'warn');
    }
    return;
  }
  if (button.dataset.action === 'import-url-text-file') {
    document.querySelector('#video-import-file')?.click();
    return;
  }
  if (button.id === 'instagram-disconnect-button') {
    await disconnectInstagram();
    return;
  }
  if (button.id === 'theme-button') {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem('reelflow-theme', state.theme);
    button.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon', 18);
    return;
  }
  if (button.id === 'refresh-button') {
    button.classList.add('is-spinning');
    await Promise.all([loadQueue(), loadUploadedVideos(true)]);
    setTimeout(() => button.classList.remove('is-spinning'), 500);
    return;
  }
  if (button.id === 'save-caption-template') {
    await saveCaptionTemplate();
    return;
  }
  if (button.id === 'delete-caption-template') {
    await deleteCaptionTemplate();
    return;
  }
  if (button.id === 'paste-button') {
    try {
      const text = await navigator.clipboard.readText();
      const input = document.querySelector('#reel-input');
      input.value = [input.value.trim(), text.trim()].filter(Boolean).join('\n');
      input.dispatchEvent(new Event('input'));
      toast('Panodan bağlantılar eklendi.', 'success');
    } catch {
      toast('Panoya erişim izni verilemedi. Bağlantıları kutuya yapıştır.', 'warn');
    }
    return;
  }
  if (button.id === 'install-button') {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
      state.installPrompt = null;
      button.classList.add('installed');
    } else {
      toast(/iphone|ipad|ipod/i.test(navigator.userAgent) ? 'Safari paylaş menüsünden “Ana Ekrana Ekle” seç.' : 'Tarayıcı menüsünden “Uygulamayı yükle” seçeneğini kullan.', 'info');
    }
    return;
  }
  if (button.dataset.scroll) {
    event.preventDefault();
    const target = document.getElementById(button.dataset.scroll);
    const collapsibleSection = document.getElementById(button.dataset.scroll === 'top' ? 'overview-section' : button.dataset.scroll);
    const sectionToggle = collapsibleSection?.querySelector('[data-section-toggle]');
    if (sectionToggle) setSectionExpanded(sectionToggle, true);
    if (target?.tagName === 'DETAILS') target.open = true;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    ['.nav-item', '.mobile-nav-item'].forEach((selector) => {
      const items = [...document.querySelectorAll(selector)];
      if (!items.some((node) => node.dataset.scroll === button.dataset.scroll)) return;
      items.forEach((node) => {
        const active = node.dataset.scroll === button.dataset.scroll;
        node.classList.toggle('active', active);
        if (active) node.setAttribute('aria-current', 'location');
        else node.removeAttribute('aria-current');
      });
    });
    return;
  }
  if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((node) => node.classList.toggle('active', node === button));
    renderQueue();
    return;
  }
  if (button.dataset.action === 'switch-account') {
    const selected = state.instagramAccounts.find((account) => account.id === button.dataset.accountId && !account.disconnected_at);
    if (!selected || selected.id === state.instagram?.id) return;
    saveReelDraft();
    state.instagram = selected;
    state.selectedCaptionTemplateId = '';
    saveActiveInstagramSelection(selected.id);
    restoreReelDraft();
    renderInstagramAccount();
    renderCaptionTemplates();
    renderQueue();
    renderUploadedVideos();
    toast(`Yayın hesabı @${selected.username} olarak değiştirildi.`, 'success');
    return;
  }
  if (button.dataset.action === 'assign-account') {
    if (!state.instagram) {
      toast('Önce kullanmak istediğin Instagram hesabını bağla ve seç.', 'warn');
      return;
    }
    button.disabled = true;
    button.textContent = 'Hedef değiştiriliyor…';
    const { data, error } = await supabase.rpc('assign_reel_account', {
      p_id: button.dataset.id,
      p_instagram_account_id: state.instagram.id,
    });
    if (error) toast('Reel’in hedef hesabı değiştirilemedi. Aynı Reel seçili hesapta zaten kayıtlı olabilir.', 'error');
    else if (data) toast(`Reel @${state.instagram.username} hesabına atandı.`, 'success');
    else toast('Bu Reel artık hedef hesabı değiştirilebilecek durumda değil.', 'warn');
    await loadQueue(true);
    return;
  }
  if (button.dataset.action === 'retry') {
    button.disabled = true;
    const { data, error } = await supabase.rpc('retry_failed_reel', { p_id: button.dataset.id });
    if (error) toast(`Tekrar kuyruğa alınamadı: ${error.message}`, 'error');
    else if (data) toast('Reel yeniden kuyruğa alındı.', 'success');
    await loadQueue(true);
    return;
  }
  if (button.dataset.action === 'publish-now-retrigger') {
    const row = state.rows.find((item) => item.id === button.dataset.id);
    if (!row || row.status !== 'queued' || !row.publish_now) return;
    button.disabled = true;
    button.textContent = 'Tetikleniyor…';
    const { data, error } = await supabase.functions.invoke('publish-now-trigger', { body: { reel_id: row.id } });
    if (error || data?.error) {
      toast('Worker şimdi başlatılamadı; öncelik korunuyor ve normal otomatik turda işlenecek.', 'warn');
    } else {
      toast('Bu Reel için bulut işçisi tetiklendi; aktif yayın varsa ardından başlayacak.', 'success');
    }
    await loadQueue(true);
    return;
  }
  if (button.dataset.action === 'publish-now') {
    const row = state.rows.find((item) => item.id === button.dataset.id);
    if (!row || row.status !== 'queued' || row.publish_now) return;
    button.disabled = true;
    button.textContent = 'İstek gönderiliyor…';
    const { data, error } = await supabase.rpc('request_immediate_publish', { p_id: row.id });
    if (error) toast(`Hemen paylaşım isteği kaydedilemedi: ${error.message}`, 'error');
    else if (data) {
      const { data: triggerData, error: triggerError } = await supabase.functions.invoke('publish-now-trigger', { body: { reel_id: row.id } });
      if (triggerError || triggerData?.error) {
        toast('Öncelik kaydedildi ama işçi hemen başlatılamadı; Reel otomatik turun sonraki çalışmasında işlenecek.', 'warn');
      } else {
        toast('Bulut işçisi tetiklendi; devam eden bir yayın varsa ardından çalışacak.', 'success');
      }
    } else toast('Bu Reel artık hemen paylaşım için sıraya alınamıyor. Kuyruk durumunu yeniledim.', 'warn');
    await loadQueue(true);
    return;
  }
  if (button.dataset.action === 'cancel') {
    const { data, error } = await supabase.rpc('cancel_queued_reel', { p_id: button.dataset.id });
    if (error) toast(`Kuyruktan çıkarılamadı: ${error.message}`, 'error');
    else if (data) toast('Reel kuyruktan çıkarıldı.', 'success');
    await loadQueue(true);
  }
}

root.addEventListener('click', handleClick);
root.addEventListener('submit', async (event) => {
  if (event.target.id === 'video-cover-form') {
    event.preventDefault();
    await uploadVideoCovers(event.target);
    return;
  }
  if (event.target.id === 'video-import-form') {
    event.preventDefault();
    await enqueueVideoImports(event.target);
    return;
  }
  if (event.target.id === 'login-form') {
    event.preventDefault();
    const email = event.target.querySelector('#login-email').value.trim();
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Bağlantı gönderiliyor…';
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: window.location.href },
    });
    if (error) {
      button.disabled = false;
      button.innerHTML = 'Giriş bağlantısı gönder <span>→</span>';
      const message = /signup.*not allowed|signups.*disabled/i.test(error.message)
        ? 'Kendi kendine kayıt Supabase Auth ayarlarında kapalı. Proje yöneticisi e-posta kayıtlarını açmalı.'
        : `Giriş bağlantısı gönderilemedi: ${error.message}`;
      toast(message, 'error');
    } else {
      renderLogin('Giriş bağlantısı e-posta adresine gönderildi. Gelen kutunu kontrol et.');
    }
  }
  if (event.target.id === 'add-form') {
    event.preventDefault();
    await addToQueue(event.target);
  }
});
root.addEventListener('input', (event) => {
  if (event.target.id === 'queue-search') renderQueue();
  if (event.target.id === 'video-import-urls') updateVideoImportCounter();
  if (event.target.id === 'reel-input') {
    renderReelTargetAssignments();
    saveReelDraft();
  }
  if (event.target.id === 'caption-input') saveReelDraft();
  if (event.target.matches('[data-video-caption]')) saveVideoCardDraft(event.target.closest('[data-video-card]'));
});
root.addEventListener('change', async (event) => {
  if (event.target.id === 'video-import-file') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast('TXT listesi 1 MB’tan küçük olmalı.', 'warn');
      return;
    }
    try {
      appendVideoImportText(await file.text());
    } catch {
      toast('TXT listesi okunamadı. UTF-8 metin dosyası seçip tekrar dene.', 'warn');
    }
    return;
  }
  if (event.target.matches('[data-video-account-select]')) {
    saveVideoCardDraft(event.target.closest('[data-video-card]'));
    return;
  }
  if (event.target.matches('[data-video-cover-select]')) {
    const card = event.target.closest('[data-video-card]');
    saveVideoCardDraft(card);
    renderSelectedCoverPreview(card);
    return;
  }
  if (event.target.matches('[data-video-template-select]')) {
    const card = event.target.closest('[data-video-card]');
    const template = state.captionTemplates.find((item) => item.id === event.target.value);
    if (event.target.value && !template) {
      toast('Bu açıklama şablonu artık kullanılamıyor.', 'warn');
      return;
    }
    if (template) {
      card.querySelector('[data-video-caption]').value = template.caption || '';
    }
    saveVideoCardDraft(card);
    return;
  }
  if (event.target.matches('[data-video-rights]')) {
    saveVideoCardDraft(event.target.closest('[data-video-card]'));
    return;
  }
  if (event.target.matches('[data-reel-caption-template]')) {
    const key = event.target.dataset.shortcodeKey;
    const templateId = event.target.value;
    if (templateId && !state.captionTemplates.some((template) => template.id === templateId)) {
      renderReelTargetAssignments();
      toast('Bu açıklama şablonu artık kullanılamıyor. Bu URL için başka bir şablon seç.', 'warn');
      return;
    }
    const selections = { ...state.reelCaptionTemplateSelections };
    if (templateId) selections[key] = templateId;
    else delete selections[key];
    state.reelCaptionTemplateSelections = selections;
    saveReelDraft();
    renderReelTargetAssignments();
    return;
  }
  if (event.target.matches('[data-reel-cover-select]')) {
    const key = event.target.dataset.shortcodeKey;
    const coverId = event.target.value;
    if (coverId && coverId !== NO_REEL_COVER_IMAGE && !state.videoCoverImages.some((cover) => cover.id === coverId)) {
      renderReelTargetAssignments();
      toast('Bu kapak arşivde bulunamadı. Listeyi yenileyip tekrar seç.', 'warn');
      return;
    }
    state.reelCoverImageSelections = setReelCoverImageSelection(state.reelCoverImageSelections, key, coverId);
    saveReelDraft();
    renderReelTargetAssignments();
    return;
  }
  if (event.target.matches('[data-reel-target-select]')) {
    const key = event.target.dataset.shortcodeKey;
    const accountId = event.target.value;
    if (!state.instagramAccounts.some((account) => account.id === accountId && !account.disconnected_at)) {
      renderReelTargetAssignments();
      return;
    }
    state.reelAccountTargets = setReelAccountTarget(state.reelAccountTargets, key, accountId);
    saveReelDraft();
    renderReelTargetAssignments();
    return;
  }
  if (event.target.id === 'caption-template-select') {
    const template = state.captionTemplates.find((item) => item.id === event.target.value);
    if (!template) {
      state.selectedCaptionTemplateId = '';
      const nameInput = document.querySelector('#caption-template-name');
      if (nameInput) nameInput.value = '';
      renderCaptionTemplates();
      return;
    }
    state.selectedCaptionTemplateId = template.id;
    const nameInput = document.querySelector('#caption-template-name');
    if (nameInput) nameInput.value = template.name;
    const captionInput = document.querySelector('#caption-input');
    if (captionInput) captionInput.value = template.caption;
    saveReelDraft();
    renderCaptionTemplates();
    toast(`“${template.name}” açıklaması seçildi.`, 'success');
  }
  if (event.target.id === 'instagram-account-select') {
    const selected = state.instagramAccounts.find((account) => account.id === event.target.value && !account.disconnected_at);
    if (!selected) return;
    saveReelDraft();
    state.instagram = selected;
    state.selectedCaptionTemplateId = '';
    saveActiveInstagramSelection(selected.id);
    restoreReelDraft();
    renderInstagramAccount();
    renderCaptionTemplates();
    renderQueue();
    toast(`Yeni Reels @${selected.username} hesabına kuyruğa girer. Mevcut Reels’in hedefi değişmedi.`, 'success');
  }
  if (event.target.id === 'publish-interval-select') await savePublishInterval(Number(event.target.value));
});
window.addEventListener('pagehide', saveReelDraft);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeVideoPreview(); });

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    const sameUser = state.session?.user?.id === session.user.id;
    if (!sameUser) {
      authUserGeneration += 1;
      closeVideoPreview();
      state.rows = [];
      state.uploadedVideos = [];
      state.videoImports = [];
      state.videoCoverImages = [];
      state.videoCoverImagesError = '';
      state.videoCoverUploadBusy = false;
      state.videoStorageUsage = null;
      state.videoImportBusy = false;
      state.uploadedVideoDrafts = {};
      state.uploadedVideoDraftsUserId = '';
      state.uploadedVideosLoading = false;
      state.uploadedVideosError = '';
      videoLibraryLoadGeneration++;
      videoStorageLoadGeneration++;
      state.instagram = null;
      state.instagramAccounts = [];
      state.reelAccountTargets = {};
      state.reelCaptionTemplateSelections = {};
      state.reelCoverImageSelections = {};
      state.captionTemplates = [];
      state.captionTemplatesLoading = false;
      state.captionTemplatesError = '';
      state.selectedCaptionTemplateId = '';
      captionTemplateLoadGeneration++;
    }
    state.session = session;
    if (event === 'TOKEN_REFRESHED' && sameUser) return;
    state.instagram = null;
    state.reelCaptionTemplateSelections = {};
    state.reelCoverImageSelections = {};
    state.captionTemplates = [];
    state.captionTemplatesLoading = false;
    state.captionTemplatesError = '';
    state.selectedCaptionTemplateId = '';
    captionTemplateLoadGeneration++;
    renderShell();
    loadInstagramAccount();
    loadQueue();
  } else if (!session) {
    if (state.session?.user?.id) {
      authUserGeneration += 1;
      closeVideoPreview();
    }
    state.session = null;
    state.rows = [];
    state.uploadedVideos = [];
    state.videoImports = [];
    state.videoCoverImages = [];
    state.videoCoverImagesError = '';
    state.videoCoverUploadBusy = false;
    state.videoStorageUsage = null;
    state.videoImportBusy = false;
    state.uploadedVideoDrafts = {};
    state.uploadedVideoDraftsUserId = '';
    state.uploadedVideosLoading = false;
    state.uploadedVideosError = '';
    videoLibraryLoadGeneration++;
    videoStorageLoadGeneration++;
    state.instagram = null;
    state.instagramAccounts = [];
    state.reelAccountTargets = {};
    state.reelCaptionTemplateSelections = {};
    state.reelCoverImageSelections = {};
    state.captionTemplates = [];
    state.captionTemplatesLoading = false;
    state.captionTemplatesError = '';
    state.selectedCaptionTemplateId = '';
    captionTemplateLoadGeneration++;
    renderLogin();
  }
});
(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    state.session = session;
    state.instagram = null;
    renderShell();
    await Promise.all([loadInstagramAccount(), loadQueue()]);
  } else {
    renderLogin();
  }
  if ('serviceWorker' in navigator) {
    let hadController = Boolean(navigator.serviceWorker.controller);
    let reloadingForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: 'none' }).catch((error) => console.warn('PWA çevrimdışı önbellek açılamadı:', error));
  }
})();
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  document.querySelector('#install-button')?.classList.add('install-ready');
});
window.addEventListener('online', () => document.querySelector('.connection-pill')?.classList.remove('is-offline'));
window.addEventListener('offline', () => document.querySelector('.connection-pill')?.classList.add('is-offline'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.session) {
    loadInstagramAccount();
    loadUploadedVideos(true);
  }
});
setInterval(() => {
  if (!state.session || document.hidden) return;
  if (state.videoImports.some((job) => ['queued', 'processing'].includes(job.status))) {
    if (++videoImportRefreshTicks >= 6) {
      videoImportRefreshTicks = 0;
      loadUploadedVideos(true);
    }
    videoStorageRefreshTicks = 0;
  } else {
    videoImportRefreshTicks = 0;
    if (++videoStorageRefreshTicks >= 12) {
      videoStorageRefreshTicks = 0;
      loadVideoStorageUsage(true);
    }
  }
  if (state.rows.some((row) => row.status === 'processing')) {
    idleQueueRefreshTicks = 0;
    loadQueue(true);
    return;
  }
  if (++idleQueueRefreshTicks >= 3) {
    idleQueueRefreshTicks = 0;
    loadQueue(true);
  }
}, 5000);
