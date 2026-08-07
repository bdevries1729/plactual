const POLL_INTERVAL_MS = 5000;
const TOAST_DURATION_MS = 4000;
const BUTTON_LABELS = { link: 'Link Institution', sync: 'Sync Now' };

const $ = (id) => document.getElementById(id);

const accountsList = $('accounts-list');
const syncLog = $('sync-log');
const syncLogInner = $('sync-log-inner');
const toastContainer = $('toast-container');

let plaidHandler = null;
// Previous poll's view of the world, so we only toast on an actual transition.
const lastSeen = { server: null, plaid: null, actual: null };

// ── API ──────────────────────────────────────────────────────────────────────

// Rejects with the server's own message so callers can surface it directly.
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

// ── Toasts ───────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', info: '·' };

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = icons[type] ?? icons.info;

  const text = document.createElement('span');
  text.textContent = message;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.append(icon, text);
  toastContainer.append(toast);

  setTimeout(() => {
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove());
  }, TOAST_DURATION_MS);
}

// ── Status ───────────────────────────────────────────────────────────────────

// Toasts only when a service flips, and never on the first poll.
function announceChange(key, label, state) {
  if (lastSeen[key] !== null && lastSeen[key] !== state) {
    showToast(`${label} is now ${state}`, state === 'up' ? 'success' : 'error');
  }
  lastSeen[key] = state;
}

async function loadStatus() {
  const dot = $('status-dot');

  try {
    const data = await api('/status');

    $('stat-count').textContent = data.items;
    $('stat-cron').textContent = data.cron;

    const badge = document.createElement('span');
    badge.className = `badge ${data.plaid_env === 'production' ? 'production' : 'sandbox'}`;
    badge.textContent = data.plaid_env;
    $('stat-env').replaceChildren(badge);

    const plaidState = data.services?.plaid;
    const actualState = data.services?.actual;
    announceChange('plaid', 'Plaid API', plaidState);
    announceChange('actual', 'Actual Budget server', actualState);

    const degraded = plaidState === 'down' || actualState === 'down';
    dot.className = degraded ? 'status-dot warning' : 'status-dot ok';
    dot.title = degraded
      ? `Plaid: ${plaidState}, Actual: ${actualState}`
      : 'All systems operational';

    if (lastSeen.server === 'down') showToast('Server connection restored', 'success');
    lastSeen.server = 'up';
  } catch {
    dot.className = 'status-dot';
    dot.title = 'Server offline';
    if (lastSeen.server !== 'down') {
      showToast('Cannot reach the server', 'error');
      lastSeen.server = 'down';
    }
  }
}

// ── Account list ─────────────────────────────────────────────────────────────

function buildAccountRow(mapping) {
  const row = $('tpl-account').content.cloneNode(true).querySelector('.account-row');
  row.dataset.plaidAccountId = mapping.plaid_account_id;
  row.querySelector('.account-name').textContent = mapping.account_name;
  row.querySelector('.account-id').textContent = mapping.plaid_account_id;
  row.querySelector('input').checked = mapping.sync;
  return row;
}

function buildInstitution(itemId, accounts) {
  const group = $('tpl-institution').content.cloneNode(true).querySelector('.institution-group');
  group.dataset.itemId = itemId;

  group.querySelector('.institution-name').textContent = accounts[0].institution_name;
  group.querySelector('.account-count').textContent =
    `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
  group.querySelector('.btn-reconnect').hidden = !accounts.some((a) => a.login_required);

  group.append(...accounts.map(buildAccountRow));
  return group;
}

function renderAccounts(mappings) {
  const label = $('sync-header-label');

  if (mappings.length === 0) {
    label.hidden = true;
    accountsList.replaceChildren($('tpl-empty-state').content.cloneNode(true));
    return;
  }
  label.hidden = false;

  const byItem = new Map();
  for (const mapping of mappings) {
    if (!byItem.has(mapping.item_id)) byItem.set(mapping.item_id, []);
    byItem.get(mapping.item_id).push(mapping);
  }

  accountsList.replaceChildren(
    ...[...byItem].map(([itemId, accounts]) => buildInstitution(itemId, accounts))
  );
}

async function loadAccounts() {
  try {
    renderAccounts(await api('/mappings'));
  } catch {
    showToast('Could not load accounts', 'error');
  }
}

async function toggleSync(plaidAccountId, input) {
  const enabled = input.checked;
  input.disabled = true;
  try {
    await api(`/mappings/${encodeURIComponent(plaidAccountId)}/sync`, {
      method: 'PATCH',
      body: { sync: enabled },
    });
    showToast(`Sync ${enabled ? 'enabled' : 'disabled'}`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
    input.checked = !enabled;
  } finally {
    input.disabled = false;
  }
}

// ── Plaid Link ───────────────────────────────────────────────────────────────

// Update mode: re-authenticate an institution that asked for a fresh login.
async function startUpdateMode(itemId) {
  try {
    const { link_token: linkToken } = await api('/create_link_token_update', {
      method: 'POST',
      body: { item_id: itemId },
    });

    Plaid.create({
      token: linkToken,
      onSuccess: async () => {
        try {
          await api(`/mappings/${encodeURIComponent(itemId)}/resolve_login`, { method: 'POST' });
          showToast('Login updated successfully', 'success');
          await loadAccounts();
        } catch (error) {
          showToast(error.message, 'error');
        }
      },
      onExit: (err) => {
        if (err) showToast(err.display_message || 'Update exited', 'error');
      },
    }).open();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// A link token is spent once Link succeeds, so this re-runs after every
// successful link to leave a usable handler behind for the next institution.
async function initPlaid() {
  try {
    const { link_token: linkToken } = await api('/create_link_token', { method: 'POST' });

    plaidHandler = Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken) => {
        setBusy('link', true, 'Linking…');
        try {
          const data = await api('/exchange_public_token', {
            method: 'POST',
            body: { public_token: publicToken },
          });
          showToast(`${data.accounts?.length ?? 0} account(s) linked`, 'success');
        } catch (error) {
          showToast(error.message, 'error');
        } finally {
          setBusy('link', false);
          await Promise.all([loadAccounts(), loadStatus(), initPlaid()]);
        }
      },
      onExit: (err) => {
        if (err) showToast(err.display_message || 'Link exited', 'error');
      },
    });

    $('link-btn').disabled = false;
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────────

function logSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function syncResultLine(result) {
  const line = document.createElement('div');
  if (result.error) {
    line.append(logSpan('log-err', `✕ ${result.mapping.account_name}: ${result.error}`));
  } else {
    line.append(
      logSpan('log-ok', `✓ ${result.mapping.account_name}`),
      logSpan(
        'log-dim',
        `  +${result.added} added  ~${result.modified} modified  -${result.removed} removed`
      )
    );
  }
  return line;
}

function showSyncLog(lines) {
  syncLogInner.replaceChildren(...lines);
  syncLog.classList.add('open');
}

// ── Buttons ──────────────────────────────────────────────────────────────────

// The spinner and the hidden refresh icon are pure CSS off `.is-busy`.
function setBusy(name, busy, busyLabel) {
  const button = $(`${name}-btn`);
  const text = $(`${name}-btn-text`);

  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  if (text) text.textContent = busy ? busyLabel : BUTTON_LABELS[name];
}

// ── Events ───────────────────────────────────────────────────────────────────

// Delegated, so rows re-rendered from templates need no per-element wiring.
accountsList.addEventListener('change', (event) => {
  const input = event.target.closest('[data-action="toggle-sync"]');
  if (!input) return;
  toggleSync(input.closest('[data-plaid-account-id]').dataset.plaidAccountId, input);
});

accountsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="reconnect"]');
  if (!button) return;
  startUpdateMode(button.closest('[data-item-id]').dataset.itemId);
});

$('link-btn').addEventListener('click', () => plaidHandler?.open());

$('sync-btn').addEventListener('click', async () => {
  syncLog.classList.remove('open');
  setBusy('sync', true, 'Syncing…');

  try {
    const data = await api('/sync', { method: 'POST' });
    showSyncLog(
      data.results.length
        ? data.results.map(syncResultLine)
        : [logSpan('log-dim', 'No accounts to sync.')]
    );
    showToast('Sync complete', 'success');
  } catch (error) {
    showSyncLog([logSpan('log-err', `✕ ${error.message}`)]);
    showToast(error.message, 'error');
  } finally {
    setBusy('sync', false);
    await Promise.all([loadStatus(), loadAccounts()]);
  }
});

$('refresh-btn').addEventListener('click', async () => {
  setBusy('refresh', true);
  try {
    await api('/mappings/refresh', { method: 'POST' });
    await Promise.all([loadAccounts(), loadStatus()]);
    showToast('Accounts refreshed', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy('refresh', false);
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  await Promise.all([loadStatus(), loadAccounts()]);
  setInterval(loadStatus, POLL_INTERVAL_MS);
  $('refresh-btn').disabled = false;
  $('sync-btn').disabled = false;
  await initPlaid();
})();
