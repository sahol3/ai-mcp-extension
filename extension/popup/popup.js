const $ = (id) => document.getElementById(id);

const SITE_LABELS = { gemini: 'Gemini', flow: 'Google Flow', chatgpt: 'ChatGPT' };

function renderSites(status) {
  const box = $('sites');
  box.innerHTML = '';
  for (const [id, meta] of Object.entries(status.known_sites ?? {})) {
    const live = status.sites?.[id] ?? null;
    const row = document.createElement('div');
    row.className = 'site';

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = SITE_LABELS[id] ?? meta.label ?? id;
    const detail = document.createElement('div');
    detail.className = 'meta';
    detail.textContent = !live
      ? 'no tab'
      : live.ready
        ? (live.hello?.detail?.state ?? 'ready')
        : (live.hello?.detail?.state ?? 'connected, not ready');
    left.append(name, detail);

    const right = document.createElement('div');
    const pill = document.createElement('span');
    pill.className = 'pill ' + (!live ? '' : live.ready ? 'ok' : 'warn');
    pill.textContent = !live ? 'off' : live.ready ? 'ready' : 'wait';
    const open = document.createElement('button');
    open.textContent = live ? 'focus' : 'open';
    open.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'aimcp:open', site: id }, () => setTimeout(refresh, 600)));
    right.append(pill, ' ', open);

    row.append(left, right);
    box.append(row);
  }
}

function render(status) {
  if (!status) return;
  $('enabled').checked = !!status.enabled;
  const ws = $('ws');
  ws.textContent = status.ws;
  ws.className = 'pill ' + (status.ws === 'connected' ? 'ok' : status.ws === 'connecting' ? 'warn' : 'bad');
  $('endpoint').textContent = status.endpoint;
  const [, host, port] = /ws:\/\/([^:]+):(\d+)/.exec(status.endpoint) ?? [];
  if (host && document.activeElement !== $('host')) $('host').value = host;
  if (port && document.activeElement !== $('port')) $('port').value = port;
  renderSites(status);

  $('hint').textContent = status.ws !== 'connected'
    ? 'Daemon unreachable — start it with: node server/src/daemon.js'
    : Object.keys(status.sites ?? {}).length === 0
      ? 'Connected. Open a site above to give agents something to drive.'
      : '';
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'aimcp:status' }, render);
}

$('enabled').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ type: 'aimcp:set', values: { enabled: e.target.checked } }, render);
});

$('save').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'aimcp:set',
    values: {
      host: $('host').value.trim() || '127.0.0.1',
      port: Number($('port').value) || 8791,
      token: $('token').value.trim(),
    },
  }, render);
});

$('reinject').addEventListener('click', () => {
  $('hint').textContent = 're-injecting…';
  chrome.runtime.sendMessage({ type: 'aimcp:reinject' }, (r) => {
    const results = r?.results ?? [];
    $('hint').textContent = results.length
      ? `re-injected ${results.filter((x) => x.ok).length}/${results.length} tab(s)`
      : 'no site tabs open';
    setTimeout(refresh, 500);
  });
});

/*
 * Chrome only grants broad capture permission from a user gesture, which is why this is a
 * button in the popup rather than something the bridge can request for itself.
 */
$('screenshots').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
  $('hint').textContent = granted ? 'screenshots enabled' : 'permission declined';
});

chrome.storage.local.get({ token: '' }).then((v) => { $('token').value = v.token || ''; });
refresh();
setInterval(refresh, 2000);
