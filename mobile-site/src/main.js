import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PUBLISHER_SETUP_READY } from './config.js';
import { parseReelLines } from './url-utils.js';
import './styles.css';

const root = document.querySelector('#app');
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const state = { session: null, rows: [], instagram: null, filter: 'all', theme: localStorage.getItem('reelflow-theme') || 'dark', installPrompt: null, busy: false };
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
const REEL_DRAFT_STORAGE_PREFIX = 'reelflow-draft-v1';
function reelDraftStorageKey() {
  const userId = state.session?.user?.id;
  return userId ? `${REEL_DRAFT_STORAGE_PREFIX}:${userId}` : null;
}
function saveReelDraft() {
  const key = reelDraftStorageKey();
  const urlInput = document.querySelector('#reel-input');
  const captionInput = document.querySelector('#caption-input');
  if (!key || !urlInput || !captionInput) return;
  const draft = { urls: urlInput.value, caption: captionInput.value };
  try {
    if (!draft.urls.trim() && !draft.caption.trim()) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(draft));
  } catch (error) {
    console.warn('Reel taslağı bu cihazda saklanamadı:', error);
  }
}
function clearReelDraft() {
  const key = reelDraftStorageKey();
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn('Reel taslağı bu cihazdan temizlenemedi:', error);
  }
}
function restoreReelDraft() {
  const key = reelDraftStorageKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== 'object') return;
    const urlInput = document.querySelector('#reel-input');
    const captionInput = document.querySelector('#caption-input');
    if (urlInput && typeof draft.urls === 'string') urlInput.value = draft.urls;
    if (captionInput && typeof draft.caption === 'string') captionInput.value = draft.caption.slice(0, 2200);
    updateInputCounter(urlInput?.value || '');
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
          <button class="nav-item active" data-scroll="top">${icon('grid')}<span>Genel bakış</span></button>
          <button class="nav-item" data-scroll="queue-section">${icon('reel')}<span>Reel kuyruğu</span><span id="nav-count" class="nav-count">0</span></button>
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
          <section class="hero-card enter">
            <div class="hero-copy"><div class="hero-kicker">${icon('spark', 15)} HER ŞEY TEK YERDE</div><h1>Reels akışın,<br><span>tek ekranda.</span></h1><p>Linkleri ekle, kuyruğu takip et. Daha önce eklenen Reel tekrar sıraya girmez.</p><a class="button button-light" href="#add-section">${icon('plus', 18)} Reel ekle</a></div>
            <div class="hero-orbit orbit-one"></div><div class="hero-orbit orbit-two"></div><div class="hero-sticker"><span class="sticker-play">▶</span><span>REELS<br><b>TRANSFER</b></span></div>
          </section>
          <section class="stats-grid" aria-label="Kuyruk özeti">
            <article class="stat-card stat-total"><div class="stat-top"><span>Toplam Reel</span><span class="stat-icon">${icon('reel', 18)}</span></div><strong id="stat-total">—</strong><small>Kayıtlı içerik</small></article>
            <article class="stat-card stat-queued"><div class="stat-top"><span>Kuyrukta</span><span class="stat-icon">${icon('clock', 18)}</span></div><strong id="stat-queued">—</strong><small>Sıradaki içerikler</small></article>
            <article class="stat-card stat-done"><div class="stat-top"><span>Yayınlandı</span><span class="stat-icon">${icon('check', 18)}</span></div><strong id="stat-published">—</strong><small>Tamamlananlar</small></article>
            <article class="stat-card stat-failed"><div class="stat-top"><span>Kontrol gerekli</span><span class="stat-icon">${icon('alert', 18)}</span></div><strong id="stat-failed">—</strong><small>Hata alan içerikler</small></article>
          </section>
          <section class="content-grid">
            <article class="panel add-panel" id="add-section">
              <div class="panel-heading"><div><span class="eyebrow">YENİ İÇERİK</span><h2>Kuyruğa Reel ekle</h2></div><span class="heading-icon">${icon('plus', 20)}</span></div>
              <p class="panel-copy">Her satıra bir Instagram Reel bağlantısı yaz. Ayrı açıklama alanı, bu sefer eklediğin tüm Reels'lere uygulanır.</p>
              <form id="add-form">
                <label class="sr-only" for="reel-input">Reel bağlantıları</label>
                <textarea id="reel-input" rows="5" placeholder="https://www.instagram.com/reel/ABC123/&#10;https://www.instagram.com/reel/XYZ456/"></textarea>
                <div class="input-meta"><span id="input-counter">0 bağlantı</span><button type="button" id="paste-button" class="text-button">Panodan yapıştır</button></div>
                <label for="caption-input">Paylaşım açıklaması <span class="muted">(isteğe bağlı, tüm Reels'lere uygulanır)</span></label>
                <textarea id="caption-input" rows="3" maxlength="2200" placeholder="Bu sefer eklediğin Reels'ler için açıklama yaz…"></textarea>
                <label class="rights-check"><input type="checkbox" id="rights-confirm" /><span>Bu videoları paylaşma hakkım var veya izin aldım.</span></label>
                <button class="button button-primary button-wide" type="submit" id="add-submit">${icon('plus', 18)} Kuyruğa ekle <span class="button-arrow">→</span></button>
              </form>
              <div class="privacy-note">${icon('check', 15)} URL ve açıklama taslağın bu cihazda otomatik kaydedilir; Instagram parolan burada istenmez.</div>
            </article>
            <article class="panel worker-panel" id="settings-section">
              <div class="panel-heading"><div><span class="eyebrow">YAYIN DURUMU</span><h2>Bulut bağlantıları</h2></div><span class="connection-orb ${PUBLISHER_SETUP_READY ? 'is-ready' : ''}"><i></i></span></div>
              <div class="service-row"><span class="service-logo supabase-logo">S</span><div><strong>Supabase</strong><small>Güvenli kuyruk ve oturum</small></div><span class="service-status good">Bağlı</span></div>
              <div id="instagram-account-card" class="instagram-account-card"><span class="spinner"></span> Instagram bağlantısı kontrol ediliyor…</div>
              <div class="service-row"><span class="service-logo github-logo">GH</span><div><strong>GitHub Actions</strong><small>Bilgisayar kapalıyken işlem</small></div><span class="service-status ${PUBLISHER_SETUP_READY ? 'good' : 'pending'}">${PUBLISHER_SETUP_READY ? 'Hazır' : 'Kurulum gerekli'}</span></div>
              <div class="worker-note ${PUBLISHER_SETUP_READY ? 'note-ready' : ''}"><span class="note-icon">${PUBLISHER_SETUP_READY ? '✓' : 'i'}</span><p>${PUBLISHER_SETUP_READY ? 'Kuyruktaki içerikler bulut işçisi tarafından sırayla işleniyor.' : 'Arayüz ve kuyruk hazır. Otomatik yayın için GitHub Actions sırları ve Instagram API ayarları henüz bağlanmadı.'}</p></div>
              <div class="worker-interval">${icon('clock', 16)} <span>Kuyrukta tarih/saat ayarı yok — eklenenler sırayla işlenir.</span></div>
            </article>
          </section>
          <section class="panel queue-panel" id="queue-section">
            <div class="queue-heading"><div><span class="eyebrow">İÇERİK MERKEZİ</span><h2>Reel kuyruğu <span id="queue-count" class="queue-count">0</span></h2></div><div class="queue-tools"><div class="search-wrap">${icon('search', 17)}<input type="search" id="queue-search" placeholder="Kuyrukta ara" aria-label="Kuyrukta ara" /></div><button class="icon-button refresh-button" id="refresh-button" title="Yenile" aria-label="Kuyruğu yenile">${icon('refresh', 17)}</button></div></div>
            <div class="filter-row" role="tablist" aria-label="Kuyruk filtresi"><button class="filter-chip active" data-filter="all">Tümü</button><button class="filter-chip" data-filter="queued">Kuyrukta</button><button class="filter-chip" data-filter="processing">Yayınlanıyor</button><button class="filter-chip" data-filter="published">Yayınlandı</button><button class="filter-chip" data-filter="failed">Hata</button></div>
            <div id="queue-list" class="queue-list"><div class="loading-row"><span class="spinner"></span> Kuyruk yükleniyor…</div></div>
            <div id="queue-footer" class="queue-footer"></div>
          </section>
          <footer class="app-footer"><span>ReelFlow <span class="footer-dot">•</span> Mobil uyumlu web uygulaması</span><span>Instagram API üzerinden, iznin olan içerikler için</span></footer>
        </main>
        <nav class="mobile-nav" aria-label="Alt menü"><button class="mobile-nav-item active" data-scroll="top">${icon('grid', 20)}<span>Genel</span></button><button class="mobile-nav-item" data-scroll="queue-section">${icon('reel', 20)}<span>Kuyruk</span></button><button class="mobile-nav-item" data-scroll="add-section">${icon('plus', 20)}<span>Ekle</span></button><button class="mobile-nav-item" data-scroll="settings-section">${icon('settings', 20)}<span>Durum</span></button></nav>
      </div>
    </div>
    <div id="toast-host" class="toast-host" aria-live="polite"></div>`;
  restoreReelDraft();
  updateStats();
  renderQueue();
  renderInstagramAccount();
  consumeInstagramCallback();
  const input = document.querySelector('#reel-input');
  input?.addEventListener('input', () => updateInputCounter(input.value));
}

function updateInputCounter(value) {
  const lines = value.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).length;
  const target = document.querySelector('#input-counter');
  if (target) target.textContent = `${lines} bağlantı`;
}
function updateStats() {
  const counts = { total: state.rows.length, queued: 0, published: 0, failed: 0 };
  for (const row of state.rows) {
    if (row.status === 'queued') counts.queued++;
    if (row.status === 'published') counts.published++;
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
}
function renderQueue() {
  const list = document.querySelector('#queue-list');
  if (!list) return;
  const query = (document.querySelector('#queue-search')?.value || '').trim().toLowerCase();
  const filtered = state.rows.filter((row) => {
    const filterMatch = state.filter === 'all' || row.status === state.filter;
    const queryMatch = !query || `${row.shortcode} ${row.source_url} ${row.caption}`.toLowerCase().includes(query);
    return filterMatch && queryMatch;
  });
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-art">${icon('reel', 28)}</div><strong>${state.rows.length ? 'Bu filtrede içerik yok' : 'Kuyruk henüz boş'}</strong><p>${state.rows.length ? 'Başka bir durum filtresi seçebilirsin.' : 'İlk Reel bağlantını ekle; burada durumunu takip edersin.'}</p>${state.rows.length ? '' : '<a class="text-button" href="#add-section">Reel ekle →</a>'}</div>`;
  } else {
    list.innerHTML = filtered.map((row, index) => {
      const [label, statusClass] = row.status === 'queued' && row.publish_now
        ? ['Hemen paylaşılacak', 'queued']
        : statusMeta(row.status);
      const progress = Math.max(0, Math.min(100, Number(row.progress || 0)));
      const safeUrl = escapeHtml(row.source_url);
      const actions = row.status === 'failed'
        ? `<button class="mini-button" data-action="retry" data-id="${escapeHtml(row.id)}">Tekrar dene</button>`
        : row.status === 'queued'
          ? `${row.publish_now ? '' : `<button class="mini-button mini-now" title="Bu Reel için yayın aralığını atla" data-action="publish-now" data-id="${escapeHtml(row.id)}">Hemen paylaş</button>`}<button class="mini-button mini-danger" data-action="cancel" data-id="${escapeHtml(row.id)}">Kaldır</button>`
          : '';
      const bar = row.status === 'processing' ? `<div class="progress-line"><span style="width:${progress}%"></span></div>` : '';
      const progressText = row.status === 'processing' ? `<small class="progress-caption">${escapeHtml(row.stage || 'İşleniyor')} · %${progress}</small>` : '';
      const error = row.status === 'failed' && row.error_message ? `<p class="error-note">${escapeHtml(row.error_message)}</p>` : '';
      return `<article class="reel-row enter" style="--row-index:${Math.min(index, 8)}"><div class="reel-thumb thumb-${index % 4}"><span class="thumb-play">▶</span><span class="thumb-label">REEL</span></div><div class="reel-details"><div class="reel-title-line"><strong>/${escapeHtml(row.shortcode)}</strong><span class="status-pill status-${statusClass}"><i></i>${label}</span></div><p class="reel-caption">${escapeHtml(row.caption || 'Açıklama eklenmedi')}</p><div class="reel-meta"><span>${icon('clock', 13)} ${fmtDate(row.created_at)}</span><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">Kaynağı gör ${icon('external', 13)}</a></div>${bar}${progressText}${error}</div><div class="reel-actions">${actions}</div></article>`;
    }).join('');
  }
  const footer = document.querySelector('#queue-footer');
  if (footer) footer.textContent = state.rows.length ? `En yeni ${Math.min(state.rows.length, 200)} kayıt gösteriliyor · sayfa açıkken durum otomatik yenilenir` : '';
  updateStats();
}

async function loadQueue(silent = false) {
  if (!state.session) return;
  const { data, error } = await supabase.from('reels_queue')
    .select('id,shortcode,shortcode_key,source_url,caption,status,progress,stage,error_message,publish_now,created_at,updated_at')
    .eq('user_id', state.session.user.id).order('created_at', { ascending: false }).limit(200);
  if (error) {
    if (!silent) toast(`Kuyruk yüklenemedi: ${error.message}`, 'error');
    return;
  }
  state.rows = data || [];
  renderQueue();
}

async function loadInstagramAccount() {
  if (!state.session) return;
  const { data, error } = await supabase.from('instagram_accounts')
    .select('instagram_user_id,username,token_expires_at,connected_at,publish_interval_minutes,last_published_at')
    .eq('user_id', state.session.user.id).maybeSingle();
  if (error) {
    state.instagram = null;
    renderInstagramAccount();
    toast('Instagram bağlantı durumu alınamadı. Sayfayı yenileyip tekrar dene.', 'error');
    return;
  }
  state.instagram = data || null;
  renderInstagramAccount();
}

function renderInstagramAccount() {
  const card = document.querySelector('#instagram-account-card');
  if (!card) return;
  if (state.instagram) {
    const intervals = [[60, '1 saat'], [180, '3 saat'], [360, '6 saat'], [720, '12 saat'], [1440, '1 gün'], [2880, '2 gün']];
    const selectedInterval = Number(state.instagram.publish_interval_minutes || 360);
    const options = intervals.map(([minutes, label]) => `<option value="${minutes}" ${selectedInterval === minutes ? 'selected' : ''}>${label}</option>`).join('');
    card.innerHTML = `<div class="instagram-account-top"><div class="instagram-account-copy"><span class="ig-connected-mark">✓</span><div><strong>@${escapeHtml(state.instagram.username)}</strong><small>Instagram profesyonel hesabı bağlı · token bitişi ${fmtDate(state.instagram.token_expires_at)}</small></div></div><button id="instagram-disconnect-button" class="mini-button mini-danger">Bağlantıyı kes</button></div><label class="ig-interval-row" for="publish-interval-select"><span><strong>Reels arasındaki süre</strong><small>Normal kuyruk bu aralığa uyar; “Hemen paylaş” tek Reel için beklemeyi atlar.</small></span><select id="publish-interval-select" class="ig-interval-select" aria-label="Reels arasındaki süre">${options}</select></label>`;
  } else {
    card.innerHTML = `<div class="instagram-account-copy"><span class="ig-pending-mark">IG</span><div><strong>Instagram hesabını bağla</strong><small>Business veya Creator hesabı gerekir; kişisel hesap desteklenmez.</small></div></div><button id="instagram-connect-button" class="button button-primary ig-connect-button">${icon('reel', 16)} Hesabımı bağla</button>`;
  }
  const addButton = document.querySelector('#add-submit');
  if (addButton) addButton.disabled = !state.instagram;
}

async function savePublishInterval(minutes) {
  const allowed = [60, 180, 360, 720, 1440, 2880];
  if (!state.session || !allowed.includes(minutes)) return;
  const select = document.querySelector('#publish-interval-select');
  if (select) select.disabled = true;
  const { data, error } = await supabase.from('instagram_accounts')
    .update({ publish_interval_minutes: minutes })
    .eq('user_id', state.session.user.id)
    .select('publish_interval_minutes').maybeSingle();
  if (error || !data) {
    toast('Yayın aralığı kaydedilemedi. Tekrar dene.', 'error');
    await loadInstagramAccount();
    return;
  }
  state.instagram = { ...state.instagram, publish_interval_minutes: data.publish_interval_minutes };
  renderInstagramAccount();
  const label = { 60: '1 saat', 180: '3 saat', 360: '6 saat', 720: '12 saat', 1440: '1 gün', 2880: '2 gün' }[minutes];
  toast(`Reels aralığı ${label} olarak kaydedildi.`, 'success');
}

async function connectInstagram() {
  const button = document.querySelector('#instagram-connect-button');
  if (button) { button.disabled = true; button.textContent = 'Güvenli bağlantı açılıyor…'; }
  let authWindow = null;
  try {
    authWindow = window.open('about:blank', '_blank');
    if (authWindow) {
      authWindow.opener = null;
      authWindow.document.body.textContent = 'Güvenli Instagram giriş ekranı hazırlanıyor…';
    }
  } catch { authWindow = null; }
  const { data, error } = await supabase.functions.invoke('instagram-oauth-start', { body: {} });
  if (error || data?.error || !data?.authorization_url) {
    let message = data?.error || error?.message || 'Instagram bağlantısı başlatılamadı.';
    try {
      const response = error?.context;
      if (!data?.error && response && typeof response.clone === 'function') {
        const detail = await response.clone().json();
        message = detail?.error || message;
      }
    } catch { /* Keep the generic safe message. */ }
    try { if (authWindow && !authWindow.closed) authWindow.close(); } catch { /* Ignore a closed popup. */ }
    toast(message, 'error');
    renderInstagramAccount();
    return;
  }
  let authorizationUrl;
  try {
    authorizationUrl = new URL(data.authorization_url);
    if (authorizationUrl.origin !== 'https://www.instagram.com') throw new Error('Unexpected authorization origin');
  } catch {
    try { if (authWindow && !authWindow.closed) authWindow.close(); } catch { /* Ignore a closed popup. */ }
    toast('Güvenli Instagram giriş adresi alınamadı. Tekrar dene.', 'error');
    renderInstagramAccount();
    return;
  }
  const fallbackLink = document.createElement('a');
  fallbackLink.href = authorizationUrl.href;
  fallbackLink.target = '_blank';
  fallbackLink.rel = 'noopener noreferrer';
  fallbackLink.className = 'text-button oauth-fallback';
  fallbackLink.textContent = 'Giriş ekranı açılmadıysa Instagram’ı buradan aç';
  fallbackLink.hidden = true;
  document.querySelector('#instagram-account-card')?.append(fallbackLink);
  try {
    if (authWindow && !authWindow.closed) {
      authWindow.location.replace(authorizationUrl.href);
      authWindow.focus();
    } else {
      window.location.assign(authorizationUrl.href);
    }
  } catch {
    window.location.assign(authorizationUrl.href);
  }
  setTimeout(() => {
    if (document.visibilityState !== 'visible' || !button?.isConnected) return;
    button.disabled = false;
    button.innerHTML = `${icon('reel', 16)} Hesabımı bağla`;
    fallbackLink.hidden = false;
    toast('Giriş ekranı açılmadıysa alttaki bağlantıya dokun.', 'warn');
  }, 1800);
}

async function disconnectInstagram() {
  const button = document.querySelector('#instagram-disconnect-button');
  if (button) { button.disabled = true; button.textContent = 'Kaldırılıyor…'; }
  const { data, error } = await supabase.functions.invoke('instagram-disconnect', { body: {} });
  if (error || data?.error) {
    toast('Instagram bağlantısı kaldırılamadı. Tekrar dene.', 'error');
    renderInstagramAccount();
    return;
  }
  state.instagram = null;
  renderInstagramAccount();
  toast('Instagram hesabının bağlantısı kesildi.', 'success');
}

function consumeInstagramCallback() {
  const url = new URL(window.location.href);
  const result = url.searchParams.get('instagram');
  if (!result) return;
  url.searchParams.delete('instagram');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  const messages = {
    connected: ['Instagram hesabın bağlandı.', 'success'],
    cancelled: ['Instagram bağlantısını iptal ettin.', 'info'],
    setup_required: ['Instagram bağlantısı henüz hazır değil; site yöneticisinin Meta App ayarlarını tamamlaması gerekiyor.', 'warn'],
    permissions_missing: ['Yayın için gerekli Instagram izinleri verilmedi.', 'warn'],
    account_already_linked: ['Bu Instagram hesabı başka bir ReelFlow hesabına bağlı veya bağlantı kaydedilemedi.', 'error'],
    state_invalid: ['Güvenli bağlantı süresi doldu. Yeniden bağlanmayı dene.', 'error'],
    token_exchange_failed: ['Meta giriş kodu doğrulanamadı. Yeniden bağlanmayı dene.', 'error'],
    long_token_failed: ['Instagram erişimi güvenli şekilde uzatılamadı.', 'error'],
    profile_lookup_failed: ['Instagram profesyonel hesap bilgisi alınamadı.', 'error'],
    connection_failed: ['Instagram bağlantısı tamamlanamadı.', 'error'],
  };
  const [message, type] = messages[result] || ['Instagram bağlantısı tamamlanamadı.', 'error'];
  toast(message, type);
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
  if (!rights.checked) {
    toast('Devam etmek için içerik paylaşma hakkını onayla.', 'error');
    rights.focus();
    return;
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
    const { data, error } = await supabase.rpc('enqueue_reel', {
      p_shortcode: item.shortcode,
      p_source_url: item.url,
      p_caption: sharedCaption || item.caption,
      p_rights_confirmed: true,
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
    const currentCaptionInput = currentForm?.querySelector('#caption-input');
    const currentRightsInput = currentForm?.querySelector('#rights-confirm');
    if (currentUrlInput) currentUrlInput.value = '';
    if (currentCaptionInput) currentCaptionInput.value = '';
    if (currentRightsInput) currentRightsInput.checked = false;
    clearReelDraft();
    updateInputCounter('');
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

async function handleClick(event) {
  const button = event.target.closest('button, a');
  if (!button) return;
  if (button.matches('.signout')) {
    await supabase.auth.signOut();
    return;
  }
  if (button.id === 'instagram-connect-button') {
    await connectInstagram();
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
    await loadQueue();
    setTimeout(() => button.classList.remove('is-spinning'), 500);
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
    document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.mobile-nav-item,.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.scroll === button.dataset.scroll));
    return;
  }
  if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((node) => node.classList.toggle('active', node === button));
    renderQueue();
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
  if (button.dataset.action === 'publish-now') {
    const row = state.rows.find((item) => item.id === button.dataset.id);
    if (!row || row.status !== 'queued' || row.publish_now) return;
    const caption = String(row.caption || '').trim();
    const captionPreview = caption
      ? `\n\nAçıklama:\n${caption}`
      : '\n\nAçıklama: yok.';
    const confirmed = window.confirm(
      `/${row.shortcode} Reel'ini bağlı Instagram hesabında hemen paylaşım önceliğine almak istiyor musun?\n\nKaynak: ${row.source_url}${captionPreview}\n\nBu Reel için seçili yayın aralığı beklenmeden atlanır. Bulut işçisi 5 dakikada bir kontrol eder; istek bir sonraki uygun turda işlenir. Reel yayınlandıktan sonra normal aralık yeniden başlar.`
    );
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = 'İstek gönderiliyor…';
    const { data, error } = await supabase.rpc('request_immediate_publish', { p_id: row.id });
    if (error) toast(`Hemen paylaşım isteği kaydedilemedi: ${error.message}`, 'error');
    else if (data) toast('Hemen paylaşım isteği sıraya alındı; normal aralık bu Reel için atlanacak.', 'success');
    else toast('Bu Reel artık hemen paylaşım için sıraya alınamıyor. Kuyruk durumunu yeniledim.', 'warn');
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
  if (event.target.id === 'reel-input' || event.target.id === 'caption-input') saveReelDraft();
});
root.addEventListener('change', async (event) => {
  if (event.target.id === 'publish-interval-select') await savePublishInterval(Number(event.target.value));
});
window.addEventListener('pagehide', saveReelDraft);

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    const sameUser = state.session?.user?.id === session.user.id;
    state.session = session;
    if (event === 'TOKEN_REFRESHED' && sameUser) return;
    state.instagram = null;
    renderShell();
    loadInstagramAccount();
    loadQueue();
  } else if (!session) {
    state.session = null;
    state.rows = [];
    state.instagram = null;
    renderLogin();
  }
});
(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    state.session = session;
    state.instagram = null;
    renderShell();
    await loadInstagramAccount();
    await loadQueue();
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
  if (!document.hidden && state.session) loadInstagramAccount();
});
setInterval(() => { if (state.session && !document.hidden) loadQueue(true); }, 15000);
