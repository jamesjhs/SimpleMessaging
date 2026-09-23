'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let currentUser    = null;   // display name of logged-in user
let currentRole    = null;   // 'admin' | 'adult' | 'user'
let appConfig      = {
  enableViewOnce: true,
  enableBlur: true,
};     // server-supplied config
let enterToSend    = false;
let pushPreferenceEnabled = false;
let appInitialized = false;
let refreshTimer   = null;
let isTyping       = false;
let typingTimeout  = null;
let lastPostId     = null;
let replyingTo     = null;   // { user, text, id }
let isPageVisible  = true;
let unreadCount    = 0;
let originalTitle  = document.title;
let reportingMessageId = null;

function isObserverRole(role = currentRole) {
  return role === 'admin' || role === 'adult';
}

function isAdultObserver() {
  return currentRole === 'adult';
}

function applyDocumentTitle() {
  const appName = getConfiguredAppName();
  originalTitle = isAdultObserver() ? `${appName} View Only` : appName;
  document.title = unreadCount > 0 ? `(${unreadCount}) ${originalTitle}` : originalTitle;
}

function applyRoleUi() {
  const postForm = document.getElementById('postForm');
  const enterToSendRow = document.getElementById('enter-to-send-row');
  const adultFooter = document.getElementById('adult-view-footer');
  if (postForm) postForm.style.display = isAdultObserver() ? 'none' : 'flex';
  if (enterToSendRow) enterToSendRow.style.display = isAdultObserver() ? 'none' : 'flex';
  if (adultFooter) adultFooter.style.display = isAdultObserver() ? 'flex' : 'none';
  document.body.classList.toggle('read-only-chat', isAdultObserver());
  if (isAdultObserver()) {
    cancelReply();
    clearPreview();
    enterToSend = false;
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = null;
    isTyping = false;
  }
  applyDocumentTitle();
}

// Pending upload bubbles: pendingId -> { bubbleEl, formData, xhr, cancelled }
const pendingMessages = new Map();
let activePendingId   = null;
let restoredDraftFile = null;
let isRestoringDraft  = false;
let draftSaveTimer    = null;
let currentDraftId    = null;
const submittedDraftIds = new Set();

const DRAFT_DB_NAME      = 'tls-message-drafts';
const DRAFT_DB_VERSION   = 1;
const DRAFT_STORE_NAME   = 'drafts';
const CURRENT_DRAFT_KEY  = 'current';
const DRAFT_MAX_AGE_MS   = 24 * 60 * 60 * 1000;

// OTP / login state
let otpTempToken          = null;
let loginCooldownTimer    = null;
let loginTurnstileWidgetId = null;  // Turnstile widget ID — null when inactive
let loginTurnstileTokenIssuedAt = 0;
let deferredInstallPrompt = null;

// Reaction picker state
let reactionPickerTarget     = null; // .post element currently targeted
let reactionPickerOpenedAt   = 0;    // timestamp to suppress immediate dismiss
let suppressPickerDismiss    = false;

// Long-press detection state (shared between touch and mouse)
let lpTimer   = null;
let lpTarget  = null;
let lpStartX  = 0;
let lpStartY  = 0;
let lpMoved   = false;

// ── Colour schemes ───────────────────────────────────────────────────────────
const COLOUR_SCHEMES = {
  default: { name: 'Default', bg: '#2c2c2c', mine: '#206123', theirs: '#215e6d', surface: '#444' },
  ocean:   { name: 'Ocean',   bg: '#1a2a3a', mine: '#1a4f6e', theirs: '#0d4d4d', surface: '#2a3a4a' },
  purple:  { name: 'Purple',  bg: '#1e1a2e', mine: '#533483', theirs: '#0f3460', surface: '#2e2a3e' },
  warm:    { name: 'Warm',    bg: '#2a1f0a', mine: '#7c4500', theirs: '#5c3d02', surface: '#3a2f1a' },
  forest:  { name: 'Forest',  bg: '#0d1f0d', mine: '#1b5e20', theirs: '#003d33', surface: '#1a2a1a' },
  midnight:{ name: 'Midnight',bg: '#101820', mine: '#2364aa', theirs: '#3d5a80', surface: '#1f2a36' },
  rose:    { name: 'Rose',    bg: '#26161d', mine: '#a23e48', theirs: '#6d597a', surface: '#3a222c' },
  sage:    { name: 'Sage',    bg: '#18221b', mine: '#4f772d', theirs: '#31572c', surface: '#263528' },
  steel:   { name: 'Steel',   bg: '#20252b', mine: '#3a6ea5', theirs: '#546a7b', surface: '#303841' },
  sunset:  { name: 'Sunset',  bg: '#241b22', mine: '#c44536', theirs: '#5e548e', surface: '#352733' },
};

const FONT_OPTIONS = {
  system: {
    name: 'Default Sans',
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  serif: {
    name: 'Serif',
    stack: 'Georgia, "Times New Roman", serif',
  },
  friendly: {
    name: 'Friendly',
    stack: '"Comic Sans MS", "Comic Sans", "Trebuchet MS", cursive, sans-serif',
  },
};

function getAvailableColourSchemeIds() {
  const ids = Array.isArray(appConfig.availableColourSchemes)
    ? appConfig.availableColourSchemes
    : Object.keys(COLOUR_SCHEMES);
  const filtered = ids.filter(id => COLOUR_SCHEMES[id]);
  return filtered.length > 0 ? filtered : ['default'];
}

function renderColourSchemeButtons() {
  const container = document.getElementById('colour-scheme-list');
  if (!container) return;

  container.innerHTML = '';
  getAvailableColourSchemeIds().forEach(id => {
    const scheme = COLOUR_SCHEMES[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'colour-scheme-btn';
    btn.dataset.scheme = id;
    btn.onclick = () => applyColourScheme(id);
    btn.innerHTML = `
      <div class="colour-swatch">
        <span style="background:${scheme.bg}"></span>
        <span style="background:${scheme.mine}"></span>
        <span style="background:${scheme.theirs}"></span>
      </div>${scheme.name}
    `;
    container.appendChild(btn);
  });
}

function getAvailableFontOptionIds() {
  const ids = Array.isArray(appConfig.fontOptions) ? appConfig.fontOptions : Object.keys(FONT_OPTIONS);
  const filtered = ids.filter(id => FONT_OPTIONS[id]);
  return filtered.length > 0 ? filtered : ['system'];
}

function renderFontFamilyButtons() {
  const container = document.getElementById('font-family-list');
  if (!container) return;

  container.innerHTML = '';
  getAvailableFontOptionIds().forEach(id => {
    const option = FONT_OPTIONS[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `font-family-btn font-preview-${id}`;
    btn.dataset.fontFamily = id;
    btn.onclick = () => applyFontFamily(id);
    btn.innerHTML = `<span>${option.name}</span><span>Aa</span>`;
    container.appendChild(btn);
  });
}

function getConfiguredAppName() {
  return (appConfig.siteTitle || 'Messaging').trim() || 'Messaging';
}

function applyAppConfigChrome() {
  const appName = getConfiguredAppName();
  applyDocumentTitle();

  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = (appConfig.mainHeader || appName).trim() || appName;

  const settingsVersion = document.getElementById('settings-version');
  if (settingsVersion && appConfig.appVersion) settingsVersion.textContent = `Version ${appConfig.appVersion}`;
  const adultFooterVersion = document.getElementById('adult-footer-version');
  if (adultFooterVersion && appConfig.appVersion) adultFooterVersion.textContent = `Version ${appConfig.appVersion}`;

  if (appConfig.chatIconUrl) {
    const headerLogo = document.getElementById('header-logo');
    if (headerLogo) headerLogo.src = appConfig.chatIconUrl;
    const loginLogo  = document.getElementById('login-logo');
    if (loginLogo)  loginLogo.src  = appConfig.chatIconUrl;
  }
}

// ── DOM element cache ────────────────────────────────────────────────────────
const textInput       = document.getElementById('text');
const sendBtn         = document.querySelector('.post-btn');
const imageInput      = document.getElementById('imageInput');
const cameraInput     = document.getElementById('cameraInput');
const videoInput      = document.getElementById('videoInput');
const jumpBtn         = document.getElementById('jumpToBottom');
const prompt          = document.getElementById('new-message-prompt');
const indicator       = document.getElementById('typing-indicator');
const overlay         = document.getElementById('imageOverlay');
const overlayImg      = document.getElementById('overlayImg');
const replyContainer  = document.getElementById('reply-preview-container');
const previewImg      = document.getElementById('preview-img');
const previewVideoText= document.getElementById('preview-video-text');
const previewAudio    = document.getElementById('preview-audio');
const previewContainer= document.getElementById('preview-container');
const postsContainer  = document.getElementById('posts');

const VIDEO_UPLOAD_TARGET = {
  width: 600,
  height: 800,
  fps: 24,
  videoBitrate: '1000k',
  audioBitrate: '128k',
};
const AUDIO_UPLOAD_TARGET = {
  format: 'wav',
  bitrate: '48k',
  sampleRate: '48000',
};
const VIDEO_RECORDING_TARGET = {
  width: 600,
  height: 800,
  fps: 24,
  videoBitsPerSecond: 1000000,
  audioBitsPerSecond: 128000,
};
const AUDIO_RECORDING_TARGET = {
  sampleRate: 48000,
  maxSeconds: 5 * 60,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};
const VIDEO_FILE_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|3gpp)$/i;
const AUDIO_FILE_EXT_RE = /\.(weba|ogg|mp3|m4a|aac|wav)$/i;
const FFMPEG_VENDOR_BASE_URL = '/vendor/ffmpeg';
const AUDIO_RECORDING_MIN_BYTES_PER_SECOND = 8000;
const AUDIO_LEVEL_ACTIVE_RMS = 0.003;
const AUDIO_LEVEL_WARNING_DELAY_MS = 2000;
const AUDIO_LEVEL_HISTORY_SIZE = 90;
// Diagnostic baseline: mirror the working video recorder's default audio capture.
const AUDIO_RECORDING_FORCE_WEB_AUDIO = false;
const AUDIO_RECORDING_USE_BROWSER_DEFAULTS = true;
const AUDIO_RECORDING_FORCE_SCRIPT_PROCESSOR = false;

// ── API helper ───────────────────────────────────────────────────────────────
function apiFetch(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options });
}

async function fetchFileBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof File || source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  const res = await fetch(source, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not fetch ${source}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function toLocalBlobURL(url, mimeType) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${url}: HTTP ${res.status}`);
  const blob = new Blob([await res.arrayBuffer()], { type: mimeType });
  return URL.createObjectURL(blob);
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing?.dataset.loaded === 'true') { resolve(); return; }
    if (existing) existing.remove();

    const script = document.createElement('script');
    script.src = url;
    script.async = false;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Could not load script ${url}`));
    document.head.appendChild(script);
  });
}

function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updatePwaInstallUi(message = '') {
  const installRow = document.getElementById('pwa-install-row');
  const installBtn = document.getElementById('install-pwa-btn');
  const installMsg = document.getElementById('install-pwa-msg');
  if (!installRow || !installBtn || !installMsg) return;

  if (!appConfig.pwaEnabled || !('serviceWorker' in navigator)) {
    installRow.style.display = 'none';
    installMsg.textContent = '';
    return;
  }

  installRow.style.display = 'block';

  if (isStandalonePwa()) {
    installBtn.disabled = true;
    installBtn.textContent = '✓ App Installed';
    installMsg.textContent = message || 'This device already has the PWA installed.';
    return;
  }

  installBtn.disabled = !deferredInstallPrompt;
  installBtn.textContent = '📲 Install App';
  installMsg.textContent = message || (
    deferredInstallPrompt
      ? 'Install the PWA on this device before enabling push notifications.'
      : 'Use your browser install/share menu to add this app to the home screen.'
  );
}

// ── Auth / Login ─────────────────────────────────────────────────────────────
function showLoginOverlay() {
  document.getElementById('login-overlay').style.display = 'flex';
  showLoginStep('credentials');
  document.getElementById('login-password').value = '';
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  errorEl.style.color = '';
  document.getElementById('login-username').focus();
  if (loginCooldownTimer) {
    clearInterval(loginCooldownTimer);
    loginCooldownTimer = null;
  }
  const btn = document.getElementById('login-btn');
  if (appConfig.turnstileSiteKey) {
    resetTurnstileChallenge();
  } else if (btn) {
    btn.disabled = false;
  }
}

function hideLoginOverlay() {
  document.getElementById('login-overlay').style.display = 'none';
}

function showLoginStep(step) {
  ['credentials', 'otp', 'change-password'].forEach(s => {
    document.getElementById(`login-step-${s}`).style.display = s === step ? 'block' : 'none';
  });
}

function startLoginCooldown(seconds, errorEl) {
  if (loginCooldownTimer) clearInterval(loginCooldownTimer);
  const btn = document.getElementById('login-btn');
  if (btn) btn.disabled = true;
  let remaining = seconds;
  const update = () => {
    errorEl.textContent = `⏳ Too many failed attempts. Please wait ${remaining} second${remaining !== 1 ? 's' : ''} before trying again.`;
    errorEl.style.color = '#ffcc00';
  };
  update();
  loginCooldownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(loginCooldownTimer);
      loginCooldownTimer = null;
      // Re-enable only when no Turnstile is active; if it is, the widget
      // callback will re-enable the button once the user solves the challenge.
      if (btn) btn.disabled = (loginTurnstileWidgetId != null);
      errorEl.textContent = 'You may try again now.';
      errorEl.style.color = '#4caf50';
    } else {
      update();
    }
  }, 1000);
}

// Load Cloudflare Turnstile widget after config is available.
// Injects the Turnstile script once, then polls until window.turnstile is
// ready (handles the async/defer load and cached-script edge cases).
// Follows the pattern used in jamesjhs/Tasker (renderTurnstileWidget).
function loadTurnstile(siteKey) {
  if (!siteKey) return;
  const container = document.getElementById('turnstile-container');
  const btn = document.getElementById('login-btn');

  if (loginTurnstileWidgetId != null && window.turnstile) {
    try { window.turnstile.reset(loginTurnstileWidgetId); } catch { /* ignore stale widget */ }
    if (btn) btn.disabled = !getTurnstileToken();
    return;
  }

  // Inject the script only once
  if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
    const script = document.createElement('script');
    script.src   = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }
  // Disable the Sign In button until the widget is solved
  if (btn) btn.disabled = true;
  let attempts = 0;
  const tryRender = () => {
    if (!container) return;
    if (window.turnstile) {
      container.innerHTML = '';
      loginTurnstileTokenIssuedAt = 0;
      loginTurnstileWidgetId = window.turnstile.render(container, {
        sitekey:            siteKey,
        theme:              'dark',
        callback:           () => {
          loginTurnstileTokenIssuedAt = Date.now();
          if (btn) btn.disabled = false;
        },
        'expired-callback': () => {
          loginTurnstileTokenIssuedAt = 0;
          if (btn) btn.disabled = true;
        },
        'error-callback':   () => {
          loginTurnstileTokenIssuedAt = 0;
          if (btn) btn.disabled = true;
        },
      });
    } else if (attempts < 30) {
      attempts++;
      setTimeout(tryRender, 100);
    }
  };
  tryRender();
}

function getTurnstileToken() {
  if (!window.turnstile || loginTurnstileWidgetId == null) return null;
  return window.turnstile.getResponse(loginTurnstileWidgetId) || null;
}

function resetTurnstileChallenge() {
  const btn = document.getElementById('login-btn');
  loginTurnstileTokenIssuedAt = 0;
  if (btn) btn.disabled = true;

  if (!appConfig.turnstileSiteKey) {
    if (btn) btn.disabled = false;
    return;
  }

  if (window.turnstile && loginTurnstileWidgetId != null) {
    try {
      window.turnstile.reset(loginTurnstileWidgetId);
    } catch {
      loginTurnstileWidgetId = null;
      loadTurnstile(appConfig.turnstileSiteKey);
    }
    return;
  }

  loadTurnstile(appConfig.turnstileSiteKey);
}

async function attemptLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl  = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  if (!username || !password) {
    errorEl.textContent = 'Please enter your username and password.';
    return;
  }

  const turnstileToken = getTurnstileToken();
  if (appConfig.turnstileSiteKey && !turnstileToken) {
    errorEl.textContent = 'Please complete the captcha before signing in.';
    resetTurnstileChallenge();
    return;
  }
  if (appConfig.turnstileSiteKey && Date.now() - loginTurnstileTokenIssuedAt > 240_000) {
    errorEl.textContent = 'Captcha expired. Please complete it again.';
    resetTurnstileChallenge();
    return;
  }

  try {
    if (btn) btn.disabled = true;
    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password, turnstileToken }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.retryAfter) {
        startLoginCooldown(data.retryAfter, errorEl);
      } else {
        errorEl.textContent = data.error || 'Invalid credentials.';
        errorEl.style.color = '';
      }
      resetTurnstileChallenge();
      return;
    }

    if (data.status === '2fa_required') {
      otpTempToken = data.tempToken;
      resetTurnstileChallenge();
      showLoginStep('otp');
      document.getElementById('login-otp').focus();
      return;
    }

    if (data.status === 'change_password') {
      currentUser = data.user.displayName;
      currentRole = data.user.role;
      resetTurnstileChallenge();
      showLoginStep('change-password');
      document.getElementById('new-password').focus();
      return;
    }

    // Success
    currentUser = data.user.displayName;
    currentRole = data.user.role;
    resetTurnstileChallenge();
    if (currentRole === 'admin') { window.location.href = '/admin.html'; return; }
    hideLoginOverlay();
    init();

  } catch {
    document.getElementById('login-error').textContent = 'Connection error. Please try again.';
    resetTurnstileChallenge();
  }
}

async function verifyOtp() {
  const otp      = document.getElementById('login-otp').value.trim();
  const errorEl  = document.getElementById('otp-error');

  if (!otp) { errorEl.textContent = 'Please enter the code.'; return; }

  try {
    const res  = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken: otpTempToken, otp }),
    });
    const data = await res.json();

    if (!res.ok) { errorEl.textContent = data.error || 'Invalid code.'; return; }

    currentUser = data.user.displayName;
    currentRole = data.user.role;

    if (data.status === 'change_password') {
      showLoginStep('change-password');
      document.getElementById('new-password').focus();
      return;
    }

    hideLoginOverlay();
    if (currentRole === 'admin') { window.location.href = '/admin.html'; return; }
    init();
  } catch {
    document.getElementById('otp-error').textContent = 'Connection error. Please try again.';
  }
}

async function submitNewPassword() {
  const np      = document.getElementById('new-password').value;
  const cp      = document.getElementById('confirm-password').value;
  const errorEl = document.getElementById('cp-error');

  if (np !== cp)    { errorEl.textContent = 'Passwords do not match.'; return; }
  if (np.length < 8){ errorEl.textContent = 'Password must be at least 8 characters.'; return; }

  // For force-change during login we need a current password.
  // Use the password just entered to login (still in the input).
  const currentPassword = document.getElementById('login-password').value;

  try {
    const res  = await apiFetch('/api/auth/change-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ currentPassword, newPassword: np }),
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Failed to change password.'; return; }
    hideLoginOverlay();
    if (currentRole === 'admin') { window.location.href = '/admin.html'; return; }
    init();
  } catch {
    errorEl.textContent = 'Connection error. Please try again.';
  }
}

async function logout() {
  currentUser  = null;
  currentRole  = null;
  applyRoleUi();
  lastPostId   = null;
  unreadCount  = 0;
  document.title = originalTitle;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  document.querySelectorAll('#posts .post').forEach(el => el.remove());
  document.getElementById('settings-panel').style.display = 'none';
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLoginOverlay();
}

// Login keyboard shortcuts
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') attemptLogin();
});
document.getElementById('login-username').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-password').focus();
});

// ── Config & initialisation ───────────────────────────────────────────────────

function parseMediaSize(value, fallbackWidth, fallbackHeight) {
  const [width, height] = String(value || '').split('x').map(part => parseInt(part, 10));
  return {
    width: Number.isFinite(width) ? width : fallbackWidth,
    height: Number.isFinite(height) ? height : fallbackHeight,
  };
}

function parseMediaInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function applyMediaConfig() {
  const media = appConfig.media || {};
  const recordingSize = parseMediaSize(media.videoRecordingSize, 600, 800);
  VIDEO_RECORDING_TARGET.width = recordingSize.width;
  VIDEO_RECORDING_TARGET.height = recordingSize.height;
  VIDEO_RECORDING_TARGET.fps = parseMediaInteger(media.videoRecordingFps, 24);
  VIDEO_RECORDING_TARGET.videoBitsPerSecond = parseMediaInteger(media.videoRecordingVideoBitrate, 1000000);
  VIDEO_RECORDING_TARGET.audioBitsPerSecond = parseMediaInteger(media.videoRecordingAudioBitrate, 128000);

  const conversionSize = parseMediaSize(media.videoConversionSize, 600, 800);
  VIDEO_UPLOAD_TARGET.width = conversionSize.width;
  VIDEO_UPLOAD_TARGET.height = conversionSize.height;
  VIDEO_UPLOAD_TARGET.fps = parseMediaInteger(media.videoConversionFps, 24);
  VIDEO_UPLOAD_TARGET.videoBitrate = media.videoConversionVideoBitrate || '1000k';
  VIDEO_UPLOAD_TARGET.audioBitrate = media.videoConversionAudioBitrate || '128k';

  AUDIO_UPLOAD_TARGET.format = media.audioUploadFormat || 'wav';
  AUDIO_UPLOAD_TARGET.bitrate = media.audioUploadBitrate || '48k';
  AUDIO_UPLOAD_TARGET.sampleRate = media.audioRecordingSampleRate || '48000';

  AUDIO_RECORDING_TARGET.sampleRate = parseMediaInteger(media.audioRecordingSampleRate, 48000);
  AUDIO_RECORDING_TARGET.maxSeconds = parseMediaInteger(media.audioRecordingMaxSeconds, 5 * 60);
  AUDIO_RECORDING_TARGET.echoCancellation = !!media.audioEchoCancellation;
  AUDIO_RECORDING_TARGET.noiseSuppression = !!media.audioNoiseSuppression;
  AUDIO_RECORDING_TARGET.autoGainControl = !!media.audioAutoGainControl;
}

async function loadConfig() {
  try {
    const res = await apiFetch('/api/config');
    appConfig  = await res.json();

    applyMediaConfig();
    applyAppConfigChrome();
    if (appConfig.enableEmergencyExit) activateEmergencyExit();
    renderColourSchemeButtons();
    renderFontFamilyButtons();

    if (appConfig.turnstileSiteKey) loadTurnstile(appConfig.turnstileSiteKey);
  } catch (e) {
    console.warn('[config] could not load:', e.message);
  }
}

async function loadMe() {
  const res  = await apiFetch('/api/me');
  if (!res.ok) { showLoginOverlay(); throw new Error('Not logged in'); }
  const data = await res.json();
  currentUser = data.user;
  currentRole = data.role;
  applyRoleUi();

  // Show admin link in settings
  const adminBtn = document.getElementById('admin-panel-btn');
  if (adminBtn) adminBtn.style.display = data.role === 'admin' ? 'block' : 'none';

  return data;
}

async function loadPreferences() {
  try {
    const res  = await apiFetch('/api/preferences');
    if (!res.ok) return;
    const data = await res.json();
    const availableSchemes = getAvailableColourSchemeIds();
    const preferredScheme = data.scheme && availableSchemes.includes(data.scheme) ? data.scheme : availableSchemes[0];
    applyColourScheme(preferredScheme, false);
    enterToSend = !!data.enterToSend;
    pushPreferenceEnabled = !!data.pushEnabled;
    const toggle = document.getElementById('enter-to-send-toggle');
    if (toggle) toggle.checked = enterToSend;
    if (data.fontSize != null) applyFontSize(data.fontSize, false);
    applyFontFamily(data.fontFamily || appConfig.defaultFontFamily || 'system', false);
  } catch (e) {
    console.warn('[prefs] could not load:', e.message);
  }
}

async function loadMessages() {
  if (!currentUser) return;
  try {
    const res = await apiFetch(`/api/messages?active=${isPageVisible}`);
    if (res.status === 401) { showLoginOverlay(); return; }
    if (!res.ok) return;
    const { posts, typing, lastSeen } = await res.json();

    const container = document.getElementById('posts');
    if (!container) return;

    // Timestamps of already-rendered real messages
    const realPosts    = container.querySelectorAll('.post:not(.pending-msg)');
    const lastMsg      = realPosts.length > 0 ? realPosts[realPosts.length - 1] : null;
    const lastMsgTime  = lastMsg ? parseInt(lastMsg.dataset.timestamp) : 0;

    const isNearBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 150;
    const latestId     = posts.length > 0 ? posts[posts.length - 1].id : null;

    // Typing indicator
    const oldIndicatorText = indicator.textContent;
    indicator.textContent  = typing.length > 0
      ? `${typing.join(', ')} ${typing.length > 1 ? 'are' : 'is'} typing…`
      : '';
    if (isNearBottom && indicator.textContent !== oldIndicatorText && indicator.textContent !== '') {
      scrollToBottom(true);
    }

    // Other user's last seen for read receipts
    const otherUser     = Object.keys(lastSeen || {}).find(u => u !== currentUser);
    const otherLastSeen = otherUser ? lastSeen[otherUser] : 0;

    // Online indicator
    const dot = document.getElementById('status-dot');
    if (dot) {
      const online = otherLastSeen > (Date.now() - 15000);
      dot.classList.toggle('online', online);
      dot.title = online ? `${otherUser} is Online` : 'Offline';
    }

    // Render new messages
    posts.forEach(p => {
      const existing = document.querySelector(`.post[data-id="${p.id}"]`);
      if (!existing) {
        if (p.createdAt < lastMsgTime) return;
        const div = renderMessage(p, otherLastSeen, currentUser, appConfig);
        if (!isPageVisible && p.user !== currentUser) {
          unreadCount++;
          document.title = `(${unreadCount}) ${originalTitle}`;
          div.dataset.unread = 'true';
        }
        container.appendChild(div);
      } else {
        if (existing.dataset.flagstate !== (p.flagState || 'none')) {
          const replacement = renderMessage(p, otherLastSeen, currentUser, appConfig);
          existing.replaceWith(replacement);
          return;
        }
        // Update read receipt on existing bubble
        if (p.user === currentUser) {
          const isSeen    = otherLastSeen > 0 && otherLastSeen >= p.createdAt;
          const statusSpan= existing.querySelector('.read-status');
          if (statusSpan) {
            statusSpan.className   = `read-status ${isSeen ? 'seen' : ''}`;
            statusSpan.textContent = isSeen
              ? (appConfig.readStatusSeen    || '✓✓')
              : (appConfig.readStatusUnread  || '✓');
          }
        }
        // Update view-once status
        if (p.viewOnce) updateViewOnceEl(existing, p);
        // Update reaction strip
        updateReactionStrip(existing, p.reactions);
      }
    });

    // Wait for images to load before deciding scroll
    const images = container.querySelectorAll('img');
    await Promise.all(Array.from(images).map(img =>
      img.complete ? Promise.resolve() : new Promise(r => {
        img.addEventListener('load',  r, { once: true });
        img.addEventListener('error', r, { once: true });
      })
    ));

    if (lastPostId === null && posts.length > 0) {
      scrollToBottom(true);
    } else if (latestId !== lastPostId && latestId !== null) {
      if (isNearBottom) scrollToBottom(true);
      else if (posts.at(-1)?.user !== currentUser) prompt.style.display = 'flex';
    }

    // Garbage-collect soft-deleted messages from DOM
    if (posts.length > 0) {
      const serverIds     = new Set(posts.map(p => p.id));
      const oldestFetched = posts[0].createdAt;
      document.querySelectorAll('.post').forEach(div => {
        if (div.classList.contains('pending-msg')) return;
        const divTime = parseInt(div.dataset.timestamp);
        const divId   = div.dataset.id;
        if (divTime >= oldestFetched && !serverIds.has(divId)) {
          if (div.dataset.unread === 'true') {
            unreadCount = Math.max(0, unreadCount - 1);
            document.title = unreadCount > 0 ? `(${unreadCount}) ${originalTitle}` : originalTitle;
          }
          div.style.transition = 'opacity 0.5s, height 0.5s';
          div.style.opacity    = '0';
          div.style.height     = '0';
          setTimeout(() => div.remove(), 500);
        }
      });
    }

    if (isNearBottom) prompt.style.display = 'none';
    lastPostId = latestId;

  } catch (err) { console.error('[messages]', err); }
}

// ── Message rendering ─────────────────────────────────────────────────────────

function renderMessage(p, otherLastSeen, me, cfg) {
  const div     = document.createElement('div');
  const isMine  = p.user === me;
  const isReadOnly = isAdultObserver();

  div.className        = `post ${isMine ? 'mine' : 'theirs'}`;
  div.dataset.timestamp= p.createdAt;
  div.dataset.id       = p.id;
  div.dataset.user     = p.user;
  div.dataset.text     = p.text || '';
  div.dataset.imagepath= p.imagePath || '';
  div.dataset.mediatype= p.mediaType || '';
  div.dataset.flagstate= p.flagState || 'none';
  if (p.flagState === 'adult') div.classList.add('flagged-adult');
  if (p.flagState === 'hidden') div.classList.add('flagged-hidden');
  if (p.flagState === 'outcome') div.classList.add('flagged-outcome');

  // Read receipt
  let statusHtml = '';
  if (isMine && !isObserverRole() && p.flagState !== 'hidden' && p.flagState !== 'outcome') {
    const isSeen = otherLastSeen > 0 && otherLastSeen >= p.createdAt;
    statusHtml   = `<span class="read-status ${isSeen ? 'seen' : ''}">${
      isSeen ? (cfg.readStatusSeen || '✓✓') : (cfg.readStatusUnread || '✓')
    }</span>`;
  }

  // Quoted message
  let quoteHtml = '';
  if (p.replyText) {
    quoteHtml = `<div class="quoted-msg" data-replyid="${p.replyId}" style="cursor:pointer;">
      <span class="quoted-user">${escapeHtml(p.replyUser)}</span>
      ${escapeHtml(p.replyText)}
    </div>`;
  }

  // Media
  let imageHtml = '';
  if (p.imagePath) {
    const mediaType = getMediaTypeFromPath(p.imagePath, p.mediaType);
    const isVideo   = mediaType === 'video';
    const isAudio   = mediaType === 'audio';
    const blurClass = p.isBlurred ? 'blurred-preview' : '';

    if (p.viewOnce) {
      const recipientSeen = p.seenBy && p.seenBy.some(u => u !== p.user);
      if (isMine) {
        imageHtml = `<div class="view-once sent">${isAudio ? '👂 Listen Once' : '👁️ View Once'}<div class="view-once-status">${recipientSeen ? 'Opened' : 'Delivered'}</div></div>`;
      } else {
        const iSaw = !isAdultObserver() && p.seenBy && p.seenBy.includes(me);
        imageHtml  = iSaw
          ? `<div class="view-once dead">${isAudio ? '👂 Voice Message Heard' : `👁️ ${isVideo ? 'Video' : 'Photo'} Viewed`}</div>`
          : `<div id="view-once-${p.id}" class="view-once active" data-media-type="${mediaType}" onclick="openViewOnce('${p.id}')">${isAudio ? '👂 Listen Once' : `👁️ View Once ${isVideo ? 'Video' : 'Photo'}`}</div>`;
      }
    } else if (isAudio) {
      imageHtml = `<div class="voice-note-label">Voice message</div><audio src="${p.imagePath}" class="chat-audio" controls controlsList="nodownload" preload="metadata" oncontextmenu="return false"></audio>`;
    } else if (p.isBlurred) {
      const openOriginal = `showImagePopup(${escapeHtml(JSON.stringify(p.imagePath))})`;
      if (p.blurPreviewPath) {
        if (isVideo) {
          imageHtml = `<div class="blurred-video-placeholder" onclick="${openOriginal}">
            <img src="${escapeHtml(p.blurPreviewPath)}" class="chat-img clickable-img" alt="Blurred video preview">
            <span class="video-play-badge">▶</span>
          </div>`;
        } else {
          imageHtml = `<img src="${escapeHtml(p.blurPreviewPath)}" class="chat-img clickable-img blurred-placeholder" onclick="${openOriginal}" alt="Blurred image preview">`;
        }
      } else {
        imageHtml = `<button type="button" class="blurred-media-placeholder ${isVideo ? 'video' : 'image'}" onclick="${openOriginal}">
          ${isVideo ? 'Blurred video' : 'Blurred image'}
        </button>`;
      }
    } else if (isVideo) {
      imageHtml = `<video src="${p.imagePath}" class="chat-img ${blurClass}"
        controls controlsList="nodownload" preload="metadata" oncontextmenu="return false" playsinline
        onclick="this.classList.remove('blurred-preview')"
        onplay="this.classList.remove('blurred-preview')"
        ${p.isBlurred ? 'onended="this.classList.add(\'blurred-preview\')"' : ''}
        style="width:200px;height:200px;object-fit:cover;background:#000;"></video>`;
    } else {
      imageHtml = `<img src="${p.imagePath}" class="chat-img clickable-img ${blurClass}" onclick="showImagePopup('${p.imagePath}')">`;
    }
  }

  div.innerHTML = `
    ${p.flagState === 'adult' ? '<span class="flagged-label">FLAGGED</span>' : ''}
    ${p.flagState === 'adult' && p.flagStatusText ? `<span class="flagged-status">${escapeHtml(p.flagStatusText)}</span>` : ''}
    ${p.flagState === 'outcome' ? '<span class="moderation-outcome-label">MODERATION OUTCOME</span>' : ''}
    <span class="post-header">[${new Date(p.createdAt).toLocaleTimeString()}] <b>${escapeHtml(p.user)}</b></span>
    ${quoteHtml}
    <div class="message-text">${linkify(p.text)}</div>
    ${imageHtml}${statusHtml}
    <div class="reaction-strip"></div>
  `;

  attachMediaUnavailableFallback(div);

  // Delete button (own messages)
  const isModerationPlaceholder = p.flagState === 'hidden' || p.flagState === 'outcome';

  if (isMine && cfg.enableDeleteButton !== false && !isReadOnly && !isModerationPlaceholder) {
    const btn   = document.createElement('button');
    btn.className   = 'delete-btn';
    btn.textContent = cfg.deleteButton || '✗';
    div.appendChild(btn);
  }

  // Report button (received messages, if enabled)
  if (!isMine && cfg.enableReport && !p.flagged) {
    const btn   = document.createElement('button');
    btn.className   = 'report-btn';
    btn.textContent = '!';
    btn.title       = 'Report message';
    div.appendChild(btn);
  }

  if (!isReadOnly && !isModerationPlaceholder) {
    const rBtn       = document.createElement('button');
    rBtn.className   = 'reply-btn';
    rBtn.textContent = cfg.replyButton || '↩';
    div.appendChild(rBtn);
  }

  updateReactionStrip(div, p.reactions);

  return div;
}

function attachMediaUnavailableFallback(messageEl) {
  const mediaEls = messageEl.querySelectorAll('img.chat-img, video.chat-img, audio.chat-audio');
  mediaEls.forEach(el => {
    el.addEventListener('error', () => {
      if (!el.isConnected) return;
      const placeholder = document.createElement('div');
      placeholder.className = 'media-unavailable';
      placeholder.textContent = '[Media unavailable]';
      el.replaceWith(placeholder);
    }, { once: true });
  });
}

// ── Reaction strip renderer ────────────────────────────────────────────────────

function updateReactionStrip(msgEl, reactions) {
  const strip = msgEl.querySelector('.reaction-strip');
  if (!strip) return;
  if (!reactions || reactions.length === 0) { strip.innerHTML = ''; return; }
  strip.innerHTML = reactions.map(r => {
    const count   = r.users.length;
    const isMine  = !isObserverRole() && currentUser && r.users.includes(currentUser);
    const safeEmoji = escapeHtml(r.emoji);
    const label   = count > 1 ? `${safeEmoji} ${count}` : safeEmoji;
    return `<span class="reaction-chip${isMine ? ' mine' : ''}" data-emoji="${safeEmoji}">${label}</span>`;
  }).join('');
}

function updateViewOnceEl(existing, p) {
  const voEl = document.getElementById(`view-once-${p.id}`) || existing.querySelector('.view-once');
  if (!voEl) return;
  if (p.user === currentUser) {
    const recipientSeen = p.seenBy && p.seenBy.some(u => u !== p.user);
    const st = voEl.querySelector('.view-once-status');
    if (st) st.textContent = recipientSeen ? 'Opened' : 'Delivered';
  } else {
    const iSaw = !isAdultObserver() && p.seenBy && p.seenBy.includes(currentUser);
    if (iSaw && voEl.classList.contains('active')) {
      const mediaType = getMediaTypeFromPath(p.imagePath, p.mediaType);
      const isVideo = mediaType === 'video';
      const isAudio = mediaType === 'audio';
      voEl.className = 'view-once dead';
      voEl.removeAttribute('id');
      voEl.innerHTML = isAudio ? '👂 Voice Message Heard' : `👁️ ${isVideo ? 'Video' : 'Photo'} Viewed`;
      voEl.onclick   = null;
    }
  }
}

// ── History loading ───────────────────────────────────────────────────────────

let loadingOlder = false;

async function loadOlderPosts() {
  const firstMsg = document.querySelector('.post');
  if (!firstMsg || loadingOlder) return 0;

  loadingOlder = true;
  const oldest = firstMsg.dataset.timestamp;

  try {
    const res  = await apiFetch(`/api/messages?limit=30&before=${oldest}`);
    const data = await res.json();
    if (data.posts && data.posts.length > 0) {
      const oldH = document.body.scrollHeight;
      renderOlderPosts(data.posts);
      window.scrollBy(0, document.body.scrollHeight - oldH);
      return data.posts.length;
    }
    return 0;
  } catch (err) {
    console.error('[history]', err);
    return 0;
  } finally {
    loadingOlder = false;
  }
}

function renderOlderPosts(olderPosts) {
  const sentinel = document.getElementById('load-more-sentinel');
  const fragment = document.createDocumentFragment();

  olderPosts.forEach(p => {
    if (document.querySelector(`.post[data-id="${p.id}"]`)) return;
    const div = renderMessage(p, 0, currentUser, appConfig);
    fragment.appendChild(div);
  });

  sentinel.after(fragment);
}

async function scrollToMessage(id, quotedEl) {
  if (!id || id === 'undefined' || id === 'null') return;

  let target = document.querySelector(`.post[data-id="${id}"]`);
  if (target) { highlightMessage(target); return; }

  const origOpacity    = quotedEl.style.opacity;
  quotedEl.style.opacity = '0.5';

  let attempts = 0;
  let found    = false;
  while (!found && attempts < 3) {
    attempts++;
    const count = await loadOlderPosts();
    if (count === 0) break;
    target = document.querySelector(`.post[data-id="${id}"]`);
    if (target) { found = true; highlightMessage(target); }
    else await new Promise(r => setTimeout(r, 200));
  }
  quotedEl.style.opacity = origOpacity || '1';
}

function highlightMessage(target) {
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.style.transition = 'background 0.5s';
  target.style.background = '#4fc3f755';
  setTimeout(() => { target.style.background = ''; }, 1000);
}

// ── Form submission ────────────────────────────────────────────────────────────

function isVideoFile(file) {
  if (!file) return false;
  const mime = (file.type || '').split(';')[0].toLowerCase();
  return mime.startsWith('video/') || VIDEO_FILE_EXT_RE.test(file.name || '');
}

function isAudioFile(file) {
  if (!file) return false;
  const mime = (file.type || '').split(';')[0].toLowerCase();
  return mime.startsWith('audio/') || AUDIO_FILE_EXT_RE.test(file.name || '');
}

function getMediaTypeFromFile(file) {
  if (!file) return null;
  if (isAudioFile(file)) return 'audio';
  if (isVideoFile(file)) return 'video';
  return 'image';
}

function shouldCompressAudioFile(file) {
  if (!file || !isAudioFile(file) || file.isOptimized) return false;
  if (AUDIO_UPLOAD_TARGET.format === 'wav') return false;
  const mime = (file.type || '').split(';')[0].toLowerCase();
  const name = file.name || '';
  if (AUDIO_UPLOAD_TARGET.format === 'aac') return mime !== 'audio/mp4' && !/\.(m4a|mp4)$/i.test(name);
  return file.needsAudioCompression || mime === 'audio/wav' || mime === 'audio/x-wav' || /\.wav$/i.test(name) || !mime.includes('webm');
}

function getMediaTypeFromPath(filePath, fallback = null) {
  if (fallback) return fallback;
  if (!filePath) return null;
  if (AUDIO_FILE_EXT_RE.test(filePath)) return 'audio';
  if (/\.(mp4|webm|mkv|mov)$/i.test(filePath)) return 'video';
  return 'image';
}

function getMediaReplyLabel(filePath, mediaType = null) {
  const type = getMediaTypeFromPath(filePath, mediaType);
  if (type === 'audio') return 'Voice message';
  if (type === 'video') return 'Video';
  return filePath ? 'Photo' : '';
}

function createBlurredVideoPreview(file) {
  return new Promise(resolve => {
    if (!file || !isVideoFile(file)) { resolve(null); return; }

    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    let timeoutId = null;

    const finish = value => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const capture = () => {
      try {
        const width = video.videoWidth || 240;
        const height = video.videoHeight || 240;
        const size = 240;
        const scale = Math.max(size / width, size / height);
        const drawW = width * scale;
        const drawH = height * scale;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { finish(null); return; }
        ctx.filter = 'blur(14px)';
        ctx.drawImage(video, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);
        canvas.toBlob(blob => {
          finish(blob ? new File([blob], 'blur-preview.jpg', { type: 'image/jpeg' }) : null);
        }, 'image/jpeg', 0.5);
      } catch {
        finish(null);
      }
    };

    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('error', () => finish(null), { once: true });
    video.addEventListener('loadeddata', () => {
      try {
        if (Number.isFinite(video.duration) && video.duration > 0.1) {
          video.currentTime = Math.min(0.1, video.duration / 2);
        } else {
          capture();
        }
      } catch {
        capture();
      }
    }, { once: true });
    video.addEventListener('seeked', capture, { once: true });
    timeoutId = setTimeout(() => finish(null), 4000);
    video.src = url;
    video.load();
  });
}

function openDraftDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) db.createObjectStore(DRAFT_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open draft storage'));
  });
}

async function withDraftStore(mode, callback) {
  let db = null;
  try {
    db = await openDraftDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE_NAME, mode);
      const store = tx.objectStore(DRAFT_STORE_NAME);
      let settled = false;
      const finish = value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      tx.oncomplete = () => finish();
      tx.onerror = () => reject(tx.error || new Error('Draft storage transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Draft storage transaction aborted'));
      callback(store, finish, reject);
    });
  } finally {
    if (db) db.close();
  }
}

async function getSavedDraft() {
  return withDraftStore('readonly', (store, resolve, reject) => {
    const req = store.get(CURRENT_DRAFT_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('Could not read draft'));
  }).catch(err => {
    console.warn('[draft] read failed:', err.message);
    return null;
  });
}

async function saveDraft(draft) {
  if (draft?.draftId && submittedDraftIds.has(draft.draftId)) return;
  await withDraftStore('readwrite', (store, resolve, reject) => {
    if (draft?.draftId && submittedDraftIds.has(draft.draftId)) {
      resolve();
      return;
    }
    const req = store.put(draft, CURRENT_DRAFT_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Could not save draft'));
  }).catch(err => console.warn('[draft] save failed:', err.message));
}

async function deleteSavedDraft(expectedDraftId = null) {
  restoredDraftFile = null;
  if (expectedDraftId) {
    const draft = await getSavedDraft();
    if (draft?.draftId && draft.draftId !== expectedDraftId) return;
  }
  if (!expectedDraftId || currentDraftId === expectedDraftId) currentDraftId = null;
  await withDraftStore('readwrite', (store, resolve, reject) => {
    const req = store.delete(CURRENT_DRAFT_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Could not delete draft'));
  }).catch(err => console.warn('[draft] delete failed:', err.message));
}

async function clearSubmittedDraft(expectedDraftId = null) {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  if (expectedDraftId) submittedDraftIds.add(expectedDraftId);
  const shouldClearComposer = !expectedDraftId || !currentDraftId || currentDraftId === expectedDraftId;
  await deleteSavedDraft(expectedDraftId);
  if (shouldClearComposer) {
    currentDraftId = null;
    clearPreview({ deleteDraft: false });
    collapseAttachmentPicker();
  }
}

function getSelectedMediaFile() {
  return getSelectedMediaFiles()[0] || null;
}

function getSelectedMediaFiles() {
  if (imageInput.files.length > 0) return Array.from(imageInput.files);
  if (cameraInput.files.length > 0) return Array.from(cameraInput.files);
  if (videoInput.files.length > 0) return Array.from(videoInput.files);
  return restoredDraftFile ? [restoredDraftFile] : [];
}

function getSelectedMediaSourceId() {
  if (imageInput.files.length > 0) return 'imageInput';
  if (cameraInput.files.length > 0) return 'cameraInput';
  if (videoInput.files.length > 0) return 'videoInput';
  return restoredDraftFile ? 'imageInput' : null;
}

function buildCurrentDraft(file = getSelectedMediaFile()) {
  if (!file) return null;
  if (!currentDraftId) currentDraftId = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    draftId: currentDraftId,
    savedAt: Date.now(),
    text: textInput.value,
    viewOnce: document.getElementById('viewOnce').checked,
    isBlurred: document.getElementById('blurInput').checked,
    replyData: replyingTo ? { ...replyingTo } : null,
    sourceInputId: getSelectedMediaSourceId(),
    file,
  };
}

function persistCurrentDraft() {
  if (isRestoringDraft) return;
  const draft = buildCurrentDraft();
  if (!draft) return;
  saveDraft(draft);
}

function scheduleDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    persistCurrentDraft();
  }, 250);
}

function clearOtherMediaInputs(activeInput) {
  [imageInput, cameraInput, videoInput].forEach(input => {
    if (input !== activeInput) input.value = '';
  });
  restoredDraftFile = null;
}

function assignFileToInput(input, file) {
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    restoredDraftFile = null;
    return true;
  } catch (err) {
    console.warn('[draft] could not restore file input:', err.message);
    restoredDraftFile = file;
    return false;
  }
}

function updateComposerLayoutForText() {
  textInput.style.height    = 'auto';
  const newH                = Math.min(textInput.scrollHeight, 150);
  textInput.style.height    = newH + 'px';
  textInput.style.overflowY = textInput.scrollHeight > 150 ? 'scroll' : 'hidden';

  const audioRecorderOpen = document.getElementById('audio-recorder-bar')?.style.display === 'flex';
  const hasText = textInput.value.trim().length > 0;
  const canKeepPickerOpen = document.getElementById('media-options')?.dataset.manual === 'true'
    && !hasText
    && !getSelectedMediaFile()
    && !audioRecorderOpen;
  canKeepPickerOpen ? expandAttachmentPicker() : collapseAttachmentPicker();
}

function collapseAttachmentPicker() {
  const mediaOpts = document.getElementById('media-options');
  const plusBtn   = document.getElementById('plus-btn');
  if (!mediaOpts || !plusBtn) return;
  mediaOpts.style.display  = 'none';
  mediaOpts.dataset.manual = 'false';
  plusBtn.style.display    = 'flex';
}

function expandAttachmentPicker() {
  const mediaOpts = document.getElementById('media-options');
  const plusBtn   = document.getElementById('plus-btn');
  if (!mediaOpts || !plusBtn) return;
  mediaOpts.style.display  = 'flex';
  mediaOpts.dataset.manual = 'true';
  plusBtn.style.display    = 'none';
}

async function restoreSavedDraft() {
  const draft = await getSavedDraft();
  if (!draft?.file) return;
  if (!draft.savedAt || Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
    await deleteSavedDraft();
    return;
  }

  isRestoringDraft = true;
  try {
    currentDraftId = draft.draftId || null;
    const sourceInput = document.getElementById(draft.sourceInputId || 'imageInput') || imageInput;
    imageInput.value = '';
    cameraInput.value = '';
    videoInput.value  = '';
    assignFileToInput(sourceInput, draft.file);
    textInput.value = draft.text || '';
    document.getElementById('viewOnce').checked  = !!draft.viewOnce;
    document.getElementById('blurInput').checked = !!draft.isBlurred;
    if (draft.replyData?.user || draft.replyData?.text) {
      replyingTo = { ...draft.replyData };
      document.getElementById('reply-info').textContent = `Replying to ${replyingTo.user}`;
      document.getElementById('reply-text-preview').textContent = replyingTo.text;
      replyContainer.style.display = 'block';
    } else {
      replyingTo = null;
      replyContainer.style.display = 'none';
    }
    renderMediaPreview(draft.file);
    collapseAttachmentPicker();
    updateComposerLayoutForText();
  } finally {
    isRestoringDraft = false;
  }
}

document.getElementById('postForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (isObserverRole()) return;

  const files     = getSelectedMediaFiles();
  const text      = textInput.value.trim();
  const viewOnce  = document.getElementById('viewOnce').checked;
  const wantsBlur = document.getElementById('blurInput').checked;
  const replyData = replyingTo ? { ...replyingTo } : null;
  const submittedAt = Date.now();
  const submittedDraftId = currentDraftId;
  if (submittedDraftId) submittedDraftIds.add(submittedDraftId);
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }

  const items = files.length > 0
    ? files.map((file, index) => ({
        file,
        text: index === 0 ? text : '',
        replyData: index === 0 ? replyData : null,
        submittedAt: submittedAt + index,
      }))
    : [{ file: null, text, replyData, submittedAt }];

  const pendingIds = items.map(item => {
    const pendingId = 'p-' + (crypto.randomUUID ? crypto.randomUUID() : `${item.submittedAt}-${Math.random().toString(36).slice(2)}`);
    const bubbleEl = createPendingBubble(pendingId, item.text, item.file, item.replyData);
    pendingMessages.set(pendingId, {
      bubbleEl,
      formData: null,
      xhr: null,
      cancelled: false,
      submittedDraftId,
    });
    return pendingId;
  });

  // Reset form immediately
  textInput.value = '';
  textInput.style.height = 'auto';
  cancelReply();
  clearPreview({ deleteDraft: false });
  collapseAttachmentPicker();
  updateButtonState();
  textInput.focus();

  for (let i = 0; i < items.length; i++) {
    await preparePendingUpload(pendingIds[i], items[i], {
      viewOnce,
      wantsBlur,
      clearDraftOnSuccess: i === 0,
    });
  }
});

async function preparePendingUpload(pendingId, item, options) {
  let fileToSend = item.file;
  const { viewOnce, wantsBlur, clearDraftOnSuccess } = options;

  // Optional video compression
  const needsCompression = isVideoFile(fileToSend) && !fileToSend.isOptimized;
  if (needsCompression) {
    setPendingLabel(pendingId, 'Converting video...');
    setPendingProgress(pendingId, 0, '#ffc107');
    activePendingId = pendingId;
    try {
      const compressed = await compressVideo(fileToSend);
      fileToSend = compressed;
    } catch (err) {
      console.error('[compress]', err);
      activePendingId = null;
      setPendingFailed(pendingId, getVideoConversionFailureMessage(fileToSend, err), { retry: false });
      return;
    }
    activePendingId = null;
    const entry = pendingMessages.get(pendingId);
    if (!entry || entry.cancelled) { removePendingBubble(pendingId); return; }
  }

  const needsAudioCompression = shouldCompressAudioFile(fileToSend);
  if (needsAudioCompression) {
    setPendingLabel(pendingId, 'Converting audio...');
    setPendingProgress(pendingId, 0, '#ffc107');
    activePendingId = pendingId;
    try {
      const compressed = await compressAudio(fileToSend);
      fileToSend = compressed;
    } catch (err) {
      console.error('[compress-audio]', err);
      activePendingId = null;
      setPendingFailed(pendingId, getAudioConversionFailureMessage(fileToSend, err), { retry: false });
      return;
    }
    activePendingId = null;
    const entry = pendingMessages.get(pendingId);
    if (!entry || entry.cancelled) { removePendingBubble(pendingId); return; }
  }

  const isBlurred = !!fileToSend && !isAudioFile(fileToSend) && wantsBlur;
  let blurPreviewFile = null;
  if (isBlurred && isVideoFile(fileToSend)) {
    setPendingLabel(pendingId, 'Preparing preview...');
    blurPreviewFile = await createBlurredVideoPreview(fileToSend);
    const entry = pendingMessages.get(pendingId);
    if (!entry || entry.cancelled) { removePendingBubble(pendingId); return; }
  }

  const formData = new FormData();
  formData.append('text',        item.text);
  formData.append('viewOnce',    String(viewOnce));
  formData.append('isBlurred',   String(isBlurred));
  formData.append('submittedAt', String(item.submittedAt));
  if (item.replyData) {
    formData.append('replyUser', item.replyData.user);
    formData.append('replyText', item.replyData.text);
    if (item.replyData.id) formData.append('replyId', item.replyData.id);
  }
  if (fileToSend) formData.append('image', fileToSend);
  if (blurPreviewFile) formData.append('blurPreview', blurPreviewFile);

  const entry = pendingMessages.get(pendingId);
  if (entry) {
    entry.formData = formData;
    entry.submittedDraftId = clearDraftOnSuccess ? entry.submittedDraftId : null;
  }
  startPendingUpload(pendingId);
}

// ── Pending bubble helpers ────────────────────────────────────────────────────

function createPendingBubble(pendingId, text, file, replyData) {
  const div  = document.createElement('div');
  div.className       = 'post mine pending-msg';
  div.dataset.pendingId = pendingId;

  let quoteHtml = '';
  if (replyData) {
    quoteHtml = `<div class="quoted-msg"><span class="quoted-user">${escapeHtml(replyData.user)}</span>${escapeHtml(replyData.text)}</div>`;
  }
  let mediaHtml = '';
  if (file) {
    if (isAudioFile(file)) {
      const blobUrl = URL.createObjectURL(file);
      mediaHtml = `<div class="pending-audio-label">Voice message</div><audio src="${blobUrl}" class="chat-audio pending-preview-media" controls preload="metadata"></audio>`;
    } else if (isVideoFile(file)) {
      mediaHtml = `<div class="pending-video-label">[ Video ]</div>`;
    } else {
      const blobUrl = URL.createObjectURL(file);
      mediaHtml = `<img src="${blobUrl}" class="chat-img pending-preview-img pending-preview-media">`;
    }
  }

  div.innerHTML = `
    <span class="post-header">[${new Date().toLocaleTimeString()}] <b>${escapeHtml(currentUser || 'You')}</b></span>
    ${quoteHtml}
    <div class="message-text">${linkify(text)}</div>
    ${mediaHtml}
    <div class="pending-progress-wrap"><div class="pending-progress-bar"></div></div>
    <div class="pending-status-row">
      <span class="pending-status-text">Sending…</span>
      <button type="button" class="pending-cancel-btn" data-pending-id="${pendingId}" title="Cancel">✕</button>
    </div>
  `;

  postsContainer.appendChild(div);
  const pi = div.querySelector('.pending-preview-img');
  if (pi) { pi.complete ? scrollToBottom(true) : pi.addEventListener('load', () => scrollToBottom(true), { once: true }); }
  else scrollToBottom(true);
  return div;
}

function setPendingProgress(pendingId, percent, color) {
  const entry = pendingMessages.get(pendingId);
  if (!entry) return;
  const bar = entry.bubbleEl.querySelector('.pending-progress-bar');
  if (bar) { bar.style.width = percent + '%'; if (color) bar.style.backgroundColor = color; }
}

function setPendingLabel(pendingId, label) {
  const entry = pendingMessages.get(pendingId);
  if (!entry) return;
  const el = entry.bubbleEl.querySelector('.pending-status-text');
  if (el) el.textContent = label;
}

function getErrorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err || 'Unknown error');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function getVideoConversionFailureMessage(file, err) {
  const detail = getErrorMessage(err);
  const mime = file?.type || 'missing MIME type';
  const name = file?.name || 'unnamed video';
  const size = file ? formatBytes(file.size) : 'unknown size';
  return [
    'Video conversion failed.',
    `Reason: ${detail}`,
    `File: ${name} (${mime}, ${size})`,
    'The original video was not uploaded because it must be converted first.',
  ].join('\n');
}

function getAudioConversionFailureMessage(file, err) {
  const detail = getErrorMessage(err);
  const mime = file?.type || 'missing MIME type';
  const name = file?.name || 'unnamed audio';
  const size = file ? formatBytes(file.size) : 'unknown size';
  return [
    'Audio conversion failed.',
    `Reason: ${detail}`,
    `File: ${name} (${mime}, ${size})`,
    'The original WAV was not uploaded to avoid sending a large uncompressed recording.',
  ].join('\n');
}

function setPendingFailed(pendingId, message = 'Failed to send', options = {}) {
  const entry = pendingMessages.get(pendingId);
  if (!entry) return;
  const pw = entry.bubbleEl.querySelector('.pending-progress-wrap');
  if (pw) pw.style.display = 'none';
  const sr = entry.bubbleEl.querySelector('.pending-status-row');
  const safeMessage = escapeHtml(message);
  const retryButton = options.retry === false
    ? ''
    : `<button type="button" class="pending-retry-btn" data-pending-id="${pendingId}" title="Retry">↺ Retry</button>`;
  if (sr) sr.innerHTML = `
    <span class="pending-status-text pending-failed-text">${safeMessage}</span>
    ${retryButton}
    <button type="button" class="pending-remove-btn" data-pending-id="${pendingId}" title="Remove">✕</button>
  `;
}

function removePendingBubble(pendingId) {
  const entry = pendingMessages.get(pendingId);
  if (!entry) return;
  const pi = entry.bubbleEl.querySelector('.pending-preview-img');
  if (pi && pi.src.startsWith('blob:')) URL.revokeObjectURL(pi.src);
  entry.bubbleEl.querySelectorAll('.pending-preview-media').forEach(el => {
    if (el.src?.startsWith('blob:')) URL.revokeObjectURL(el.src);
  });
  entry.bubbleEl.remove();
  pendingMessages.delete(pendingId);
}

function startPendingUpload(pendingId) {
  const entry = pendingMessages.get(pendingId);
  if (!entry || entry.cancelled) return;
  if (!entry.formData) {
    setPendingFailed(pendingId, 'Nothing to upload', { retry: false });
    return;
  }

  const pw = entry.bubbleEl.querySelector('.pending-progress-wrap');
  if (pw) pw.style.display = 'block';
  setPendingProgress(pendingId, 0, '#007bff');

  const sr = entry.bubbleEl.querySelector('.pending-status-row');
  if (sr) sr.innerHTML = `
    <span class="pending-status-text">Uploading…</span>
    <button type="button" class="pending-cancel-btn" data-pending-id="${pendingId}" title="Cancel">✕</button>
  `;

  const xhr = new XMLHttpRequest();
  entry.xhr = xhr;
  xhr.open('POST', '/api/messages', true);
  // Credentials (session cookie) are sent automatically by the browser with same-origin XHR

  xhr.upload.onprogress = ev => {
    if (ev.lengthComputable) setPendingProgress(pendingId, (ev.loaded / ev.total) * 100);
  };
  xhr.onload = async () => {
    if (xhr.status === 201) {
      if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
      removePendingBubble(pendingId);
      await clearSubmittedDraft(entry.submittedDraftId);
      await loadMessages();
      scrollToBottom(true);
    } else {
      let message = `Upload failed (HTTP ${xhr.status || 'unknown'}).`;
      try {
        const data = JSON.parse(xhr.responseText || '{}');
        if (data.error) message = `Upload failed (HTTP ${xhr.status}).\n${data.error}`;
      } catch {}
      setPendingFailed(pendingId, message);
    }
  };
  xhr.onerror  = () => setPendingFailed(pendingId, 'Upload failed.\nNetwork error or the server closed the connection before the upload completed.');
  xhr.onabort  = () => removePendingBubble(pendingId);
  xhr.send(entry.formData);
}

// ── Event delegation on posts container ──────────────────────────────────────

postsContainer.addEventListener('click', async e => {
  const cancelBtn = e.target.closest('.pending-cancel-btn');
  const retryBtn  = e.target.closest('.pending-retry-btn');
  const removeBtn = e.target.closest('.pending-remove-btn');
  const delBtn    = e.target.closest('.delete-btn');
  const replyBtn  = e.target.closest('.reply-btn');
  const reportBtn = e.target.closest('.report-btn');
  const quotedMsg = e.target.closest('.quoted-msg');
  const chipEl    = e.target.closest('.reaction-chip');
  const postDiv   = e.target.closest('.post');

  if (cancelBtn) {
    e.stopPropagation();
    const pid   = cancelBtn.dataset.pendingId;
    const entry = pendingMessages.get(pid);
    if (entry) {
      entry.cancelled = true;
      if (entry.xhr) entry.xhr.abort();
      else removePendingBubble(pid);
    }
  } else if (retryBtn) {
    e.stopPropagation();
    const pid   = retryBtn.dataset.pendingId;
    const entry = pendingMessages.get(pid);
    if (entry) { entry.cancelled = false; startPendingUpload(pid); }
  } else if (removeBtn) {
    e.stopPropagation();
    removePendingBubble(removeBtn.dataset.pendingId);
  } else if (delBtn && postDiv) {
    e.stopPropagation();
    if (confirm('Delete this message?')) {
      const id = postDiv.dataset.id;
      await apiFetch(`/api/messages/${id}`, { method: 'DELETE' });
      postDiv.remove();
    }
  } else if (reportBtn && postDiv) {
    e.stopPropagation();
    showReportDialog(postDiv.dataset.id);
  } else if (replyBtn && postDiv) {
    if (isAdultObserver()) return;
    e.stopPropagation();
    setReply(postDiv.dataset.user, postDiv.dataset.text || getMediaReplyLabel(postDiv.dataset.imagepath, postDiv.dataset.mediatype), postDiv.dataset.id);
  } else if (chipEl && postDiv) {
    if (isObserverRole()) return;
    e.stopPropagation();
    const emoji = chipEl.dataset.emoji;
    const msgId = postDiv.dataset.id;
    if (chipEl.classList.contains('mine')) {
      await apiFetch(`/api/messages/${msgId}/react`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ emoji }),
      }).catch(() => {});
    } else {
      await apiFetch(`/api/messages/${msgId}/react`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ emoji }),
      }).catch(() => {});
    }
    loadMessages();
  } else if (quotedMsg) {
    e.stopPropagation();
    scrollToMessage(quotedMsg.dataset.replyid, quotedMsg);
  }
});

// ── Swipe to reply ────────────────────────────────────────────────────────────

let swipeTarget = null, startX = 0, currentX = 0, hapticTriggered = false;

postsContainer.addEventListener('touchstart', e => {
  if (isObserverRole()) return;
  const postDiv = e.target.closest('.post');
  if (!postDiv || postDiv.classList.contains('pending-msg')) return;
  swipeTarget = postDiv;
  startX      = e.touches[0].clientX;
  swipeTarget.style.transition = 'none';
}, { passive: true });

postsContainer.addEventListener('touchmove', e => {
  if (!swipeTarget) return;
  currentX    = e.touches[0].clientX;
  const diff  = currentX - startX;
  if (diff > 0) {
    const move = Math.min(diff, 80);
    swipeTarget.style.transform = `translateX(${move}px)`;
    if (move >= 60 && !hapticTriggered) {
      if (navigator.vibrate) navigator.vibrate(25);
      hapticTriggered = true;
      swipeTarget.classList.add('swiping-right');
    } else if (move < 60) {
      hapticTriggered = false;
      swipeTarget.classList.remove('swiping-right');
    }
  }
}, { passive: true });

postsContainer.addEventListener('touchend', () => {
  if (!swipeTarget) return;
  swipeTarget.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
  if (currentX - startX > 60) {
    setReply(
      swipeTarget.dataset.user,
      swipeTarget.dataset.text || getMediaReplyLabel(swipeTarget.dataset.imagepath, swipeTarget.dataset.mediatype),
      swipeTarget.dataset.id
    );
  }
  hapticTriggered = false;
  swipeTarget.style.transform = 'translateX(0)';
  swipeTarget.classList.remove('swiping-right');
  swipeTarget = null; startX = 0; currentX = 0;
});

// ── Long-press to open reaction picker (touch) ────────────────────────────────

postsContainer.addEventListener('touchstart', e => {
  const postDiv = e.target.closest('.post');
  if (!postDiv || postDiv.classList.contains('pending-msg')) return;
  if (e.target.closest('button, a, .chat-img, video, audio, .view-once')) return;
  lpTarget = postDiv;
  lpStartX = e.touches[0].clientX;
  lpStartY = e.touches[0].clientY;
  lpMoved  = false;
  lpTimer  = setTimeout(() => {
    lpTimer = null;
    if (!lpMoved && lpTarget) {
      if (navigator.vibrate) navigator.vibrate(40);
      showReactionPicker(lpTarget, lpStartX, lpStartY);
    }
    lpTarget = null;
  }, 500);
}, { passive: true });

postsContainer.addEventListener('touchmove', e => {
  if (!lpTimer && !lpTarget) return;
  const dx = e.touches[0].clientX - lpStartX;
  const dy = e.touches[0].clientY - lpStartY;
  if (Math.sqrt(dx * dx + dy * dy) > 10) {
    clearTimeout(lpTimer);
    lpTimer  = null;
    lpMoved  = true;
    lpTarget = null;
  }
}, { passive: true });

postsContainer.addEventListener('touchend', () => {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  lpTarget = null;
}, { passive: true });

postsContainer.addEventListener('touchcancel', () => {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  lpTarget = null;
}, { passive: true });

// ── Long-press to open reaction picker (mouse / desktop) ─────────────────────

postsContainer.addEventListener('mousedown', e => {
  if (isObserverRole()) return;
  if (e.button !== 0) return;
  const postDiv = e.target.closest('.post');
  if (!postDiv || postDiv.classList.contains('pending-msg')) return;
  if (e.target.closest('button, a, .chat-img, video, audio, .view-once')) return;
  lpTarget = postDiv;
  lpStartX = e.clientX;
  lpStartY = e.clientY;
  lpMoved  = false;
  lpTimer  = setTimeout(() => {
    lpTimer = null;
    if (!lpMoved && lpTarget) showReactionPicker(lpTarget, lpStartX, lpStartY);
    lpTarget = null;
  }, 500);
});

postsContainer.addEventListener('mousemove', e => {
  if (!lpTimer && !lpTarget) return;
  const dx = e.clientX - lpStartX;
  const dy = e.clientY - lpStartY;
  if (Math.sqrt(dx * dx + dy * dy) > 5) {
    clearTimeout(lpTimer); lpTimer = null; lpMoved = true; lpTarget = null;
  }
});

postsContainer.addEventListener('mouseup', () => {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  lpTarget = null;
});

// Prevent browser context menu on right-click over a message bubble
postsContainer.addEventListener('contextmenu', e => {
  const postDiv = e.target.closest('.post');
  if (postDiv && !e.target.closest('button, a, .chat-img, video, audio')) e.preventDefault();
});

// ── Reply helpers ─────────────────────────────────────────────────────────────

function setReply(username, text, id) {
  replyingTo = { user: username, text, id };
  document.getElementById('reply-info').textContent        = `Replying to ${username}`;
  document.getElementById('reply-text-preview').textContent = text;
  replyContainer.style.display = 'block';
  scheduleDraftSave();
  textInput.focus();
}

function cancelReply() {
  replyingTo = null;
  replyContainer.style.display = 'none';
  scheduleDraftSave();
}

// ── Input & preview ───────────────────────────────────────────────────────────

textInput.addEventListener('input', handleInput);
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && enterToSend) {
    e.preventDefault();
    if (!sendBtn.disabled) document.getElementById('postForm').requestSubmit();
  }
});

imageInput.addEventListener('change',  handleImageSelect);
cameraInput.addEventListener('change', handleImageSelect);
videoInput.addEventListener('change',  handleImageSelect);
document.getElementById('viewOnce').addEventListener('change', scheduleDraftSave);
document.getElementById('blurInput').addEventListener('change', scheduleDraftSave);

function handleInput() {
  if (isObserverRole()) return;
  updateComposerLayoutForText();
  updateButtonState();
  scheduleDraftSave();
  sendTypingStatus(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    sendTypingStatus(false);
  }, 4000);

}

function handleImageSelect(e) {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  const file = files[0];
  currentDraftId = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  clearOtherMediaInputs(e.target);
  renderMediaPreview(file);
  collapseAttachmentPicker();
  persistCurrentDraft();
}

function renderMediaPreview(file) {
  const selectedCount = getSelectedMediaFiles().length;
  const multipleFilesLabel = selectedCount > 1 ? `[ ${selectedCount} files selected ]` : '';

  if (previewAudio.src.startsWith('blob:')) URL.revokeObjectURL(previewAudio.src);
  previewAudio.pause();
  previewAudio.removeAttribute('src');
  previewAudio.load();

  if (isAudioFile(file)) {
    if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
    previewImg.style.display       = 'none';
    previewVideoText.style.display = 'block';
    previewVideoText.innerText     = '[ Voice message ]';
    previewAudio.src               = URL.createObjectURL(file);
    previewAudio.style.display     = 'block';
    previewContainer.style.display = 'flex';
    document.getElementById('blurInput').checked = false;
    scrollToBottom(true);
  } else if (isVideoFile(file)) {
    previewImg.style.display       = 'none';
    previewVideoText.style.display = 'block';
    previewVideoText.innerText     = multipleFilesLabel || '[ Video ]';
    previewAudio.style.display     = 'none';
    previewContainer.style.display = 'flex';
    scrollToBottom(true);
  } else {
    if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
    previewImg.src                 = URL.createObjectURL(file);
    previewImg.style.display       = 'block';
    previewVideoText.style.display = 'none';
    previewAudio.style.display     = 'none';
    previewContainer.style.display = 'flex';
    previewImg.onload = () => scrollToBottom(true);
  }
  if (selectedCount > 1 && !isVideoFile(file)) {
    previewVideoText.style.display = 'block';
    previewVideoText.innerText = multipleFilesLabel;
  }
  updateButtonState();
}

function clearPreview(options = {}) {
  const { deleteDraft = true } = options;
  imageInput.value = '';
  cameraInput.value = '';
  videoInput.value  = '';
  restoredDraftFile = null;
  document.getElementById('viewOnce').checked  = false;
  document.getElementById('blurInput').checked = false;
  if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
  if (previewAudio.src.startsWith('blob:')) URL.revokeObjectURL(previewAudio.src);
  previewAudio.pause();
  previewAudio.removeAttribute('src');
  previewAudio.load();
  previewContainer.style.display = 'none';
  previewImg.src                 = '';
  previewImg.style.display       = 'block';
  previewVideoText.style.display = 'none';
  previewVideoText.innerText     = '[ Video ]';
  previewAudio.style.display     = 'none';
  document.getElementById('upload-progress-container').style.display = 'none';
  document.getElementById('upload-progress-bar').style.width = '0%';
  if (deleteDraft) deleteSavedDraft();
  updateButtonState();
  updateComposerLayoutForText();
}

function updateButtonState() {
  const hasText  = textInput.value.trim().length > 0;
  const selectedMediaFiles = getSelectedMediaFiles();
  const hasImage = selectedMediaFiles.length > 0;
  const allSelectedAudio = hasImage && selectedMediaFiles.every(file => isAudioFile(file));
  const canSend  = hasText || hasImage;
  sendBtn.disabled = !canSend;
  canSend ? sendBtn.classList.remove('is-disabled') : sendBtn.classList.add('is-disabled');
  const hasMedia = hasImage;
  const mediaControlsRow = document.getElementById('media-controls-row');
  const viewOnceLabel = document.getElementById('viewOnceLabel');
  const blurLabel = document.getElementById('blurLabel');
  const canViewOnce = hasMedia && appConfig.enableViewOnce !== false;
  const canBlur = hasMedia && selectedMediaFiles.some(file => !isAudioFile(file)) && appConfig.enableBlur !== false;
  const showMediaControls = canViewOnce || canBlur;
  previewContainer.classList.toggle('has-media-controls', showMediaControls);
  previewContainer.classList.toggle('can-view-once', canViewOnce);
  previewContainer.classList.toggle('can-blur', canBlur);
  if (mediaControlsRow) mediaControlsRow.removeAttribute('style');
  viewOnceLabel.removeAttribute('style');
  viewOnceLabel.title = allSelectedAudio ? 'Listen Once' : 'View Once';
  const viewOnceIcon = viewOnceLabel.querySelector('.media-toggle-icon');
  if (viewOnceIcon) viewOnceIcon.textContent = allSelectedAudio ? '👂' : '👁️';
  blurLabel.removeAttribute('style');
}

function showAttachments(e) {
  if (e) e.preventDefault();
  if (getSelectedMediaFile()) {
    collapseAttachmentPicker();
    textInput.focus();
    return;
  }
  expandAttachmentPicker();
  textInput.focus();
}

function getLocationErrorMessage(error) {
  if (error && error.code === error.PERMISSION_DENIED) return 'Location permission was denied.';
  if (error && error.code === error.POSITION_UNAVAILABLE) return 'Location is currently unavailable.';
  if (error && error.code === error.TIMEOUT) return 'Location request timed out.';
  return 'Unable to get location.';
}

function createGoogleMapsLocationUrl(latitude, longitude) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(latitude + ',' + longitude);
}

function shareCurrentLocation() {
  if (isObserverRole()) return;

  const locationBtn = document.getElementById('share-location-btn');
  collapseAttachmentPicker();

  if (!navigator.geolocation) {
    alert('Location is not available in this browser.');
    return;
  }

  if (locationBtn) {
    locationBtn.disabled = true;
    locationBtn.textContent = '...';
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      const latitude = Number(position.coords.latitude.toFixed(6));
      const longitude = Number(position.coords.longitude.toFixed(6));
      const mapsUrl = createGoogleMapsLocationUrl(latitude, longitude);
      sendLocationMessage(mapsUrl).finally(() => {
        if (locationBtn) {
          locationBtn.disabled = false;
          locationBtn.textContent = '📍';
        }
      });
    },
    error => {
      alert(getLocationErrorMessage(error));
      if (locationBtn) {
        locationBtn.disabled = false;
        locationBtn.textContent = '📍';
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}

async function sendLocationMessage(mapsUrl) {
  const submittedAt = Date.now();
  const pendingId = 'p-' + (crypto.randomUUID ? crypto.randomUUID() : `${submittedAt}-${Math.random().toString(36).slice(2)}`);
  const bubbleEl = createPendingBubble(pendingId, mapsUrl, null, null);
  const formData = new FormData();
  formData.append('text', mapsUrl);
  formData.append('viewOnce', 'false');
  formData.append('isBlurred', 'false');
  formData.append('submittedAt', String(submittedAt));
  pendingMessages.set(pendingId, { bubbleEl, formData, xhr: null, cancelled: false, submittedDraftId: null });
  startPendingUpload(pendingId);
}

async function sendTypingStatus(status) {
  if (isObserverRole()) return;
  await apiFetch('/api/typing', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ isTyping: status }),
  }).catch(() => {});
}

// ── Image / video overlay ─────────────────────────────────────────────────────

function showImagePopup(filePath) {
  const vid    = document.getElementById('overlayVideo');
  const isVideo= /\.(mp4|webm|mkv|mov)$/i.test(filePath);
  if (isVideo) {
    overlayImg.style.display = 'none';
    vid.style.display = 'block';
    vid.src = filePath;
    vid.play();
  } else {
    vid.style.display = 'none';
    vid.pause();
    overlayImg.style.display = 'block';
    overlayImg.src = filePath;
  }
  overlay.style.display = 'flex';
  history.pushState({ overlayOpen: true }, '');
}

function closeImagePopup() {
  overlay.style.display = 'none';
  overlayImg.src        = '';
  const vid = document.getElementById('overlayVideo');
  vid.pause();
  vid.src = '';
  if (history.state && history.state.overlayOpen) history.back();
}

async function openViewOnce(id) {
  const btn = document.getElementById(`view-once-${id}`);
  if (btn && !isAdultObserver()) btn.onclick = null;
  const res  = await apiFetch(`/api/messages/${id}/view`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    const mediaType = getMediaTypeFromPath(data.imagePath, data.mediaType || btn?.dataset.mediaType);
    if (mediaType === 'audio' && btn) {
      btn.className = 'view-once';
      btn.innerHTML = `<div class="voice-note-label">Listen once</div><audio src="${data.imagePath}" class="chat-audio" controls autoplay controlsList="nodownload" preload="metadata" oncontextmenu="return false"></audio>`;
      const audio = btn.querySelector('audio');
      if (audio) audio.addEventListener('ended', () => loadMessages(), { once: true });
    } else {
      showImagePopup(data.imagePath);
      loadMessages();
    }
  } else if (btn && isAdultObserver()) {
    btn.onclick = () => openViewOnce(id);
  }
}

window.addEventListener('popstate', () => {
  const recOverlay = document.getElementById('videoRecorderOverlay');
  if (recOverlay?.style.display === 'flex') { closeRecorder({ fromHistory: true }); return; }
  if (overlay.style.display === 'flex') { closeImagePopup(); return; }
  if (pendingMessages.size > 0) {
    history.pushState(null, '');
    showUploadWarning();
  }
});

window.addEventListener('beforeunload', e => {
  if (pendingMessages.size > 0) { e.preventDefault(); e.returnValue = ''; }
});

// ── Settings panel ────────────────────────────────────────────────────────────

function toggleSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

document.addEventListener('click', e => {
  const panel  = document.getElementById('settings-panel');
  const setBtn = document.getElementById('settings-btn');
  if (panel && panel.style.display === 'block' &&
      !panel.contains(e.target) && e.target !== setBtn && !setBtn.contains(e.target)) {
    panel.style.display = 'none';
  }

  // Dismiss reaction picker on outside click
  const picker = document.getElementById('reaction-picker');
  if (picker && picker.classList.contains('visible')) {
    if (suppressPickerDismiss) {
      suppressPickerDismiss = false;
      return;
    }
    if (!picker.contains(e.target)) {
      picker.classList.remove('visible');
      reactionPickerTarget = null;
    }
  }
});

// ── Reaction picker ───────────────────────────────────────────────────────────

function showReactionPicker(postEl, clientX, clientY) {
  if (isObserverRole()) return;
  const picker = document.getElementById('reaction-picker');
  if (!picker) return;

  reactionPickerTarget  = postEl;
  suppressPickerDismiss = true;

  // Position picker above the touch/click point, centered horizontally on cursor
  const pickerW = 320;
  const pickerH = 64;
  let left = clientX - pickerW / 2;
  let top  = clientY - pickerH - 12;

  // Clamp to viewport
  left = Math.max(8, Math.min(left, window.innerWidth  - pickerW - 8));
  if (top < 8) top = clientY + 16;

  picker.style.left = left + 'px';
  picker.style.top  = top  + 'px';
  picker.classList.add('visible');
}

document.getElementById('reaction-picker').addEventListener('click', async e => {
  if (isObserverRole()) return;
  const emojiEl = e.target.closest('.reaction-picker-emoji');
  if (!emojiEl || !reactionPickerTarget) return;

  const emoji = emojiEl.dataset.emoji;
  const msgId = reactionPickerTarget.dataset.id;
  const picker = document.getElementById('reaction-picker');
  picker.classList.remove('visible');
  reactionPickerTarget    = null;
  suppressPickerDismiss   = false;

  // Check if this user already reacted with this emoji (toggle off) or switch/add
  const strip = document.querySelector(`.post[data-id="${CSS.escape(msgId)}"] .reaction-strip`);
  const existingChip = strip
    ? strip.querySelector(`.reaction-chip.mine[data-emoji="${CSS.escape(emoji)}"]`)
    : null;

  if (existingChip) {
    // Remove the reaction
    await apiFetch(`/api/messages/${msgId}/react`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ emoji }),
    }).catch(() => {});
  } else {
    await apiFetch(`/api/messages/${msgId}/react`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ emoji }),
    }).catch(() => {});
  }
  loadMessages();
});

function applyColourScheme(name, save = true) {
  const availableSchemes = getAvailableColourSchemeIds();
  const schemeName = availableSchemes.includes(name) ? name : availableSchemes[0];
  const scheme = COLOUR_SCHEMES[schemeName] || COLOUR_SCHEMES.default;
  const root   = document.documentElement;
  root.style.setProperty('--color-bg',      scheme.bg);
  root.style.setProperty('--color-mine',    scheme.mine);
  root.style.setProperty('--color-theirs',  scheme.theirs);
  root.style.setProperty('--color-surface', scheme.surface);
  document.querySelectorAll('.colour-scheme-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.scheme === schemeName));
  if (save) {
    apiFetch('/api/preferences', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ scheme: schemeName }),
    }).catch(e => console.warn('[prefs] save failed:', e.message));
  }
}

function applyFontSize(size, save = true) {
  const px = Math.min(24, Math.max(11, Math.round(size)));
  document.documentElement.style.setProperty('--chat-font-size', px + 'px');
  const slider = document.getElementById('font-size-slider');
  if (slider) slider.value = String(px);
  if (save) {
    apiFetch('/api/preferences', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fontSize: px }),
    }).catch(e => console.warn('[prefs] save failed:', e.message));
  }
}

function toggleEnterToSend(enabled) {
  if (isAdultObserver()) return;
  enterToSend = enabled;
  apiFetch('/api/preferences', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ enterToSend: enabled }),
  }).catch(e => {
    console.warn('[prefs] save failed:', e.message);
    enterToSend = !enabled;
    const toggle = document.getElementById('enter-to-send-toggle');
    if (toggle) toggle.checked = enterToSend;
  });
}

// ── Change password (in-app dialog) ──────────────────────────────────────────

function showChangePasswordDialog() {
  document.getElementById('settings-panel').style.display = 'none';
  const overlay = document.getElementById('change-password-overlay');
  overlay.style.display = 'flex';
  document.getElementById('cp-current').value  = '';
  document.getElementById('cp-new').value      = '';
  document.getElementById('cp-confirm').value  = '';
  document.getElementById('cp-inline-error').textContent = '';
  document.getElementById('cp-current').focus();
}

function hideChangePasswordDialog() {
  document.getElementById('change-password-overlay').style.display = 'none';
}

function showPrivacyPolicy() {
  if (!isAdultObserver()) return;
  const overlay = document.getElementById('privacy-policy-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function hidePrivacyPolicy() {
  const overlay = document.getElementById('privacy-policy-overlay');
  if (overlay) overlay.style.display = 'none';
}

function showReportDialog(messageId) {
  reportingMessageId = messageId;
  const overlay = document.getElementById('report-message-overlay');
  const input = document.getElementById('report-reason-input');
  const error = document.getElementById('report-message-error');
  if (input) input.value = '';
  if (error) error.textContent = '';
  if (overlay) overlay.style.display = 'flex';
  setTimeout(() => input?.focus(), 0);
}

function hideReportDialog() {
  reportingMessageId = null;
  const overlay = document.getElementById('report-message-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function submitReportDialog() {
  if (!reportingMessageId) return;
  const input = document.getElementById('report-reason-input');
  const error = document.getElementById('report-message-error');
  const reason = input?.value.trim() || '';

  const res = await apiFetch(`/api/messages/${reportingMessageId}/report`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (error) error.textContent = data.error || 'Could not send this report.';
    return;
  }

  hideReportDialog();
  await loadMessages();
}

document.getElementById('privacy-policy-overlay')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) hidePrivacyPolicy();
});

document.getElementById('report-message-overlay')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) hideReportDialog();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hidePrivacyPolicy();
  if (e.key === 'Escape') hideReportDialog();
});

async function submitChangePassword() {
  const current  = document.getElementById('cp-current').value;
  const np       = document.getElementById('cp-new').value;
  const confirm  = document.getElementById('cp-confirm').value;
  const errorEl  = document.getElementById('cp-inline-error');

  if (np !== confirm)    { errorEl.textContent = 'Passwords do not match.';          return; }
  if (np.length < 8)     { errorEl.textContent = 'Password must be at least 8 chars.'; return; }

  try {
    const res  = await apiFetch('/api/auth/change-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ currentPassword: current, newPassword: np }),
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Failed.'; return; }
    hideChangePasswordDialog();
    alert('Password changed successfully.');
  } catch {
    errorEl.textContent = 'Connection error.';
  }
}

// ── Emergency exit ────────────────────────────────────────────────────────────

function activateEmergencyExit() {
  document.getElementById('header-title').addEventListener('click', emergencyExitNow);
}

function emergencyExitNow() {
  // Invalidate the session server-side before navigating away.
  // keepalive ensures the request completes even as the page unloads.
  fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {});
  document.body.style.backgroundColor = '#ffffff';
  document.body.innerHTML = '';
  window.location.href = 'https://www.google.com/search?q=cromer+weather+forecast';
}

// ── Upload warning overlay ────────────────────────────────────────────────────

function showUploadWarning() {
  const ov     = document.getElementById('upload-warning-overlay');
  const exitBtn= document.getElementById('upload-warning-exit-btn');
  if (exitBtn) exitBtn.style.display = appConfig.enableEmergencyExit ? 'block' : 'none';
  if (ov) ov.style.display = 'flex';
}
function hideUploadWarning() {
  const ov = document.getElementById('upload-warning-overlay');
  if (ov) ov.style.display = 'none';
}

// ── Scroll helpers ────────────────────────────────────────────────────────────

function scrollToBottom(instant = false) {
  window.scrollTo({ top: document.body.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  prompt.style.display = 'none';
}

window.addEventListener('scroll', () => {
  const isFar = (window.innerHeight + window.scrollY) < document.body.offsetHeight - 500;
  jumpBtn.style.display = isFar ? 'flex' : 'none';
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const dist = document.body.scrollHeight - (window.scrollY + window.innerHeight);
    if (dist < 300) scrollToBottom(true);
  });
} else {
  window.addEventListener('resize', () => {
    if ((document.body.scrollHeight - (window.scrollY + window.innerHeight)) < 300) scrollToBottom(true);
  });
}

// ── In-app video recorder ─────────────────────────────────────────────────────

let mediaRecorder    = null;
let recordedChunks   = [];
let recStream        = null;
let recordingInterval= null;
let currentFacingMode= 'user';
let audioRecorder    = null;
let audioChunks      = [];
let audioStream      = null;
let audioTimer       = null;
let audioSeconds     = 0;
let audioRecordingMimeType = '';
let audioRecordingActive = false;
let audioRecorderMode = 'wav';
let audioContext     = null;
let audioSourceNode  = null;
let audioProcessorNode = null;
let audioWorkletNode = null;
let audioSilenceNode = null;
let audioSampleRate  = 0;
let audioFramesRecorded = 0;
let audioRecordingStartedAt = 0;
let audioRecordingStopRequestedAt = 0;
let audioStopTimeout = null;
let audioRecordingStartedPerformance = 0;
let audioRecordingStoppedPerformance = 0;
let audioRecordingFinalizing = false;
let audioTrack = null;
let audioMonitorContext = null;
let audioMonitorContextOwned = false;
let audioMonitorSourceNode = null;
let audioAnalyserNode = null;
let audioMonitorAnimationFrame = null;
let audioMonitorBuffer = null;
let audioLevelHistory = [];
let audioLastLevelRenderedAt = 0;
let audioLastInputAt = 0;
let audioInputDetected = false;
let audioCaptureIssue = '';
let audioRecordingDiagnostics = null;
let audioVisibilityListener = null;
let audioWindowBlurListener = null;
let audioWindowFocusListener = null;
let audioDeviceChangeListener = null;
let audioRefreshWasRunning = false;

function initMediaRecorder() {
  const options = {
    audioBitsPerSecond: VIDEO_RECORDING_TARGET.audioBitsPerSecond,
    videoBitsPerSecond: VIDEO_RECORDING_TARGET.videoBitsPerSecond,
  };
  if (MediaRecorder.isTypeSupported('video/mp4'))               options.mimeType = 'video/mp4';
  else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) options.mimeType = 'video/webm;codecs=vp9';
  else if (MediaRecorder.isTypeSupported('video/webm'))         options.mimeType = 'video/webm';
  mediaRecorder = new MediaRecorder(recStream, options);
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
}

async function openRecorder() {
  const recOverlay = document.getElementById('videoRecorderOverlay');
  const video      = document.getElementById('livePreview');
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: currentFacingMode,
        width: { ideal: VIDEO_RECORDING_TARGET.width },
        height: { ideal: VIDEO_RECORDING_TARGET.height },
        frameRate: { ideal: VIDEO_RECORDING_TARGET.fps, max: Math.max(30, VIDEO_RECORDING_TARGET.fps) },
      },
    });
    video.srcObject = recStream;
    video.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
    recOverlay.style.display = 'flex';
    history.pushState({ recorderOpen: true }, '');
    recordedChunks = [];
    initMediaRecorder();
    document.getElementById('recordBtn').style.display   = 'block';
    document.getElementById('sendVideoBtn').style.display = 'none';
  } catch (err) {
    alert('Camera access denied or not supported.');
    console.error(err);
  }
}

async function flipCamera() {
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  if (recStream) recStream.getTracks().forEach(t => t.stop());
  const video = document.getElementById('livePreview');
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: currentFacingMode,
        width: { ideal: VIDEO_RECORDING_TARGET.width },
        height: { ideal: VIDEO_RECORDING_TARGET.height },
        frameRate: { ideal: VIDEO_RECORDING_TARGET.fps, max: Math.max(30, VIDEO_RECORDING_TARGET.fps) },
      },
    });
    video.srcObject       = recStream;
    video.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
    recordedChunks = [];
    initMediaRecorder();
  } catch (err) {
    alert('Could not flip camera.');
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  }
}

function toggleRecording() {
  const btn   = document.getElementById('recordBtn');
  const timer = document.getElementById('recordingTimer');
  if (mediaRecorder.state === 'inactive') {
    mediaRecorder.start();
    btn.style.backgroundColor = 'white';
    btn.style.border          = '4px solid red';
    timer.style.display       = 'block';
    let sec = 0;
    recordingInterval = setInterval(() => {
      sec++;
      timer.innerText = `🔴 00:${sec < 10 ? '0' + sec : sec}`;
      if (sec >= 60) { toggleRecording(); timer.innerText = 'Max Time (1:00)'; }
    }, 1000);
  } else {
    mediaRecorder.stop();
    btn.style.display = 'none';
    document.getElementById('sendVideoBtn').style.display = 'block';
    clearInterval(recordingInterval);
    timer.innerText = 'Video Ready';
  }
}

function finishRecording() {
  if (recordedChunks.length === 0) { alert('No video recorded!'); return; }
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  const rawType   = mediaRecorder.mimeType || 'video/webm';
  const cleanType = rawType.split(';')[0];
  const ext       = cleanType === 'video/mp4' ? '.mp4' : '.webm';
  const blob      = new Blob(recordedChunks, { type: cleanType });
  const filename  = `capture_${Date.now()}${ext}`;
  const file      = new File([blob], filename, { type: cleanType });
  file.isOptimized = true;
  const dt = new DataTransfer();
  dt.items.add(file);
  imageInput.files = dt.files;
  handleImageSelect({ target: imageInput });
  closeRecorder();
}

function closeRecorder(options = {}) {
  const { fromHistory = false } = options;
  document.getElementById('videoRecorderOverlay').style.display = 'none';
  if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
  mediaRecorder     = null;
  recordedChunks    = [];
  clearInterval(recordingInterval);
  recordingInterval = null;
  const timer       = document.getElementById('recordingTimer');
  timer.style.display = 'none';
  timer.innerText   = '🔴 00:00';
  document.getElementById('recordBtn').style.display    = 'block';
  document.getElementById('sendVideoBtn').style.display = 'none';
  if (!fromHistory && history.state?.recorderOpen) history.back();
}

// ── In-app audio recorder ─────────────────────────────────────────────────────

function getSupportedAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const preferred = AUDIO_UPLOAD_TARGET.format;
  const candidates = preferred === 'aac'
    ? [
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
      ]
    : preferred === 'opus'
      ? [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/ogg',
        ]
      : [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/ogg',
          'audio/mp4;codecs=mp4a.40.2',
          'audio/mp4',
        ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getRecordedAudioExtension(mimeType) {
  const type = (mimeType || '').toLowerCase();
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mp4')) return '.m4a';
  if (type.includes('mpeg')) return '.mp3';
  if (type.includes('wav')) return '.wav';
  return '.weba';
}

function formatAudioSeconds(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' + secs : secs}`;
}

function setAudioRecorderUi(recording) {
  document.getElementById('audio-record-start-btn').style.display = recording ? 'none' : 'inline-block';
  document.getElementById('audio-record-stop-btn').style.display  = recording ? 'inline-block' : 'none';
}

function setAudioLevelStatus(text, state = '') {
  const status = document.getElementById('audio-level-status');
  if (!status) return;
  status.textContent = text;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function drawAudioWaveform() {
  const canvas = document.getElementById('audio-waveform');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = 'rgba(255,255,255,0.16)';
  context.lineWidth = scale;
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();

  if (!audioLevelHistory.length) return;
  const barWidth = width / AUDIO_LEVEL_HISTORY_SIZE;
  context.fillStyle = audioCaptureIssue ? '#e36b6b' : '#65d58a';
  audioLevelHistory.forEach((level, index) => {
    const barHeight = Math.max(scale, level * (height - 4 * scale));
    context.fillRect(index * barWidth, (height - barHeight) / 2, Math.max(scale, barWidth - scale), barHeight);
  });
}

function resetAudioWaveform() {
  audioLevelHistory = [];
  audioLastLevelRenderedAt = 0;
  audioLastInputAt = 0;
  audioInputDetected = false;
  audioCaptureIssue = '';
  setAudioLevelStatus('Listening...');
  drawAudioWaveform();
}

function getAudioDiagnosticElapsedMs() {
  if (!audioRecordingStartedPerformance) return 0;
  return Math.round(performance.now() - audioRecordingStartedPerformance);
}

function recordAudioDiagnosticEvent(type, detail = {}) {
  if (!audioRecordingDiagnostics) return;
  audioRecordingDiagnostics.events.push({
    type,
    elapsedMs: getAudioDiagnosticElapsedMs(),
    ...detail,
  });
}

function getSafeAudioTrackSettings(track) {
  const settings = track?.getSettings?.() || {};
  const keys = [
    'sampleRate', 'sampleSize', 'channelCount', 'latency',
    'echoCancellation', 'noiseSuppression', 'autoGainControl',
  ];
  return Object.fromEntries(keys.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
}

function beginAudioDiagnostics(mode, mimeType) {
  const requestedConstraints = getAudioCaptureConstraints();
  audioRecordingDiagnostics = {
    startedAt: new Date().toISOString(),
    mode,
    mimeType,
    requested: requestedConstraints === true
      ? { browserDefaults: true }
      : { ...requestedConstraints },
    trackSettings: getSafeAudioTrackSettings(audioTrack),
    chunks: [],
    monitorReads: 0,
    activeLevelReads: 0,
    peak: 0,
    messageRefreshPaused: audioRefreshWasRunning,
    events: [],
  };
  window.__lastAudioRecordingDiagnostics = audioRecordingDiagnostics;
  recordAudioDiagnosticEvent('recording-started', {
    pageVisible: !document.hidden,
    trackState: audioTrack?.readyState || 'unknown',
  });

  audioVisibilityListener = () => {
    recordAudioDiagnosticEvent('visibility-changed', { hidden: document.hidden });
  };
  audioWindowBlurListener = () => recordAudioDiagnosticEvent('window-blurred');
  audioWindowFocusListener = () => recordAudioDiagnosticEvent('window-focused');
  audioDeviceChangeListener = () => recordAudioDiagnosticEvent('audio-devices-changed');
  document.addEventListener('visibilitychange', audioVisibilityListener);
  window.addEventListener('blur', audioWindowBlurListener);
  window.addEventListener('focus', audioWindowFocusListener);
  navigator.mediaDevices?.addEventListener?.('devicechange', audioDeviceChangeListener);
}

function pauseMessageRefreshForAudioRecording() {
  audioRefreshWasRunning = refreshTimer !== null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function resumeMessageRefreshAfterAudioRecording() {
  if (audioRefreshWasRunning && !refreshTimer && currentUser) {
    refreshTimer = setInterval(loadMessages, 2000);
  }
  audioRefreshWasRunning = false;
}

function finishAudioDiagnostics(outcome, detail = {}) {
  if (!audioRecordingDiagnostics) return;
  audioRecordingDiagnostics.outcome = outcome;
  audioRecordingDiagnostics.finishedAt = new Date().toISOString();
  audioRecordingDiagnostics.elapsedMs = Math.round(
    (audioRecordingStoppedPerformance || performance.now()) - audioRecordingStartedPerformance,
  );
  Object.assign(audioRecordingDiagnostics, detail);
  window.__lastAudioRecordingDiagnostics = audioRecordingDiagnostics;
  console.info('[audio-recorder] diagnostics', audioRecordingDiagnostics);
}

function attachAudioTrackDiagnostics() {
  audioTrack = audioStream?.getAudioTracks?.()[0] || null;
  if (!audioTrack) return;
  audioTrack.onmute = () => {
    audioCaptureIssue = 'Microphone interrupted';
    setAudioLevelStatus(audioCaptureIssue, 'error');
    recordAudioDiagnosticEvent('track-muted');
    drawAudioWaveform();
  };
  audioTrack.onunmute = () => {
    audioCaptureIssue = '';
    setAudioLevelStatus('Listening...');
    recordAudioDiagnosticEvent('track-unmuted');
  };
  audioTrack.onended = () => {
    audioCaptureIssue = 'Microphone disconnected';
    setAudioLevelStatus(audioCaptureIssue, 'error');
    recordAudioDiagnosticEvent('track-ended');
    drawAudioWaveform();
  };
}

function stopAudioInputTracks() {
  if (audioTrack) {
    audioTrack.onmute = null;
    audioTrack.onunmute = null;
    audioTrack.onended = null;
  }
  if (audioStream) audioStream.getTracks().forEach(track => track.stop());
}

function processAudioLevelSamples(samples) {
  if (!samples?.length || !audioRecordingActive) return;
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  const now = performance.now();
  if (audioRecordingDiagnostics) {
    audioRecordingDiagnostics.monitorReads++;
    audioRecordingDiagnostics.peak = Math.max(audioRecordingDiagnostics.peak, peak);
    if (rms >= AUDIO_LEVEL_ACTIVE_RMS) audioRecordingDiagnostics.activeLevelReads++;
  }
  if (rms >= AUDIO_LEVEL_ACTIVE_RMS) {
    audioInputDetected = true;
    audioLastInputAt = now;
  }
  if (now - audioLastLevelRenderedAt < 40) return;
  audioLastLevelRenderedAt = now;
  const decibels = rms > 0 ? 20 * Math.log10(rms) : -80;
  const displayLevel = Math.max(0.015, Math.min(1, (decibels + 60) / 48));
  audioLevelHistory.push(displayLevel);
  if (audioLevelHistory.length > AUDIO_LEVEL_HISTORY_SIZE) audioLevelHistory.shift();
  drawAudioWaveform();
}

function updateAudioCaptureHealth() {
  if (!audioRecordingActive || audioRecordingFinalizing) return;
  if (audioCaptureIssue) {
    setAudioLevelStatus(audioCaptureIssue, 'error');
    return;
  }
  const now = performance.now();
  const elapsed = now - audioRecordingStartedPerformance;
  const inputRecentlyActive = audioLastInputAt && now - audioLastInputAt < AUDIO_LEVEL_WARNING_DELAY_MS;
  if (inputRecentlyActive) setAudioLevelStatus('Input detected', 'active');
  else if (elapsed >= AUDIO_LEVEL_WARNING_DELAY_MS) setAudioLevelStatus('No input detected', 'warning');
  else setAudioLevelStatus('Listening...');
}

async function startAudioLevelMonitor(stream, context = null, sourceNode = null) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    setAudioLevelStatus('Level unavailable', 'warning');
    recordAudioDiagnosticEvent('monitor-unavailable');
    return;
  }
  try {
    audioMonitorContext = context || new AudioContextCtor();
    audioMonitorContextOwned = !context;
    audioMonitorContext.onstatechange = () => {
      recordAudioDiagnosticEvent('monitor-state-changed', { state: audioMonitorContext?.state || 'closed' });
    };
    if (audioMonitorContext.state === 'suspended') await audioMonitorContext.resume();
    audioMonitorSourceNode = sourceNode || audioMonitorContext.createMediaStreamSource(stream);
    audioAnalyserNode = audioMonitorContext.createAnalyser();
    audioAnalyserNode.fftSize = 1024;
    audioAnalyserNode.smoothingTimeConstant = 0.35;
    audioMonitorSourceNode.connect(audioAnalyserNode);
    audioMonitorBuffer = new Float32Array(audioAnalyserNode.fftSize);

    const sampleLevel = () => {
      if (!audioAnalyserNode || !audioRecordingActive) return;
      audioAnalyserNode.getFloatTimeDomainData(audioMonitorBuffer);
      processAudioLevelSamples(audioMonitorBuffer);
      audioMonitorAnimationFrame = requestAnimationFrame(sampleLevel);
    };
    sampleLevel();
    recordAudioDiagnosticEvent('monitor-started', { sampleRate: audioMonitorContext.sampleRate });
  } catch (err) {
    setAudioLevelStatus('Level unavailable', 'warning');
    recordAudioDiagnosticEvent('monitor-failed', { message: getErrorMessage(err) });
    console.warn('[audio-recorder] level monitor unavailable', err);
  }
}

function stopAudioLevelMonitor() {
  if (audioMonitorAnimationFrame !== null) cancelAnimationFrame(audioMonitorAnimationFrame);
  audioMonitorAnimationFrame = null;
  disconnectAudioNode(audioAnalyserNode);
  audioAnalyserNode = null;
  if (audioMonitorContextOwned) disconnectAudioNode(audioMonitorSourceNode);
  audioMonitorSourceNode = null;
  audioMonitorBuffer = null;
  if (audioMonitorContext) audioMonitorContext.onstatechange = null;
  if (audioMonitorContextOwned && audioMonitorContext) audioMonitorContext.close().catch(() => {});
  audioMonitorContext = null;
  audioMonitorContextOwned = false;
}

function getAudioCaptureConstraints() {
  if (AUDIO_RECORDING_USE_BROWSER_DEFAULTS) return true;
  return {
    channelCount: 1,
    sampleRate: { ideal: AUDIO_RECORDING_TARGET.sampleRate },
    echoCancellation: AUDIO_RECORDING_TARGET.echoCancellation,
    noiseSuppression: AUDIO_RECORDING_TARGET.noiseSuppression,
    autoGainControl: AUDIO_RECORDING_TARGET.autoGainControl,
  };
}

function parseAudioBitsPerSecond() {
  const kbps = parseInt(String(AUDIO_UPLOAD_TARGET.bitrate).replace(/\D/g, ''), 10);
  return (Number.isFinite(kbps) ? kbps : 64) * 1000;
}

function startAudioRecordingClock() {
  document.getElementById('audio-recorder-bar').style.display = 'flex';
  document.getElementById('audio-recorder-status').textContent = 'Recording 0:00';
  setAudioRecorderUi(true);
  clearInterval(audioTimer);
  clearTimeout(audioStopTimeout);
  audioTimer = setInterval(() => {
    updateAudioRecordingStatus();
    updateAudioCaptureHealth();
  }, 250);
  audioStopTimeout = setTimeout(() => {
    document.getElementById('audio-recorder-status').textContent = `Max ${formatAudioSeconds(AUDIO_RECORDING_TARGET.maxSeconds)} reached`;
    stopAudioRecording();
  }, AUDIO_RECORDING_TARGET.maxSeconds * 1000);
}

function createWavBlob(chunks, sampleRate, totalFrames) {
  const channels = 1;
  const bytesPerSample = 2;
  const dataSize = totalFrames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;

  const writeString = value => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset++, value.charCodeAt(i));
  };
  const writeUint16 = value => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const writeUint32 = value => {
    view.setUint32(offset, value, true);
    offset += 4;
  };

  writeString('RIFF');
  writeUint32(36 + dataSize);
  writeString('WAVE');
  writeString('fmt ');
  writeUint32(16);
  writeUint16(1);
  writeUint16(channels);
  writeUint32(sampleRate);
  writeUint32(sampleRate * channels * bytesPerSample);
  writeUint16(channels * bytesPerSample);
  writeUint16(bytesPerSample * 8);
  writeString('data');
  writeUint32(dataSize);

  chunks.forEach(chunk => {
    for (let i = 0; i < chunk.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  });

  return new Blob([buffer], { type: 'audio/wav' });
}

async function decodeAudioBlob(blob) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextCtor();
  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    context.close().catch(() => {});
  }
}

function summarizeDecodedAudio(audioBuffer) {
  const channelData = audioBuffer.getChannelData(0);
  const windowFrames = Math.max(1, Math.round(audioBuffer.sampleRate * 0.02));
  let activeWindows = 0;
  let totalWindows = 0;
  let lastActiveFrame = 0;
  let peak = 0;
  for (let start = 0; start < channelData.length; start += windowFrames) {
    const end = Math.min(channelData.length, start + windowFrames);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const value = channelData[i];
      sumSquares += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    if (rms >= AUDIO_LEVEL_ACTIVE_RMS) {
      activeWindows++;
      lastActiveFrame = end;
    }
    totalWindows++;
  }
  return {
    durationSeconds: audioBuffer.duration,
    activeRatio: totalWindows ? activeWindows / totalWindows : 0,
    trailingSilenceSeconds: Math.max(0, (audioBuffer.length - lastActiveFrame) / audioBuffer.sampleRate),
    peak,
  };
}

function createWavFileFromAudioBuffer(audioBuffer) {
  const frames = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(frames);
  for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    for (let i = 0; i < frames; i++) mono[i] += channelData[i] / channels;
  }
  const wavBlob = createWavBlob([mono], audioBuffer.sampleRate, frames);
  const file = new File([wavBlob], `voice_${Date.now()}.wav`, { type: 'audio/wav' });
  file.isOptimized = true;
  return file;
}

function validateDecodedAudioDuration(decodedSeconds) {
  const stoppedAt = audioRecordingStoppedPerformance || performance.now();
  if (!audioRecordingStartedPerformance || !decodedSeconds) return;
  const expectedSeconds = Math.max(0, (stoppedAt - audioRecordingStartedPerformance) / 1000);
  const toleranceSeconds = Math.max(0.5, expectedSeconds * 0.1);
  if (expectedSeconds >= 2 && decodedSeconds < expectedSeconds - toleranceSeconds) {
    throw new Error(`Recorded audio is truncated (${decodedSeconds.toFixed(1)}s captured from ${expectedSeconds.toFixed(1)}s recorded).`);
  }
}

function getAudioRecordingElapsedSeconds() {
  if (!audioRecordingStartedAt) return audioSeconds;
  return Math.min(
    AUDIO_RECORDING_TARGET.maxSeconds,
    Math.floor((Date.now() - audioRecordingStartedAt) / 1000),
  );
}

function updateAudioRecordingStatus(prefix = 'Recording') {
  audioSeconds = getAudioRecordingElapsedSeconds();
  document.getElementById('audio-recorder-status').textContent =
    `${prefix} ${formatAudioSeconds(audioSeconds)}`;
}

function appendAudioSamples(input) {
  if (!audioRecordingActive || !input?.length) return;
  if (audioFramesRecorded === 0) {
    recordAudioDiagnosticEvent('first-pcm-block', { frames: input.length });
  }
  audioChunks.push(new Float32Array(input));
  audioFramesRecorded += input.length;
  processAudioLevelSamples(input);
}

function disconnectAudioNode(node) {
  try {
    node?.disconnect();
  } catch {
    // Some browsers throw when a node was never fully connected.
  }
}

async function createAudioCaptureNode(context) {
  if (!AUDIO_RECORDING_FORCE_SCRIPT_PROCESSOR &&
      context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      await context.audioWorklet.addModule('/audio-recorder-worklet.js');
      audioWorkletNode = new AudioWorkletNode(context, 'tls-audio-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      audioWorkletNode.port.onmessage = event => appendAudioSamples(new Float32Array(event.data));
      return audioWorkletNode;
    } catch (err) {
      console.warn('[audio-recorder] AudioWorklet unavailable; using ScriptProcessor fallback', err);
      audioWorkletNode = null;
    }
  }

  audioProcessorNode = context.createScriptProcessor(4096, 1, 1);
  audioProcessorNode.onaudioprocess = event => appendAudioSamples(event.inputBuffer.getChannelData(0));
  return audioProcessorNode;
}

function openAudioRecorder() {
  if (isObserverRole()) return;
  document.getElementById('audio-recorder-bar').style.display = 'flex';
  document.getElementById('audio-recorder-status').textContent = 'Ready to record';
  resetAudioWaveform();
  setAudioLevelStatus('Microphone level');
  setAudioRecorderUi(false);
  collapseAttachmentPicker();
}

async function startNativeAudioRecording(mimeType) {
  audioStream = await navigator.mediaDevices.getUserMedia({ audio: getAudioCaptureConstraints() });
  attachAudioTrackDiagnostics();
  audioChunks = [];
  audioSeconds = 0;
  audioRecordingMimeType = mimeType;
  audioRecordingStartedAt = Date.now();
  audioRecordingStopRequestedAt = 0;
  audioRecordingStartedPerformance = performance.now();
  audioRecordingStoppedPerformance = 0;
  audioRecordingFinalizing = false;
  audioRecordingActive = true;
  audioRecorderMode = 'native';
  resetAudioWaveform();
  beginAudioDiagnostics('native', mimeType);

  const options = { mimeType, audioBitsPerSecond: parseAudioBitsPerSecond() };
  audioRecorder = new MediaRecorder(audioStream, options);
  audioRecorder.ondataavailable = event => {
    recordAudioDiagnosticEvent('data-available', {
      bytes: event.data?.size || 0,
      timecode: Number.isFinite(event.timecode) ? Math.round(event.timecode) : null,
    });
    if (event.data?.size > 0) {
      audioChunks.push(event.data);
      audioRecordingDiagnostics?.chunks.push({
        elapsedMs: getAudioDiagnosticElapsedMs(),
        bytes: event.data.size,
        timecode: Number.isFinite(event.timecode) ? Math.round(event.timecode) : null,
      });
    }
  };
  audioRecorder.onstop = () => {
    recordAudioDiagnosticEvent('recorder-stopped', { chunks: audioChunks.length });
    stopAudioInputTracks();
    setTimeout(() => { finishNativeAudioRecording(); }, 0);
  };
  audioRecorder.onerror = event => {
    const message = getErrorMessage(event.error || event);
    recordAudioDiagnosticEvent('recorder-error', { message });
    finishAudioDiagnostics('error', { error: message });
    alert(`Audio recording failed: ${message}`);
    cleanupAudioRecorder();
  };
  audioRecorder.onpause = () => recordAudioDiagnosticEvent('recorder-paused');
  audioRecorder.onresume = () => recordAudioDiagnosticEvent('recorder-resumed');
  audioRecorder.start();
  recordAudioDiagnosticEvent('recorder-running', { state: audioRecorder.state });
  startAudioRecordingClock();
  startAudioLevelMonitor(audioStream);
}

async function finishNativeAudioRecording() {
  if (!audioRecordingFinalizing) audioRecordingFinalizing = true;
  if (audioChunks.length > 0) {
    const cleanType = (audioRecorder?.mimeType || audioRecordingMimeType || 'audio/webm').split(';')[0];
    const blob = new Blob(audioChunks, { type: cleanType });
    let file;
    try {
      const audioBuffer = await decodeAudioBlob(blob);
      validateDecodedAudioDuration(audioBuffer.duration);
      const signal = summarizeDecodedAudio(audioBuffer);
      if (audioRecordingDiagnostics) audioRecordingDiagnostics.decoded = signal;
      file = AUDIO_UPLOAD_TARGET.format === 'wav'
        ? createWavFileFromAudioBuffer(audioBuffer)
        : new File([blob], `voice_${Date.now()}${getRecordedAudioExtension(cleanType)}`, { type: cleanType });
      file.isOptimized = true;
      const dt = new DataTransfer();
      dt.items.add(file);
      imageInput.files = dt.files;
      handleImageSelect({ target: imageInput });
      const extendedSilence = signal.durationSeconds >= 3 &&
        signal.trailingSilenceSeconds >= Math.max(2, signal.durationSeconds * 0.5);
      finishAudioDiagnostics('complete', { blobBytes: blob.size, outputBytes: file.size });
      if (extendedSilence && audioInputDetected) {
        setTimeout(() => alert('The recording contains a long period with no detected audio. Please review the preview before sending.'), 0);
      }
    } catch (err) {
      const message = getErrorMessage(err);
      finishAudioDiagnostics('rejected', { error: message, blobBytes: blob.size });
      alert(message);
      cleanupAudioRecorder();
      return;
    }
  } else {
    finishAudioDiagnostics('rejected', { error: 'No encoded chunks were produced.' });
    alert('No audio was captured. Please check microphone access and try again.');
  }
  cleanupAudioRecorder();
}

async function startAudioRecording() {
  if (isObserverRole()) return;
  if (!navigator.mediaDevices?.getUserMedia ||
      (typeof MediaRecorder === 'undefined' &&
       typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined')) {
    alert('Audio recording is not supported in this browser.');
    return;
  }
  if (audioRecordingActive) return;

  pauseMessageRefreshForAudioRecording();
  try {
    const nativeMimeType = AUDIO_RECORDING_FORCE_WEB_AUDIO ? '' : getSupportedAudioMimeType();
    if (nativeMimeType) {
      await startNativeAudioRecording(nativeMimeType);
      return;
    }

    if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') {
      alert('Audio recording is not supported in this browser.');
      return;
    }

    audioStream = await navigator.mediaDevices.getUserMedia({ audio: getAudioCaptureConstraints() });
    attachAudioTrackDiagnostics();

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    try {
      audioContext = new AudioContextCtor({ sampleRate: AUDIO_RECORDING_TARGET.sampleRate });
    } catch {
      audioContext = new AudioContextCtor();
    }
    if (audioContext.state === 'suspended') await audioContext.resume();

    audioSourceNode = audioContext.createMediaStreamSource(audioStream);
    const captureNode = await createAudioCaptureNode(audioContext);
    audioSilenceNode = audioContext.createGain();
    // Keep the processing graph renderable without producing audible monitoring.
    audioSilenceNode.gain.value = 1e-8;

    audioChunks = [];
    audioSeconds = 0;
    audioSampleRate = audioContext.sampleRate;
    audioFramesRecorded = 0;
    audioRecordingStartedAt = Date.now();
    audioRecordingStartedPerformance = performance.now();
    audioRecordingStoppedPerformance = 0;
    audioRecordingFinalizing = false;
    audioRecordingActive = true;
    audioRecorderMode = 'wav';
    resetAudioWaveform();
    beginAudioDiagnostics('script-processor', 'audio/wav');

    audioSourceNode.connect(captureNode);
    captureNode.connect(audioSilenceNode);
    audioSilenceNode.connect(audioContext.destination);

    startAudioRecordingClock();
  } catch (err) {
    alert('Microphone access denied or not supported.');
    console.error(err);
    cleanupAudioRecorder();
  }
}

function stopAudioRecording() {
  if (!audioRecordingActive) return;
  audioRecordingActive = false;
  audioRecordingFinalizing = true;
  audioRecordingStopRequestedAt = Date.now();
  audioRecordingStoppedPerformance = performance.now();
  document.getElementById('audio-recorder-status').textContent = 'Finalising recording';
  setAudioLevelStatus('Checking audio...');
  stopAudioLevelMonitor();
  recordAudioDiagnosticEvent('stop-requested', {
    recorderState: audioRecorder?.state || audioRecorderMode,
    trackState: audioTrack?.readyState || 'unknown',
  });
  if (audioRecorderMode === 'native' && audioRecorder) {
    if (audioRecorder.state !== 'inactive') {
      try {
        audioRecorder.stop();
      } catch (err) {
        const message = getErrorMessage(err);
        recordAudioDiagnosticEvent('stop-failed', { message });
        finishAudioDiagnostics('error', { error: message });
        alert(`Could not stop audio recording: ${message}`);
        cleanupAudioRecorder();
      }
    }
    else finishNativeAudioRecording();
    return;
  }
  finishAudioRecording();
}

function cancelAudioRecording() {
  audioChunks = [];
  audioRecordingActive = false;
  audioRecordingStopRequestedAt = Date.now();
  audioRecordingStoppedPerformance = performance.now();
  recordAudioDiagnosticEvent('recording-cancelled');
  finishAudioDiagnostics('cancelled');
  if (audioRecorder) {
    audioRecorder.onstop = null;
    if (audioRecorder.state !== 'inactive') {
      try { audioRecorder.stop(); } catch {}
    }
  }
  cleanupAudioRecorder();
}

function finishAudioRecording() {
  if (audioChunks.length > 0 && audioFramesRecorded > 0 && audioSampleRate > 0) {
    const blob = createWavBlob(audioChunks, audioSampleRate, audioFramesRecorded);
    const recordedSeconds = audioFramesRecorded / audioSampleRate;
    try {
      validateDecodedAudioDuration(recordedSeconds);
    } catch (err) {
      const message = getErrorMessage(err);
      finishAudioDiagnostics('rejected', { error: message, recordedSeconds });
      alert(message);
      cleanupAudioRecorder();
      return;
    }
    if (blob.size < Math.max(44, recordedSeconds * AUDIO_RECORDING_MIN_BYTES_PER_SECOND)) {
      finishAudioDiagnostics('rejected', { error: 'PCM output was smaller than expected.', recordedSeconds });
      alert('The recording was too small to be valid. Please keep this screen open and try again.');
      cleanupAudioRecorder();
      return;
    }
    const file = new File([blob], `voice_${Date.now()}.wav`, { type: 'audio/wav' });
    file.isOptimized = AUDIO_UPLOAD_TARGET.format === 'wav';
    const dt = new DataTransfer();
    dt.items.add(file);
    imageInput.files = dt.files;
    handleImageSelect({ target: imageInput });
    finishAudioDiagnostics('complete', { recordedSeconds, outputBytes: file.size });
  } else {
    finishAudioDiagnostics('rejected', { error: 'No PCM samples were produced.' });
    alert('No audio was captured. Please check microphone access and try again.');
  }
  cleanupAudioRecorder();
}

function cleanupAudioRecorder() {
  document.getElementById('audio-recorder-bar').style.display = 'none';
  setAudioRecorderUi(false);
  document.getElementById('audio-recorder-status').textContent = 'Ready to record';
  audioRecordingActive = false;
  stopAudioLevelMonitor();
  if (audioVisibilityListener) {
    document.removeEventListener('visibilitychange', audioVisibilityListener);
    audioVisibilityListener = null;
  }
  if (audioWindowBlurListener) {
    window.removeEventListener('blur', audioWindowBlurListener);
    audioWindowBlurListener = null;
  }
  if (audioWindowFocusListener) {
    window.removeEventListener('focus', audioWindowFocusListener);
    audioWindowFocusListener = null;
  }
  if (audioDeviceChangeListener) {
    navigator.mediaDevices?.removeEventListener?.('devicechange', audioDeviceChangeListener);
    audioDeviceChangeListener = null;
  }
  stopAudioInputTracks();
  audioTrack = null;
  audioStream = null;
  if (audioProcessorNode) {
    audioProcessorNode.onaudioprocess = null;
    disconnectAudioNode(audioProcessorNode);
    audioProcessorNode = null;
  }
  if (audioWorkletNode) {
    audioWorkletNode.port.onmessage = null;
    disconnectAudioNode(audioWorkletNode);
    audioWorkletNode = null;
  }
  if (audioSourceNode) {
    disconnectAudioNode(audioSourceNode);
    audioSourceNode = null;
  }
  if (audioSilenceNode) {
    disconnectAudioNode(audioSilenceNode);
    audioSilenceNode = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (audioRecorder) {
    audioRecorder.ondataavailable = null;
    audioRecorder.onstop = null;
    audioRecorder.onerror = null;
    audioRecorder.onpause = null;
    audioRecorder.onresume = null;
  }
  audioRecorder = null;
  audioChunks = [];
  audioRecordingMimeType = '';
  audioRecorderMode = 'wav';
  clearInterval(audioTimer);
  clearTimeout(audioStopTimeout);
  audioTimer = null;
  audioStopTimeout = null;
  audioSeconds = 0;
  audioSampleRate = 0;
  audioFramesRecorded = 0;
  audioRecordingStartedAt = 0;
  audioRecordingStopRequestedAt = 0;
  audioRecordingStartedPerformance = 0;
  audioRecordingStoppedPerformance = 0;
  audioRecordingFinalizing = false;
  audioRecordingDiagnostics = null;
  audioCaptureIssue = '';
  setAudioLevelStatus('Microphone level');
  resumeMessageRefreshAfterAudioRecording();
  updateComposerLayoutForText();
}

// ── FFmpeg video compression (optional, CDN-loaded) ───────────────────────────

let ffmpegInst = null;

async function loadFFmpeg() {
  if (ffmpegInst) return;
  if (typeof FFmpegWASM === 'undefined') {
    await loadScript(`${FFMPEG_VENDOR_BASE_URL}/ffmpeg.js`);
  }
  if (typeof FFmpegWASM === 'undefined') {
    throw new Error('FFmpeg browser library did not load from /vendor/ffmpeg/ffmpeg.js. Check the local asset path, service-worker cache, and browser script blocking.');
  }
  if (window.crossOriginIsolated === false) {
    throw new Error('Browser is not cross-origin isolated, so FFmpeg WASM cannot use SharedArrayBuffer. Check COOP/COEP headers.');
  }
  const { FFmpeg } = FFmpegWASM;
  ffmpegInst = new FFmpeg();
  ffmpegInst.on('log', ({ message }) => console.debug('[ffmpeg]', message));
  ffmpegInst.on('progress', ({ progress }) => {
    const pct = Math.round(progress * 100);
    if (activePendingId) setPendingProgress(activePendingId, pct, '#ffc107');
  });
  const coreBaseUrl = FFMPEG_VENDOR_BASE_URL;
  await ffmpegInst.load({
    coreURL: await toLocalBlobURL(`${coreBaseUrl}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toLocalBlobURL(`${coreBaseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
  });
}

function applyFontFamily(name, save = true) {
  const availableFonts = getAvailableFontOptionIds();
  const fontName = availableFonts.includes(name) ? name : (appConfig.defaultFontFamily || availableFonts[0]);
  const option = FONT_OPTIONS[fontName] || FONT_OPTIONS.system;
  document.documentElement.style.setProperty('--app-font-family', option.stack);
  document.querySelectorAll('.font-family-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.fontFamily === fontName));
  if (save) {
    apiFetch('/api/preferences', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fontFamily: fontName }),
    }).catch(e => console.warn('[prefs] save failed:', e.message));
  }
}

async function compressVideo(file) {
  try {
    await loadFFmpeg();
  } catch (err) {
    console.warn('[ffmpeg] unavailable; video conversion cannot continue', err);
    throw err;
  }
  const inputExt = (file.name && file.name.match(/\.[^.]+$/)?.[0]) || '.video';
  const inputName = `input${inputExt}`;
  const outputName = 'output.mp4';
  const scaleFilter = [
    `scale=${VIDEO_UPLOAD_TARGET.width}:${VIDEO_UPLOAD_TARGET.height}:force_original_aspect_ratio=decrease`,
    `pad=${VIDEO_UPLOAD_TARGET.width}:${VIDEO_UPLOAD_TARGET.height}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
    `fps=${VIDEO_UPLOAD_TARGET.fps}`,
  ].join(',');

  try {
    await ffmpegInst.writeFile(inputName, await fetchFileBytes(file));
    await ffmpegInst.exec([
      '-y',
      '-i', inputName,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-b:v', VIDEO_UPLOAD_TARGET.videoBitrate,
      '-maxrate', VIDEO_UPLOAD_TARGET.videoBitrate,
      '-bufsize', '2000k',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', VIDEO_UPLOAD_TARGET.audioBitrate,
      '-ar', '44100',
      '-movflags', '+faststart',
      outputName,
    ]);
    const data = await ffmpegInst.readFile(outputName);
    return new File([data], 'video.mp4', { type: 'video/mp4' });
  } finally {
    await ffmpegInst.deleteFile(inputName).catch(() => {});
    await ffmpegInst.deleteFile(outputName).catch(() => {});
  }
}

async function compressAudio(file) {
  try {
    await loadFFmpeg();
  } catch (err) {
    console.warn('[ffmpeg] unavailable; audio conversion cannot continue', err);
    throw err;
  }
  const inputExt = (file.name && file.name.match(/\.[^.]+$/)?.[0]) || '.wav';
  const inputName = `audio-input${inputExt}`;
  const outputName = 'audio-output.weba';
  const fallbackOutputName = 'audio-output.m4a';

  try {
    await ffmpegInst.writeFile(inputName, await fetchFileBytes(file));
    let data;
    let name;
    let type;
    if (AUDIO_UPLOAD_TARGET.format === 'aac') {
      await ffmpegInst.exec([
        '-y',
        '-i', inputName,
        '-vn',
        '-ac', '1',
        '-ar', '44100',
        '-c:a', 'aac',
        '-b:a', AUDIO_UPLOAD_TARGET.bitrate,
        fallbackOutputName,
      ]);
      data = await ffmpegInst.readFile(fallbackOutputName);
      name = 'voice.m4a';
      type = 'audio/mp4';
    } else {
      name = 'voice.weba';
      type = 'audio/webm;codecs=opus';
      try {
        await ffmpegInst.exec([
          '-y',
          '-i', inputName,
          '-vn',
          '-ac', '1',
          '-ar', AUDIO_UPLOAD_TARGET.sampleRate,
          '-c:a', 'libopus',
          '-b:a', AUDIO_UPLOAD_TARGET.bitrate,
          '-application', 'voip',
          outputName,
        ]);
        data = await ffmpegInst.readFile(outputName);
      } catch (opusErr) {
        console.warn('[ffmpeg] opus audio conversion failed; trying AAC fallback', opusErr);
        await ffmpegInst.exec([
          '-y',
          '-i', inputName,
          '-vn',
          '-ac', '1',
          '-ar', '44100',
          '-c:a', 'aac',
          '-b:a', AUDIO_UPLOAD_TARGET.bitrate,
          fallbackOutputName,
        ]);
        data = await ffmpegInst.readFile(fallbackOutputName);
        name = 'voice.m4a';
        type = 'audio/mp4';
      }
    }
    const converted = new File([data], name, { type });
    converted.isOptimized = true;
    return converted;
  } finally {
    await ffmpegInst.deleteFile(inputName).catch(() => {});
    await ffmpegInst.deleteFile(outputName).catch(() => {});
    await ffmpegInst.deleteFile(fallbackOutputName).catch(() => {});
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function linkify(text) {
  if (!text) return '';
  const raw = String(text);
  const urlRe = /https?:\/\/[^\s"'<>)]+/g;
  let html = '';
  let lastIndex = 0;
  raw.replace(urlRe, (url, offset) => {
    html += escapeHtml(raw.slice(lastIndex, offset));
    const locationPreview = getGoogleMapsLocationPreview(url);
    const className = locationPreview ? ' class="location-link"' : '';
    html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${className}>${escapeHtml(locationPreview || url)}</a>`;
    lastIndex = offset + url.length;
    return url;
  });
  html += escapeHtml(raw.slice(lastIndex));
  return html;
}

function getGoogleMapsLocationPreview(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'google.com' && host !== 'maps.google.com') return null;
    const query = parsed.searchParams.get('query') || parsed.searchParams.get('q');
    if (!query) return null;
    const match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  } catch {
    return null;
  }
}

// ── PWA registration ──────────────────────────────────────────────────────────

let serviceWorkerRegistrationStarted = false;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !appConfig.pwaEnabled) return;
  if (serviceWorkerRegistrationStarted) return;
  serviceWorkerRegistrationStarted = true;

  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.update().catch(() => {});

    // Poll for updates every 60 s so long-lived sessions pick up new deploys
    setInterval(() => reg.update().catch(() => {}), 60_000);

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        // A new SW has been installed and is waiting to take over.
        // Reload automatically so users always run the latest version.
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          window.location.reload();
        }
      });
    });
  }).catch(e => {
    serviceWorkerRegistrationStarted = false;
    console.warn('[sw]', e.message);
  });
}

let serviceWorkerReloading = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (serviceWorkerReloading) return;
    serviceWorkerReloading = true;
    window.location.reload();
  });
}

// ── Push notifications ────────────────────────────────────────────────────────

async function savePushPreference(enabled) {
  if (isObserverRole()) return;
  pushPreferenceEnabled = enabled;
  await apiFetch('/api/preferences', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ pushEnabled: enabled }),
  }).catch(() => {});
}

async function syncPushToggleState(statusMessage = '') {
  if (isObserverRole()) return;
  const toggle   = document.getElementById('push-toggle');
  const statusEl = document.getElementById('push-status-msg');
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (!sub && pushPreferenceEnabled && Notification.permission === 'granted') {
      await subscribeToPush({ requestPermission: false, silent: true });
      sub = await reg.pushManager.getSubscription();
    }

    if (toggle) toggle.checked = !!sub;
    if (statusEl) {
      if (statusMessage) {
        statusEl.textContent = statusMessage;
        statusEl.style.display = 'block';
      } else if (pushPreferenceEnabled && !sub) {
        statusEl.textContent = 'Push is enabled for your account, but it still needs to be connected on this device.';
        statusEl.style.display = 'block';
      } else {
        statusEl.textContent = '';
        statusEl.style.display = 'none';
      }
    }
  } catch { /* ignore */ }
}

async function initPushNotifications() {
  const row = document.getElementById('push-notification-row');
  if (isObserverRole()) {
    if (row) row.style.display = 'none';
    return;
  }
  updatePwaInstallUi();

  if (!row) return;

  if (!appConfig.pwaEnabled ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)) {
    row.style.display = 'none';
    return;
  }

  if (!isStandalonePwa()) {
    row.style.display = 'none';
    return;
  }

  if (!appConfig.pushNotificationsEnabled || !appConfig.vapidPublicKey) {
    row.style.display = 'none';
    updatePwaInstallUi('The app is installed, but push notifications are not available right now.');
    return;
  }

  row.style.display = 'block';
  await syncPushToggleState();
}

async function togglePushNotifications(enable) {
  if (isObserverRole()) return;
  const toggle  = document.getElementById('push-toggle');
  const statusEl = document.getElementById('push-status-msg');
  if (statusEl) { statusEl.style.display = 'none'; }

  if (enable && !isStandalonePwa()) {
    if (toggle) toggle.checked = false;
    if (statusEl) {
      statusEl.textContent = 'Install the PWA on this device before enabling push notifications.';
      statusEl.style.display = 'block';
    }
    return;
  }

  const ok = enable
    ? await subscribeToPush()
    : await unsubscribeFromPush();

  await savePushPreference(ok ? enable : false);
  await syncPushToggleState();
}

async function subscribeToPush(options = {}) {
  if (isObserverRole()) return false;
  const { requestPermission = true, silent = false } = options;
  const statusEl = document.getElementById('push-status-msg');

  if (!isStandalonePwa()) {
    if (statusEl && !silent) {
      statusEl.textContent = 'Install the PWA on this device before enabling push notifications.';
      statusEl.style.display = 'block';
    }
    return false;
  }

  if (!appConfig.pushNotificationsEnabled || !appConfig.vapidPublicKey) {
    if (statusEl && !silent) {
      statusEl.textContent = 'Push notifications not available.';
      statusEl.style.display = 'block';
    }
    return false;
  }

  try {
    let permission = Notification.permission;
    if (permission !== 'granted') {
      if (!requestPermission) return false;
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      if (statusEl && !silent) {
        statusEl.textContent = 'Notification permission denied.';
        statusEl.style.display = 'block';
      }
      return false;
    }

    const reg = await navigator.serviceWorker.ready;
    const existingSubscription = await reg.pushManager.getSubscription();
    const subscription = existingSubscription || await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(appConfig.vapidPublicKey),
    });

    const res = await apiFetch('/api/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(subscription.toJSON()),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (statusEl && !silent) {
        statusEl.textContent = data.error || 'Failed to subscribe.';
        statusEl.style.display = 'block';
      }
      if (!existingSubscription) await subscription.unsubscribe();
      return false;
    }

    return true;
  } catch (err) {
    if (statusEl && !silent) {
      statusEl.textContent = 'Could not enable push notifications.';
      statusEl.style.display = 'block';
    }
    console.warn('[push] subscribe error:', err);
    return false;
  }
}

async function unsubscribeFromPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await apiFetch('/api/push/unsubscribe', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
    return false;
  } catch (err) {
    console.warn('[push] unsubscribe error:', err);
    return false;
  }
}

async function promptPwaInstall() {
  if (!deferredInstallPrompt) {
    updatePwaInstallUi('Use your browser install/share menu to add this app to the home screen.');
    return;
  }

  const installPrompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  installPrompt.prompt();

  try {
    const choice = await installPrompt.userChoice;
    if (choice.outcome !== 'accepted') {
      updatePwaInstallUi('Install was cancelled. You can try again any time.');
      return;
    }
    updatePwaInstallUi('Finishing installation…');
  } catch {
    updatePwaInstallUi('Install prompt could not be completed.');
  }
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updatePwaInstallUi();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updatePwaInstallUi('App installed. You can now enable push notifications below.');
  initPushNotifications().catch(() => {});
});

/** Convert a base64url VAPID public key to Uint8Array for PushManager.subscribe */
function urlBase64ToUint8Array(base64String) {
  const padding  = '='.repeat((4 - base64String.length % 4) % 4);
  const base64   = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData  = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ── Main init ─────────────────────────────────────────────────────────────────

async function init() {
  await loadConfig();
  await loadMe();
  await loadPreferences();
  await loadMessages();
  await restoreSavedDraft();
  updateButtonState();
  registerServiceWorker();
  await initPushNotifications();

  if (!appInitialized) {
    appInitialized = true;

    const sentinel = document.getElementById('load-more-sentinel');
    const postForm = document.getElementById('postForm');
    if (postForm) {
      new ResizeObserver(() => {
        document.body.style.paddingBottom = (postForm.offsetHeight + 15) + 'px';
        const dist = document.body.scrollHeight - (window.scrollY + window.innerHeight);
        if (dist < 300) scrollToBottom(true);
      }).observe(postForm);
    }

    if (sentinel) {
      new IntersectionObserver(entries => {
        entries.forEach(entry => { if (entry.isIntersecting && !loadingOlder) loadOlderPosts(); });
      }, { rootMargin: '100px 0px 0px 0px', threshold: 0.1 }).observe(sentinel);
    }

    document.addEventListener('visibilitychange', () => {
      isPageVisible = !document.hidden;
      if (isPageVisible) {
        unreadCount    = 0;
        document.title = originalTitle;
        document.querySelectorAll('.post[data-unread="true"]').forEach(d => { d.dataset.unread = 'false'; });
        loadMessages();
      }
    });
  }

  refreshTimer = setInterval(loadMessages, 2000);
}

// ── Auto-login check on page load ─────────────────────────────────────────────
(async () => {
  try {
    // Load config first so Turnstile key is ready before showing login
    const cfgRes = await fetch('/api/config', { credentials: 'same-origin' });
    if (cfgRes.ok) {
      appConfig = await cfgRes.json();
      applyAppConfigChrome();
      renderColourSchemeButtons();
      renderFontFamilyButtons();
      registerServiceWorker();
      if (appConfig.turnstileSiteKey) loadTurnstile(appConfig.turnstileSiteKey);
    }

    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      currentRole = data.role;

      if (data.forcePasswordChange) {
        // Need to show change-password step – but we are already authenticated
        // Show the login overlay in change-password step
        showLoginOverlay();
        showLoginStep('change-password');
        return;
      }

      if (data.role === 'admin') { window.location.href = '/admin.html'; return; }
      hideLoginOverlay();
      init();
    } else {
      showLoginOverlay();
    }
  } catch {
    showLoginOverlay();
  }
})();
