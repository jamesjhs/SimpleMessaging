'use strict';

// ── Navigation ────────────────────────────────────────────────────────────────

function showSection(name) {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`section-${name}`).classList.add('active');
  document.querySelector(`.nav-tab[onclick="showSection('${name}')"]`).classList.add('active');

  if (name === 'users')    loadUsers();
  if (name === 'reports')  loadReports();
  if (name === 'settings') loadSettings();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  window.location.href = '/';
}

// ── API helper ────────────────────────────────────────────────────────────────

function apiFetch(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options });
}

function setError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || '';
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

// ── Users ─────────────────────────────────────────────────────────────────────

async function loadUsers() {
  setError('users-error', '');
  const res  = await apiFetch('/api/admin/users');
  if (!res.ok) { setError('users-error', 'Failed to load users.'); return; }
  const users = await res.json();

  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '';
  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u.id}</td>
      <td>${esc(u.username)}</td>
      <td>${esc(u.display_name)}</td>
      <td>${esc(u.email || '—')}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-yellow' : 'badge-blue'}">${u.role}</span></td>
      <td>${u.two_fa_enabled ? '✓' : '—'}</td>
      <td>
        <span class="badge ${u.enabled ? 'badge-green' : 'badge-red'}">${u.enabled ? 'Active' : 'Disabled'}</span>
        ${u.login_locked ? '<span class="badge badge-red badge-locked" title="Locked after too many failed login attempts">🔒 Locked</span>' : ''}
      </td>
      <td>${fmtDate(u.last_seen)}</td>
      <td>
        <button class="btn-sm btn-edit"   onclick="openEditUser(${u.id})">Edit</button>
        <button class="btn-sm btn-danger" onclick="disableUser(${u.id})" ${!u.enabled ? 'disabled' : ''}>Disable</button>
        ${u.login_locked ? `<button class="btn-sm btn-unlock" onclick="unlockUser(${u.id})">Unlock</button>` : ''}
        ${u.email ? `<button class="btn-sm btn-invite" onclick="quickInvite(${u.id})">Invite</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openCreateUser() {
  document.getElementById('user-modal-title').textContent = 'Create User';
  document.getElementById('user-id').value         = '';
  document.getElementById('user-username').value   = '';
  document.getElementById('user-displayname').value= '';
  document.getElementById('user-email').value      = '';
  document.getElementById('user-role').value       = 'user';
  document.getElementById('user-password').value   = '';
  document.getElementById('user-twofa').checked    = false;
  document.getElementById('user-enabled').checked  = true;
  document.getElementById('password-label').textContent = 'Password *';
  document.getElementById('user-username').removeAttribute('readonly');
  document.getElementById('password-hint').style.display = 'none';
  document.getElementById('invite-btn').style.display    = 'none';
  setError('user-modal-error', '');
  document.getElementById('user-modal').style.display = 'flex';
}

async function openEditUser(id) {
  const res  = await apiFetch('/api/admin/users');
  const users = await res.json();
  const u     = users.find(x => x.id === id);
  if (!u) return;

  document.getElementById('user-modal-title').textContent = 'Edit User';
  document.getElementById('user-id').value          = u.id;
  document.getElementById('user-username').value    = u.username;
  document.getElementById('user-displayname').value = u.display_name;
  document.getElementById('user-email').value       = u.email || '';
  document.getElementById('user-role').value        = u.role;
  document.getElementById('user-password').value    = '';
  document.getElementById('user-twofa').checked     = !!u.two_fa_enabled;
  document.getElementById('user-enabled').checked   = !!u.enabled;
  document.getElementById('password-label').textContent = 'New Password';
  document.getElementById('user-username').setAttribute('readonly', 'true');
  document.getElementById('password-hint').style.display  = 'block';
  document.getElementById('invite-btn').style.display     = u.email ? 'block' : 'none';
  document.getElementById('invite-btn').dataset.userId    = u.id;
  setError('user-modal-error', '');
  document.getElementById('user-modal').style.display = 'flex';
}

function closeUserModal() {
  document.getElementById('user-modal').style.display = 'none';
}

async function saveUser(e) {
  e.preventDefault();
  const id          = document.getElementById('user-id').value;
  const isEdit      = !!id;
  const username    = document.getElementById('user-username').value.trim();
  const displayName = document.getElementById('user-displayname').value.trim();
  const email       = document.getElementById('user-email').value.trim();
  const role        = document.getElementById('user-role').value;
  const password    = document.getElementById('user-password').value;
  const twoFa       = document.getElementById('user-twofa').checked;
  const enabled     = document.getElementById('user-enabled').checked;

  if (!isEdit && !password) { setError('user-modal-error', 'Password is required for new users.'); return; }

  if (isEdit) {
    const body = { displayName, email: email || null, role, twoFaEnabled: twoFa, enabled };
    if (password) body.newPassword = password;
    const res = await apiFetch(`/api/admin/users/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError('user-modal-error', data.error || 'Update failed.');
      return;
    }
  } else {
    const res = await apiFetch('/api/admin/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, displayName, email: email || null, role, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError('user-modal-error', data.error || 'Create failed.');
      return;
    }
  }

  closeUserModal();
  loadUsers();
}

async function disableUser(id) {
  if (!confirm('Disable this user account?')) return;
  const res = await apiFetch(`/api/admin/users/${id}`, {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Could not disable user.');
    return;
  }
  loadUsers();
}

async function unlockUser(id) {
  const res = await apiFetch(`/api/admin/users/${id}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ loginLocked: false }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Could not unlock user.');
    return;
  }
  loadUsers();
}

async function sendInvite() {
  const id = document.getElementById('invite-btn').dataset.userId;
  if (!id) return;
  const res  = await apiFetch('/api/admin/invite', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId: parseInt(id, 10) }),
  });
  const data = await res.json().catch(() => ({}));
  alert(res.ok ? 'Invite email sent.' : (data.error || 'Failed to send invite.'));
}

async function quickInvite(id) {
  const res  = await apiFetch('/api/admin/invite', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId: id }),
  });
  const data = await res.json().catch(() => ({}));
  alert(res.ok ? 'Invite email sent.' : (data.error || 'Failed to send invite.'));
}

// ── Reports ───────────────────────────────────────────────────────────────────

async function loadReports() {
  setError('reports-error', '');
  const res  = await apiFetch('/api/admin/reports');
  if (!res.ok) { setError('reports-error', 'Failed to load reports.'); return; }
  const reports = await res.json();

  const tbody = document.getElementById('reports-tbody');
  tbody.innerHTML = '';
  reports.forEach(r => {
    const tr = document.createElement('tr');
    const preview = r.message_text
      ? esc(r.message_text.slice(0, 80)) + (r.message_text.length > 80 ? '…' : '')
      : (r.image_path ? '[Media]' : '—');
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${fmtDate(r.reported_at)}</td>
      <td>${esc(r.reporter_name)}</td>
      <td>${esc(r.author_name)}</td>
      <td title="${esc(r.message_text || '')}">${preview}</td>
      <td>
        ${r.reviewed
          ? `<span class="badge badge-green">Reviewed</span><br><small>${esc(r.action_taken || '')}</small>`
          : `<span class="badge badge-yellow">Pending</span>`}
      </td>
      <td>
        ${!r.reviewed
          ? `<button class="btn-sm btn-edit" onclick="reviewReport(${r.id})">Review</button>`
          : '—'}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function reviewReport(id) {
  const action = prompt('Action taken (e.g. "warning issued", "message removed"):', 'reviewed');
  if (action === null) return; // cancelled
  const res = await apiFetch(`/api/admin/reports/${id}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ actionTaken: action }),
  });
  if (!res.ok) { alert('Failed to update report.'); return; }
  loadReports();
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  setError('settings-error', '');
  const res  = await apiFetch('/api/admin/settings');
  if (!res.ok) { setError('settings-error', 'Failed to load settings.'); return; }
  const s   = await res.json();
  const form = document.getElementById('settings-form');

  Object.entries(s).forEach(([key, val]) => {
    const el = form.elements[key];
    if (!el) return;
    if (el.type === 'checkbox') el.checked = val === '1' || val === 'true';
    else el.value = val ?? '';
  });

  // Update icon preview
  if (s.chat_icon_url) {
    const preview = document.getElementById('icon-preview');
    if (preview) preview.src = s.chat_icon_url + '?t=' + Date.now();
  }
}

async function saveSettings(e) {
  e.preventDefault();
  setError('settings-error', '');
  const form = document.getElementById('settings-form');
  const body = {};

  ['site_title','main_header','delete_button','reply_button','read_status_unread','read_status_seen'].forEach(k => {
    const el = form.elements[k];
    if (el) body[k] = el.value;
  });
  ['enable_delete_button','enable_view_once','enable_blur','enable_emergency_exit','report_enabled','pwa_enabled'].forEach(k => {
    const el = form.elements[k];
    if (el) body[k] = el.checked ? '1' : '0';
  });

  const res = await apiFetch('/api/admin/settings', {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) { setError('settings-error', 'Failed to save settings.'); return; }

  const msg = document.getElementById('settings-saved-msg');
  if (msg) {
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2500);
  }
}

// ── Import (two-step: preview → commit) ───────────────────────────────────────

let importPreviewToken  = null;
let importExistingUsers = [];

async function previewImport(e) {
  e.preventDefault();
  setError('import-error', '');

  const file = document.getElementById('import-file').files[0];
  if (!file) return;

  const form = new FormData();
  form.append('file', file);

  const res  = await apiFetch('/api/admin/import/preview', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) { setError('import-error', data.error || 'Preview failed.'); return; }

  importPreviewToken  = data.previewToken;
  importExistingUsers = data.existingUsers || [];

  // Build the assignment table
  const tbody = document.getElementById('import-mapping-tbody');
  tbody.innerHTML = '';
  (data.uniqueNames || []).forEach(entry => {
    const tr = document.createElement('tr');
    const opts = importExistingUsers.map(u =>
      `<option value="${u.id}"${u.id === entry.suggestedUserId ? ' selected' : ''}>${esc(u.display_name)} (${esc(u.username)})</option>`
    ).join('');
    tr.innerHTML = `
      <td>${esc(entry.name)}</td>
      <td>
        <select class="import-user-select" data-name="${esc(entry.name)}">
          <option value="">— Auto-create new account —</option>
          ${opts}
        </select>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('import-preview-count').textContent =
    `${data.postCount} message(s) found · ${(data.uniqueNames || []).length} unique name(s) identified`;

  document.getElementById('import-step-1').style.display = 'none';
  document.getElementById('import-step-2').style.display = 'block';
}

async function commitImport() {
  setError('import-error-2', '');

  const mapping = {};
  document.querySelectorAll('.import-user-select').forEach(sel => {
    const name = sel.dataset.name;
    mapping[name] = sel.value ? parseInt(sel.value, 10) : null;
  });

  const res  = await apiFetch('/api/admin/import/commit', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ previewToken: importPreviewToken, mapping }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) { setError('import-error-2', data.error || 'Import failed.'); return; }

  document.getElementById('import-result').textContent =
    `✓ Imported ${data.imported} message(s), skipped ${data.skipped}.`;

  if (data.createdUsers && data.createdUsers.length > 0) {
    const tbody = document.getElementById('created-users-tbody');
    tbody.innerHTML = '';
    data.createdUsers.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(u.displayName)}</td><td>${esc(u.username)}</td><td><code>${esc(u.temporaryPassword)}</code></td>`;
      tbody.appendChild(tr);
    });
    document.getElementById('created-users-section').style.display = 'block';
  }

  document.getElementById('import-step-2').style.display = 'none';
  document.getElementById('import-step-3').style.display = 'block';
}

function resetImport() {
  importPreviewToken  = null;
  importExistingUsers = [];
  const fileInput = document.getElementById('import-file');
  if (fileInput) fileInput.value = '';
  setError('import-error', '');
  setError('import-error-2', '');
  document.getElementById('import-result').textContent = '';
  document.getElementById('created-users-section').style.display = 'none';
  document.getElementById('import-step-1').style.display = 'block';
  document.getElementById('import-step-2').style.display = 'none';
  document.getElementById('import-step-3').style.display = 'none';
}

// ── Icon upload ───────────────────────────────────────────────────────────────

async function uploadIcon() {
  const file = document.getElementById('icon-file').files[0];
  if (!file) { alert('Please choose an image file first.'); return; }

  const form = new FormData();
  form.append('icon', file);

  const res  = await apiFetch('/api/admin/icon', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) { alert(data.error || 'Upload failed.'); return; }

  const preview = document.getElementById('icon-preview');
  if (preview) preview.src = data.url + '?t=' + Date.now();
  const msg = document.getElementById('icon-upload-msg');
  if (msg) { msg.textContent = '✓ Icon updated'; msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; }, 2500); }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Close modal on outside click
document.getElementById('user-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('user-modal')) closeUserModal();
});

// Load users on page open
loadUsers();
