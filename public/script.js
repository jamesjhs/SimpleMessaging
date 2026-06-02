'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let currentUser    = null;   // display name of logged-in user
let currentRole    = null;   // 'admin' | 'user'
let appConfig      = {};     // server-supplied config
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

// Pending upload bubbles: pendingId -> { bubbleEl, formData, xhr, cancelled }
const pendingMessages = new Map();
let activePendingId   = null;

// OTP / login state
let otpTempToken          = null;
let loginCooldownTimer    = null;
let loginTurnstileWidgetId = null;  // Turnstile widget ID — null when inactive
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
};

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
const previewContainer= document.getElementById('preview-container');
const postsContainer  = document.getElementById('posts');

// ── API helper ───────────────────────────────────────────────────────────────
function apiFetch(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options });
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
  if (btn) btn.disabled = false;
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
  // Inject the script only once
  if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
    const script = document.createElement('script');
    script.src   = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }
  // Disable the Sign In button until the widget is solved
  const btn = document.getElementById('login-btn');
  if (btn) btn.disabled = true;
  let attempts = 0;
  const tryRender = () => {
    const container = document.getElementById('turnstile-container');
    if (!container) return;
    if (window.turnstile) {
      loginTurnstileWidgetId = window.turnstile.render(container, {
        sitekey:            siteKey,
        theme:              'dark',
        callback:           () => { if (btn) btn.disabled = false; },
        'expired-callback': () => { if (btn) btn.disabled = true;  },
        'error-callback':   () => { if (btn) btn.disabled = true;  },
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

async function attemptLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl  = document.getElementById('login-error');

  if (!username || !password) {
    errorEl.textContent = 'Please enter your username and password.';
    return;
  }

  const turnstileToken = getTurnstileToken();

  try {
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
      if (window.turnstile && loginTurnstileWidgetId != null) window.turnstile.reset(loginTurnstileWidgetId);
      return;
    }

    if (data.status === '2fa_required') {
      otpTempToken = data.tempToken;
      showLoginStep('otp');
      document.getElementById('login-otp').focus();
      return;
    }

    if (data.status === 'change_password') {
      currentUser = data.user.displayName;
      currentRole = data.user.role;
      showLoginStep('change-password');
      document.getElementById('new-password').focus();
      return;
    }

    // Success
    currentUser = data.user.displayName;
    currentRole = data.user.role;
    if (currentRole === 'admin') { window.location.href = '/admin.html'; return; }
    hideLoginOverlay();
    init();

  } catch {
    document.getElementById('login-error').textContent = 'Connection error. Please try again.';
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
  lastPostId   = null;
  unreadCount  = 0;
  document.title = originalTitle;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  document.querySelectorAll('#posts .post').forEach(el => el.remove());
  document.getElementById('settings-panel').style.display = 'none';
  apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
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

async function loadConfig() {
  try {
    const res = await apiFetch('/api/config');
    appConfig  = await res.json();

    if (appConfig.siteTitle) {
      document.title = appConfig.siteTitle;
      originalTitle  = appConfig.siteTitle;
    }
    const headerTitle = document.getElementById('header-title');
    if (headerTitle && appConfig.mainHeader) headerTitle.textContent = appConfig.mainHeader;
    if (appConfig.enableEmergencyExit) activateEmergencyExit();

    if (appConfig.turnstileSiteKey) loadTurnstile(appConfig.turnstileSiteKey);

    // Apply custom chat icon if the admin has set one
    if (appConfig.chatIconUrl) {
      const headerLogo = document.getElementById('header-logo');
      if (headerLogo) headerLogo.src = appConfig.chatIconUrl;
      const loginLogo  = document.getElementById('login-logo');
      if (loginLogo)  loginLogo.src  = appConfig.chatIconUrl;
    }
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
    if (data.scheme && COLOUR_SCHEMES[data.scheme]) applyColourScheme(data.scheme, false);
    enterToSend = !!data.enterToSend;
    pushPreferenceEnabled = !!data.pushEnabled;
    const toggle = document.getElementById('enter-to-send-toggle');
    if (toggle) toggle.checked = enterToSend;
    if (data.fontSize != null) applyFontSize(data.fontSize, false);
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

  div.className        = `post ${isMine ? 'mine' : 'theirs'}`;
  div.dataset.timestamp= p.createdAt;
  div.dataset.id       = p.id;
  div.dataset.user     = p.user;
  div.dataset.text     = p.text || '';
  div.dataset.imagepath= p.imagePath || '';

  // Read receipt
  let statusHtml = '';
  if (isMine) {
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
    const isVideo   = /\.(mp4|webm)$/i.test(p.imagePath);
    const blurClass = p.isBlurred ? 'blurred-preview' : '';

    if (p.viewOnce) {
      const recipientSeen = p.seenBy && p.seenBy.some(u => u !== p.user);
      if (isMine) {
        imageHtml = `<div class="view-once sent">👁️ View Once<div class="view-once-status">${recipientSeen ? 'Opened' : 'Delivered'}</div></div>`;
      } else {
        const iSaw = p.seenBy && p.seenBy.includes(me);
        imageHtml  = iSaw
          ? `<div class="view-once dead">👁️ ${isVideo ? 'Video' : 'Photo'} Viewed</div>`
          : `<div id="view-once-${p.id}" class="view-once active" onclick="openViewOnce('${p.id}')">👁️ View Once ${isVideo ? 'Video' : 'Photo'}</div>`;
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
    <span class="post-header">[${new Date(p.createdAt).toLocaleTimeString()}] <b>${escapeHtml(p.user)}</b></span>
    ${quoteHtml}
    <div class="message-text">${linkify(p.text)}</div>
    ${imageHtml}${statusHtml}
    <div class="reaction-strip"></div>
  `;

  attachMediaUnavailableFallback(div);

  // Delete button (own messages)
  if (isMine && cfg.enableDeleteButton !== false) {
    const btn   = document.createElement('button');
    btn.className   = 'delete-btn';
    btn.textContent = cfg.deleteButton || '✗';
    div.appendChild(btn);
  }

  // Report button (received messages, if enabled)
  if (!isMine && cfg.enableReport) {
    const btn   = document.createElement('button');
    btn.className   = 'report-btn';
    btn.textContent = '!';
    btn.title       = 'Report message';
    div.appendChild(btn);
  }

  // Reply button
  const rBtn       = document.createElement('button');
  rBtn.className   = 'reply-btn';
  rBtn.textContent = cfg.replyButton || '↩';
  div.appendChild(rBtn);

  updateReactionStrip(div, p.reactions);

  return div;
}

function attachMediaUnavailableFallback(messageEl) {
  const mediaEls = messageEl.querySelectorAll('img.chat-img, video.chat-img');
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
    const isMine  = currentUser && r.users.includes(currentUser);
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
    const iSaw = p.seenBy && p.seenBy.includes(currentUser);
    if (iSaw && voEl.classList.contains('active')) {
      const isVideo = p.imagePath && /\.(mp4|webm)$/i.test(p.imagePath);
      voEl.className = 'view-once dead';
      voEl.removeAttribute('id');
      voEl.innerHTML = `👁️ ${isVideo ? 'Video' : 'Photo'} Viewed`;
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

document.getElementById('postForm').addEventListener('submit', async e => {
  e.preventDefault();

  let fileToSend  = imageInput.files[0] || cameraInput.files[0] || videoInput.files[0];
  const text      = textInput.value.trim();
  const viewOnce  = document.getElementById('viewOnce').checked;
  const isBlurred = document.getElementById('blurInput').checked;
  const replyData = replyingTo ? { ...replyingTo } : null;
  const submittedAt = Date.now();
  const pendingId   = 'p-' + (crypto.randomUUID ? crypto.randomUUID() : `${submittedAt}-${Math.random().toString(36).slice(2)}`);

  const bubbleEl = createPendingBubble(pendingId, text, fileToSend, replyData);
  pendingMessages.set(pendingId, { bubbleEl, formData: null, xhr: null, cancelled: false });

  // Reset form immediately
  textInput.value = '';
  textInput.style.height = 'auto';
  cancelReply();
  clearPreview();
  document.getElementById('media-options').style.display = 'flex';
  document.getElementById('media-options').dataset.manual = 'false';
  document.getElementById('plus-btn').style.display = 'none';
  updateButtonState();
  textInput.focus();

  // Optional video compression
  const needsCompression = fileToSend && fileToSend.type.startsWith('video/') && !fileToSend.isOptimized;
  if (needsCompression) {
    setPendingLabel(pendingId, 'Compressing…');
    setPendingProgress(pendingId, 0, '#ffc107');
    activePendingId = pendingId;
    try {
      const compressed = await compressVideo(fileToSend);
      fileToSend = new File([compressed], 'video.mp4', { type: 'video/mp4' });
    } catch (err) {
      console.error('[compress]', err);
      activePendingId = null;
      setPendingFailed(pendingId);
      return;
    }
    activePendingId = null;
    const entry = pendingMessages.get(pendingId);
    if (!entry || entry.cancelled) { removePendingBubble(pendingId); return; }
  }

  const formData = new FormData();
  formData.append('text',        text);
  formData.append('viewOnce',    String(viewOnce));
  formData.append('isBlurred',   String(isBlurred));
  formData.append('submittedAt', String(submittedAt));
  if (replyData) {
    formData.append('replyUser', replyData.user);
    formData.append('replyText', replyData.text);
    if (replyData.id) formData.append('replyId', replyData.id);
  }
  if (fileToSend) formData.append('image', fileToSend);

  const entry = pendingMessages.get(pendingId);
  if (entry) entry.formData = formData;
  startPendingUpload(pendingId);
});

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
    if (file.type.startsWith('video/')) {
      mediaHtml = `<div class="pending-video-label">[ Video ]</div>`;
    } else {
      const blobUrl = URL.createObjectURL(file);
      mediaHtml = `<img src="${blobUrl}" class="chat-img pending-preview-img">`;
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

function setPendingFailed(pendingId) {
  const entry = pendingMessages.get(pendingId);
  if (!entry) return;
  const pw = entry.bubbleEl.querySelector('.pending-progress-wrap');
  if (pw) pw.style.display = 'none';
  const sr = entry.bubbleEl.querySelector('.pending-status-row');
  if (sr) sr.innerHTML = `
    <span class="pending-status-text pending-failed-text">Failed to send</span>
    <button type="button" class="pending-retry-btn" data-pending-id="${pendingId}" title="Retry">↺ Retry</button>
    <button type="button" class="pending-remove-btn" data-pending-id="${pendingId}" title="Remove">✕</button>
  `;
}

function removePendingBubble(pendingId) {
  const entry = pendingMessages.get(pendingId);
  if (!entry) return;
  const pi = entry.bubbleEl.querySelector('.pending-preview-img');
  if (pi && pi.src.startsWith('blob:')) URL.revokeObjectURL(pi.src);
  entry.bubbleEl.remove();
  pendingMessages.delete(pendingId);
}

function startPendingUpload(pendingId) {
  const entry = pendingMessages.get(pendingId);
  if (!entry || entry.cancelled) return;

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
      await loadMessages();
      scrollToBottom(true);
    } else {
      setPendingFailed(pendingId);
    }
  };
  xhr.onerror  = () => setPendingFailed(pendingId);
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
    if (confirm('Report this message to the administrator?')) {
      const id  = postDiv.dataset.id;
      const res = await apiFetch(`/api/messages/${id}/report`, { method: 'POST' });
      if (res.ok) {
        alert('Message reported.');
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not report message.');
      }
    }
  } else if (replyBtn && postDiv) {
    e.stopPropagation();
    setReply(postDiv.dataset.user, postDiv.dataset.text || (postDiv.dataset.imagepath ? 'Photo' : ''), postDiv.dataset.id);
  } else if (chipEl && postDiv) {
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
      swipeTarget.dataset.text || (swipeTarget.dataset.imagepath ? 'Photo' : ''),
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
  if (e.target.closest('button, a, .chat-img, video, .view-once')) return;
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
  if (e.button !== 0) return;
  const postDiv = e.target.closest('.post');
  if (!postDiv || postDiv.classList.contains('pending-msg')) return;
  if (e.target.closest('button, a, .chat-img, video, .view-once')) return;
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
  if (postDiv && !e.target.closest('button, a, .chat-img, video')) e.preventDefault();
});

// ── Reply helpers ─────────────────────────────────────────────────────────────

function setReply(username, text, id) {
  replyingTo = { user: username, text, id };
  document.getElementById('reply-info').textContent        = `Replying to ${username}`;
  document.getElementById('reply-text-preview').textContent = text;
  replyContainer.style.display = 'block';
  textInput.focus();
}

function cancelReply() {
  replyingTo = null;
  replyContainer.style.display = 'none';
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

function handleInput() {
  textInput.style.height    = 'auto';
  const newH                = Math.min(textInput.scrollHeight, 150);
  textInput.style.height    = newH + 'px';
  textInput.style.overflowY = textInput.scrollHeight > 150 ? 'scroll' : 'hidden';

  updateButtonState();
  sendTypingStatus(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    sendTypingStatus(false);
  }, 4000);

  const mediaOpts = document.getElementById('media-options');
  const plusBtn   = document.getElementById('plus-btn');
  const hasText   = textInput.value.trim().length > 0;
  if (hasText) {
    if (mediaOpts.dataset.manual !== 'true') {
      mediaOpts.style.display = 'none';
      plusBtn.style.display   = 'block';
    }
  } else {
    mediaOpts.style.display        = 'flex';
    plusBtn.style.display          = 'none';
    mediaOpts.dataset.manual       = 'false';
  }
}

function handleImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.type.startsWith('video/')) {
    previewImg.style.display       = 'none';
    previewVideoText.style.display = 'block';
    previewContainer.style.display = 'block';
    scrollToBottom(true);
  } else {
    if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
    previewImg.src                 = URL.createObjectURL(file);
    previewImg.style.display       = 'block';
    previewVideoText.style.display = 'none';
    previewContainer.style.display = 'block';
    previewImg.onload = () => scrollToBottom(true);
  }
  updateButtonState();
}

function clearPreview() {
  imageInput.value = '';
  cameraInput.value = '';
  videoInput.value  = '';
  document.getElementById('viewOnce').checked  = false;
  document.getElementById('blurInput').checked = false;
  if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
  previewContainer.style.display = 'none';
  previewImg.src                 = '';
  previewImg.style.display       = 'block';
  previewVideoText.style.display = 'none';
  previewVideoText.innerText     = '[ Video ]';
  document.getElementById('upload-progress-container').style.display = 'none';
  document.getElementById('upload-progress-bar').style.width = '0%';
  updateButtonState();
}

function updateButtonState() {
  const hasText  = textInput.value.trim().length > 0;
  const hasImage = imageInput.files.length > 0 || cameraInput.files.length > 0 || videoInput.files.length > 0;
  const canSend  = hasText || hasImage;
  sendBtn.disabled = !canSend;
  canSend ? sendBtn.classList.remove('is-disabled') : sendBtn.classList.add('is-disabled');
  const hasMedia = hasImage;
  document.getElementById('viewOnceLabel').style.display = (hasMedia && appConfig.enableViewOnce) ? 'flex' : 'none';
  document.getElementById('blurLabel').style.display     = (hasMedia && appConfig.enableBlur)     ? 'flex' : 'none';
}

function showAttachments(e) {
  if (e) e.preventDefault();
  const mediaOpts = document.getElementById('media-options');
  const plusBtn   = document.getElementById('plus-btn');
  mediaOpts.style.display  = 'flex';
  plusBtn.style.display    = 'none';
  mediaOpts.dataset.manual = 'true';
  textInput.focus();
}

async function sendTypingStatus(status) {
  await apiFetch('/api/typing', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ isTyping: status }),
  }).catch(() => {});
}

// ── Image / video overlay ─────────────────────────────────────────────────────

function showImagePopup(filePath) {
  const vid    = document.getElementById('overlayVideo');
  const isVideo= /\.(mp4|webm)$/i.test(filePath);
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
  if (btn) btn.onclick = null;
  const res  = await apiFetch(`/api/messages/${id}/view`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    showImagePopup(data.imagePath);
    loadMessages();
  }
}

window.addEventListener('popstate', () => {
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
  const scheme = COLOUR_SCHEMES[name] || COLOUR_SCHEMES.default;
  const root   = document.documentElement;
  root.style.setProperty('--color-bg',      scheme.bg);
  root.style.setProperty('--color-mine',    scheme.mine);
  root.style.setProperty('--color-theirs',  scheme.theirs);
  root.style.setProperty('--color-surface', scheme.surface);
  document.querySelectorAll('.colour-scheme-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.scheme === name));
  if (save) {
    apiFetch('/api/preferences', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ scheme: name }),
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

function initMediaRecorder() {
  const options = { audioBitsPerSecond: 128000, videoBitsPerSecond: 1000000 };
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
      video: { facingMode: currentFacingMode, width: { ideal: 600 }, height: { ideal: 800 }, frameRate: { ideal: 24, max: 30 } },
    });
    video.srcObject = recStream;
    video.style.transform = currentFacingMode === 'user' ? 'scaleX(-1)' : 'none';
    recOverlay.style.display = 'flex';
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
      video: { facingMode: currentFacingMode, width: { ideal: 600 }, height: { ideal: 800 }, frameRate: { ideal: 24, max: 30 } },
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

function closeRecorder() {
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
}

// ── FFmpeg video compression (optional, CDN-loaded) ───────────────────────────

let ffmpegInst = null;

async function loadFFmpeg() {
  if (ffmpegInst) return;
  if (typeof FFmpegWASM === 'undefined' || typeof FFmpegUtil === 'undefined') {
    throw new Error('FFmpeg libraries not available');
  }
  const { FFmpeg } = FFmpegWASM;
  ffmpegInst = new FFmpeg();
  ffmpegInst.on('log', ({ message }) => console.debug('[ffmpeg]', message));
  ffmpegInst.on('progress', ({ progress }) => {
    const pct = Math.round(progress * 100);
    if (activePendingId) setPendingProgress(activePendingId, pct, '#ffc107');
  });
  await ffmpegInst.load({
    coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd/ffmpeg-core.js',
    wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd/ffmpeg-core.wasm',
  });
}

async function compressVideo(file) {
  try {
    await loadFFmpeg();
  } catch {
    // FFmpeg unavailable – return file as-is
    return file;
  }
  const { fetchFile } = FFmpegUtil;
  await ffmpegInst.writeFile('input.mp4', await fetchFile(file));
  await ffmpegInst.exec(['-i','input.mp4','-vf','scale=-2:720','-c:v','libx264','-crf','28','-preset','ultrafast','output.mp4']);
  const data = await ffmpegInst.readFile('output.mp4');
  return new Blob([data.buffer], { type: 'video/mp4' });
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
  const escaped = escapeHtml(text);
  return escaped.replace(/(https?:\/\/[^\s"'<>)]+)/g, url =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

// ── PWA registration ──────────────────────────────────────────────────────────

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !appConfig.pwaEnabled) return;
  navigator.serviceWorker.register('/sw.js').then(reg => {
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
  }).catch(e => console.warn('[sw]', e.message));
}

// ── Push notifications ────────────────────────────────────────────────────────

async function savePushPreference(enabled) {
  pushPreferenceEnabled = enabled;
  await apiFetch('/api/preferences', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ pushEnabled: enabled }),
  }).catch(() => {});
}

async function syncPushToggleState(statusMessage = '') {
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
  updatePwaInstallUi();

  const row = document.getElementById('push-notification-row');
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
      if (appConfig.turnstileSiteKey) loadTurnstile(appConfig.turnstileSiteKey);
      // Apply custom icon immediately so the login screen shows the right logo
      if (appConfig.chatIconUrl) {
        const loginLogo  = document.getElementById('login-logo');
        if (loginLogo)  loginLogo.src  = appConfig.chatIconUrl;
        const headerLogo = document.getElementById('header-logo');
        if (headerLogo) headerLogo.src = appConfig.chatIconUrl;
      }
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
