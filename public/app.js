'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ }
  },
};

const state = {
  token: store.get('token'),
  me: null,
  config: {},
  requests: [],
  thread: null, // id of the open conversation
  tray: [], // books waiting to be added: { title, author, isbn, cover, checked }
  scanner: null,
  scanned: new Set(),
};

// ---------- helpers ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    signedOut();
    throw new Error('Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

const waLink = (phone, text) => `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

function cover(b) {
  const initials = esc((b.title || '?').replace(/^(the|a|an)\s+/i, '').slice(0, 2));
  const hue = [...(b.title || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const url = b.cover || b.cover_url;
  return `<div class="cover" style="--hue:${hue}">${initials}${
    url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''
  }</div>`;
}

/** Small bottom sheet: resolves to the entered text (or '' for confirm-only), or null if cancelled. */
function sheet({ title, text = '', input = null, ok = 'OK' }) {
  const d = $('#sheet');
  $('#sheet-title').textContent = title;
  $('#sheet-text').textContent = text;
  const inp = $('#sheet-input');
  inp.hidden = input === null;
  inp.value = input?.value || '';
  inp.placeholder = input?.placeholder || '';
  inp.maxLength = input?.maxLength || 200;
  $('#sheet-ok').textContent = ok;
  return new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue === 'ok' ? inp.value.trim() : null);
    d.returnValue = '';
    d.showModal();
    if (input !== null) inp.focus();
  });
}

// ---------- sign in ----------

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch {
    state.config = {};
  }
  const c = state.config;
  if (c.communityName) {
    document.title = c.communityName;
    $$('.community-name').forEach((el) => (el.textContent = c.communityName));
  }
  if (c.stats) $('.stats').textContent = `${c.stats.books} books shared by ${c.stats.members} neighbours`;
  $('#photo-mode').hidden = !c.photoScan;
  if (c.whatsappNumber) {
    $('#wa-signin').href = waLink(c.whatsappNumber, 'login');
    $('#wa-signin').hidden = false;
    $('#bot-link').href = waLink(c.whatsappNumber, 'hi');
    $('#bot-link').hidden = false;
  }

  // Sign-in links from the bot look like /#login=CODE
  const code = new URLSearchParams(location.hash.slice(1)).get('login');
  if (code) {
    history.replaceState(null, '', location.pathname);
    try {
      const { token } = await api('/api/login', { method: 'POST', body: { code } });
      state.token = token;
      store.set('token', token);
    } catch (ex) {
      $('#signin .error').textContent = ex.message;
    }
  }

  if (state.token) {
    try {
      state.me = (await api('/api/me')).member;
    } catch {
      state.me = null;
    }
  }
  // Links from WhatsApp notifications look like /?request=7 or /?q=Dune. Remember them across sign-in.
  if (location.search) {
    store.set('pendingLink', location.search);
    history.replaceState(null, '', location.pathname);
  }
  state.me ? showApp() : signedOut();
}

function signedOut() {
  state.token = null;
  state.me = null;
  store.set('token', null);
  stopScanner();
  $('#signin').hidden = false;
  $('#app').hidden = true;
}

function showApp() {
  $('#signin').hidden = true;
  $('#app').hidden = false;
  renderMe();
  refreshRequests();
  if (!state.me.place) {
    showView('find');
    editProfile({ required: true });
    return;
  }
  openPendingLink();
}

/** Opens the page a notification pointed to, if any. */
async function openPendingLink() {
  const params = new URLSearchParams(store.get('pendingLink') || '');
  store.set('pendingLink', null);
  const request = Number(params.get('request'));
  const q = params.get('q');
  if (q) {
    $('#search').value = q;
    return showView('find');
  }
  if (!request && params.get('open') !== 'requests') return showView('find');
  await showView('requests');
  const r = state.requests.find((x) => x.id === request);
  if (r?.status === 'accepted') return openThread(r.id);
  const card = request && document.querySelector(`[data-request="${request}"]`);
  if (card) {
    card.scrollIntoView({ block: 'center' });
    card.classList.add('flash');
  }
}

function renderMe() {
  $('#me-name').textContent = state.me.name;
  $('#me-place').textContent = state.me.place || 'Add your building or locality';
}

/** Name, building and locality. With `required`, it can't be dismissed until a building or locality is set. */
function editProfile({ required = false } = {}) {
  const d = $('#profile');
  const f = $('#profile-form');
  f.displayName.value = state.me.name;
  f.building.value = state.me.building || '';
  f.locality.value = state.me.locality || '';
  f.querySelector('.error').textContent = '';
  $('#profile-title').textContent = required ? 'One last step' : 'About you';
  $('#profile-cancel').hidden = required;
  state.profileRequired = required;
  d.oncancel = (e) => required && e.preventDefault(); // Esc can't skip a required setup
  d.showModal();
}

$('#edit-profile').addEventListener('click', () => editProfile());
$('#profile-form').addEventListener('input', () => ($('#profile-form .error').textContent = ''));
$('#profile-cancel').addEventListener('click', () => $('#profile').close());
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = f.querySelector('.error');
  if (!f.building.value.trim() && !f.locality.value.trim()) {
    err.textContent = 'Please give your building or your locality (or both).';
    return;
  }
  try {
    const body = { name: f.displayName.value, building: f.building.value, locality: f.locality.value };
    state.me = (await api('/api/me', { method: 'PATCH', body })).member;
    renderMe();
    $('#profile').close();
    if (state.profileRequired) openPendingLink();
    else if (!$('#view-me').hidden) loadMe();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  signedOut();
});

$('#delete-account').addEventListener('click', async () => {
  const ok = await sheet({
    title: 'Delete your account?',
    text: 'This removes your account, your books, and all your requests and messages. It cannot be undone.',
    ok: 'Delete everything',
  });
  if (ok === null) return;
  await api('/api/me', { method: 'DELETE' }).catch((ex) => toast(ex.message));
  signedOut();
});

// ---------- navigation ----------

function showView(name) {
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name !== 'add') stopScanner();
  window.scrollTo(0, 0);
  if (name === 'find') return runSearch();
  if (name === 'requests') return showRequestList();
  if (name === 'me') return loadMe();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- find ----------

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});

async function runSearch() {
  const q = $('#search').value.trim();
  let results;
  try {
    ({ results } = await api(`/api/books?q=${encodeURIComponent(q)}`));
  } catch (ex) {
    $('#find-summary').textContent = ex.message;
    return;
  }
  if (q !== $('#search').value.trim()) return; // a newer search is on its way

  $('#find-summary').textContent = q
    ? `${results.length} match${results.length === 1 ? '' : 'es'}`
    : results.length ? 'Recently added' : '';

  if (!results.length) {
    $('#results').innerHTML = q
      ? `<li class="empty">Nobody has “${esc(q)}” yet.<br><button class="btn" id="wish-btn">🔔 Tell me when someone adds it</button></li>`
      : '<li class="empty">No books yet. Be the first to add yours!</li>';
    $('#wish-btn')?.addEventListener('click', async () => {
      await api('/api/wishes', { method: 'POST', body: { query: q } }).catch((ex) => toast(ex.message));
      toast('🔔 We’ll let you know on WhatsApp.');
    });
    return;
  }

  const myOpen = new Map(
    state.requests.filter((r) => r.role === 'borrower' && ['pending', 'accepted'].includes(r.status)).map((r) => [r.book.id, r]),
  );
  $('#results').innerHTML = results
    .map((g) => {
      const owners = g.copies
        .map((c) => {
          const mine = c.owner.id === state.me.id;
          const open = myOpen.get(c.bookId);
          const status = c.status === 'lent' ? '<span class="tag lent">lent out</span>' : '<span class="tag ok">available</span>';
          let action = '';
          if (!mine && open) action = `<span class="tag">${open.status === 'pending' ? 'requested' : 'borrowing'}</span>`;
          else if (!mine && c.status !== 'lent') {
            action = `<button class="btn small want" data-book="${c.bookId}" data-title="${esc(g.title)}" data-owner="${esc(c.owner.name)}">Request</button>`;
          }
          const who = mine ? 'You' : `${esc(c.owner.name)}${c.owner.place ? ` <span class="place">· ${esc(c.owner.place)}</span>` : ''}`;
          return `<div class="owner"><span>${who}</span>${status}${action}</div>`;
        })
        .join('');
      return `<li class="book">${cover(g)}<div class="info">
          <div class="title">${esc(g.title)}</div>
          ${g.author ? `<div class="author">${esc(g.author)}</div>` : ''}
          <div class="owners">${owners}</div></div></li>`;
    })
    .join('');

  $$('#results .want').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const note = await sheet({
        title: `Borrow “${btn.dataset.title}”?`,
        text: `${btn.dataset.owner} will get your request on WhatsApp. Your number is not shared.`,
        input: { placeholder: 'Add a note (optional), e.g. “Could I pick it up Sunday?”' },
        ok: 'Send request',
      });
      if (note === null) return;
      try {
        await api('/api/requests', { method: 'POST', body: { bookId: Number(btn.dataset.book), note } });
        toast(`Request sent to ${btn.dataset.owner}.`);
        await refreshRequests();
        runSearch();
      } catch (ex) {
        toast(ex.message);
      }
    }),
  );
}

// ---------- requests & private chat ----------

async function refreshRequests() {
  try {
    ({ requests: state.requests } = await api('/api/requests'));
  } catch {
    return;
  }
  const waiting = state.requests.filter((r) => r.role === 'owner' && r.status === 'pending').length;
  $('#badge').hidden = !waiting;
  $('#badge').textContent = waiting;
}

const STATUS_TEXT = { pending: 'waiting', accepted: 'on loan', declined: 'declined', cancelled: 'cancelled', returned: 'returned' };

function requestCard(r) {
  const other = `${esc(r.other.name)}${r.other.place ? ` <span class="place">(${esc(r.other.place)})</span>` : ''}`;
  const who = r.role === 'owner' ? `${other} → you` : `from ${other}`;
  const buttons = [];
  if (r.role === 'owner' && r.status === 'pending') {
    buttons.push(`<button class="btn small primary" data-act="accept" data-id="${r.id}">Accept</button>`);
    buttons.push(`<button class="btn small" data-act="decline" data-id="${r.id}">Decline</button>`);
  }
  if (r.status === 'accepted') buttons.push(`<button class="btn small primary" data-chat="${r.id}">💬 Chat</button>`);
  if (r.role === 'owner' && r.status === 'accepted') {
    buttons.push(`<button class="btn small" data-act="returned" data-id="${r.id}">Got it back</button>`);
  }
  if (r.role === 'borrower' && r.status === 'pending') {
    buttons.push(`<button class="btn small" data-act="cancel" data-id="${r.id}">Cancel</button>`);
  }
  const due = r.status === 'accepted' && r.dueAt ? ` · due ${fmtDate(r.dueAt)}` : '';
  return `<li class="book" data-request="${r.id}">${cover(r.book)}<div class="info">
      <div class="title">${esc(r.book.title)}</div>
      <div class="author">${who} · <span class="tag ${r.status === 'accepted' ? 'lent' : ''}">${STATUS_TEXT[r.status]}</span>${due}</div>
      ${r.note && r.status === 'pending' ? `<div class="note">“${esc(r.note)}”</div>` : ''}
      ${buttons.length ? `<div class="actions">${buttons.join('')}</div>` : ''}
    </div></li>`;
}

async function showRequestList() {
  $('#thread').hidden = true;
  $('#requests-list').hidden = false;
  state.thread = null;
  await refreshRequests();
  const rs = state.requests;
  const sections = [
    ['Asking for your books', rs.filter((r) => r.role === 'owner' && r.status === 'pending')],
    ['You lent', rs.filter((r) => r.role === 'owner' && r.status === 'accepted')],
    ['You asked for', rs.filter((r) => r.role === 'borrower' && ['pending', 'accepted'].includes(r.status))],
    ['Recently closed', rs.filter((r) => ['declined', 'cancelled', 'returned'].includes(r.status))],
  ].filter(([, list]) => list.length);

  $('#requests-list').innerHTML = sections.length
    ? sections.map(([title, list]) => `<h3>${title}</h3><ul class="list">${list.map(requestCard).join('')}</ul>`).join('')
    : '<p class="empty">No requests yet. Find a book and tap <b>Request</b>. The owner gets it on WhatsApp.</p>';

  $$('#requests-list [data-act]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/api/requests/${btn.dataset.id}/${btn.dataset.act}`, { method: 'POST' });
        if (btn.dataset.act === 'accept') toast('Accepted! Use Chat to arrange the hand-over.');
      } catch (ex) {
        toast(ex.message);
      }
      showRequestList();
    }),
  );
  $$('#requests-list [data-chat]').forEach((btn) => btn.addEventListener('click', () => openThread(Number(btn.dataset.chat))));
}

async function openThread(id) {
  state.thread = id;
  $('#requests-list').hidden = true;
  $('#thread').hidden = false;
  let data;
  try {
    data = await api(`/api/requests/${id}/messages`);
  } catch (ex) {
    toast(ex.message);
    return showRequestList();
  }
  const r = data.request;
  $('#thread-head').innerHTML = `<div class="book small">${cover(r.book)}<div class="info">
      <div class="title">${esc(r.book.title)}</div>
      <div class="author">${r.role === 'owner' ? 'Lending to' : 'Borrowing from'} ${esc(r.other.name)}${r.other.place ? ` (${esc(r.other.place)})` : ''}${r.dueAt ? ` · due ${fmtDate(r.dueAt)}` : ''}</div></div></div>
    ${r.otherPhone ? `<div class="shared">📞 ${esc(r.other.name)} shared their number: <a target="_blank" rel="noopener" href="${esc(waLink(r.otherPhone))}">+${esc(r.otherPhone)}</a></div>` : ''}`;

  $('#thread-messages').innerHTML = data.messages.length
    ? data.messages.map((m) => `<li class="${m.mine ? 'mine' : ''}">${esc(m.body)}<time>${fmtDate(m.at)}</time></li>`).join('')
    : `<li class="hint">Say hello and arrange the hand-over. Messages are also delivered on WhatsApp. Numbers stay private.</li>`;
  $('#thread-messages').lastElementChild?.scrollIntoView({ block: 'end' });

  const open = r.status === 'accepted';
  $('#thread-form').hidden = !open;
  $('#thread-actions').innerHTML =
    (open && !r.iShared ? `<button class="btn small" data-share>📞 Share my number with ${esc(r.other.name)}</button>` : '') +
    (open && r.iShared ? '<span class="muted small">You shared your number.</span>' : '') +
    `<button class="btn small danger" data-block>Block</button>`;
  $('#thread-actions [data-share]')?.addEventListener('click', async () => {
    const ok = await sheet({
      title: 'Share your number?',
      text: `Only ${r.other.name} will see it, so you can call or WhatsApp each other directly.`,
      ok: 'Share',
    });
    if (ok === null) return;
    await api(`/api/requests/${id}/share`, { method: 'POST' }).catch((ex) => toast(ex.message));
    openThread(id);
  });
  $('#thread-actions [data-block]').addEventListener('click', async () => {
    const ok = await sheet({
      title: `Block ${r.other.name}?`,
      text: 'They won’t be able to request your books or message you, and you won’t be able to request theirs.',
      ok: 'Block',
    });
    if (ok === null) return;
    await api(`/api/requests/${id}/block`, { method: 'POST' }).catch((ex) => toast(ex.message));
    showRequestList();
  });
}

$('#thread-back').addEventListener('click', showRequestList);
$('#thread-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('#thread-input').value.trim();
  if (!body || !state.thread) return;
  try {
    await api(`/api/requests/${state.thread}/messages`, { method: 'POST', body: { body } });
    $('#thread-input').value = '';
    openThread(state.thread);
  } catch (ex) {
    toast(ex.message);
  }
});

// ---------- add ----------

$$('.mode').forEach((b) =>
  b.addEventListener('click', () => {
    const mode = b.dataset.mode;
    $$('.mode').forEach((x) => x.classList.toggle('active', x === b));
    $$('.panel').forEach((p) => (p.hidden = p.id !== `panel-${mode}`));
    $('#add-message').hidden = true;
    if (mode === 'scan') startScanner();
    else stopScanner();
    if (mode === 'type') $('#type-input').focus();
    if (mode === 'photo') $('#photo-input').click();
  }),
);

function parseTyped(text) {
  const by = /^(.*\S)\s+by\s+(\S.*)$/i.exec(text);
  if (by) return { title: by[1], author: by[2] };
  const dash = /^(.*\S)\s+[-–—]\s+(\S.*)$/.exec(text);
  if (dash) return { title: dash[1], author: dash[2] };
  return { title: text, author: '' };
}

$('#type-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#type-input').value.trim();
  if (!text) return;
  const list = $('#suggestions');
  list.innerHTML = '<li class="empty">Searching…</li>';
  let results = [];
  try {
    ({ results } = await api(`/api/lookup?q=${encodeURIComponent(text)}`));
  } catch { /* offline lookups are fine; the typed entry is still offered */ }

  const typed = /^[\d\s-]{9,}[\dXx]?$/.test(text) ? null : parseTyped(text);
  const items = [...results];
  list.innerHTML =
    items
      .map(
        (b, i) => `<li class="book small">${cover(b)}<div class="info"><div class="title">${esc(b.title)}</div>
          <div class="author">${esc(b.author)}</div></div><button class="btn small" data-i="${i}">+ Add</button></li>`,
      )
      .join('') +
    (typed
      ? `<li class="book small typed"><div class="info"><div class="title">${esc(typed.title)}</div>
          <div class="author">${esc(typed.author || 'Add exactly as typed')}</div></div><button class="btn small" data-i="typed">+ Add</button></li>`
      : '') || '<li class="empty">No book found for that ISBN.</li>';

  list.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      const b = btn.dataset.i === 'typed' ? typed : items[Number(btn.dataset.i)];
      addToTray([b]);
      btn.textContent = '✓';
      btn.disabled = true;
    }),
  );
});

// Barcode scanning (one or many books in a row)

async function startScanner() {
  if (state.scanner) return;
  if (!window.Html5Qrcode) return toast('Scanner is still loading. Try again.');
  const F = window.Html5QrcodeSupportedFormats;
  state.scanner = new window.Html5Qrcode('reader', {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  try {
    await state.scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => ({ width: Math.min(320, w * 0.85), height: Math.min(160, h * 0.5) }) },
      onBarcode,
      () => {},
    );
  } catch {
    state.scanner = null;
    toast('Could not open the camera. Allow camera access, or use Type instead.');
  }
}

async function stopScanner() {
  const s = state.scanner;
  state.scanner = null;
  if (s) {
    try { await s.stop(); s.clear(); } catch { /* already stopped */ }
  }
}
$('#stop-scan').addEventListener('click', () => {
  stopScanner();
  $('#panel-scan').hidden = true;
  $$('.mode').forEach((x) => x.classList.remove('active'));
});

async function onBarcode(code) {
  const digits = code.replace(/\D/g, '');
  if (state.scanned.has(digits)) return;
  state.scanned.add(digits);
  if (!/^97[89]/.test(digits)) return toast('That barcode isn’t a book ISBN.');
  navigator.vibrate?.(80);
  const placeholder = { title: '', author: '', isbn: digits, cover: null, loading: true };
  addToTray([placeholder]);
  try {
    const { results } = await api(`/api/lookup?isbn=${digits}`);
    Object.assign(placeholder, results[0] || {}, { loading: false });
    toast(results[0] ? `Found: ${results[0].title}` : 'Not found in the book databases. Please type its title.');
  } catch {
    placeholder.loading = false;
  }
  renderTray();
}

// Shelf / cover photo

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#photo-status');
  status.textContent = 'Reading your photo… this can take up to a minute for a full shelf.';
  try {
    const image = await shrinkImage(file, 2000);
    const { results } = await api('/api/scan-photo', { method: 'POST', body: { image } });
    status.textContent = results.length
      ? `Found ${results.length} book${results.length > 1 ? 's' : ''}. Untick any that are wrong, then add.`
      : 'No readable titles found. Try a closer, well-lit photo.';
    addToTray(results);
  } catch (ex) {
    status.textContent = ex.message;
  }
});

function shrinkImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Could not open that image.'));
    img.src = URL.createObjectURL(file);
  });
}

// Tray: books waiting to be added

function addToTray(books) {
  // Keep the same objects: a scanned barcode's entry is filled in when its lookup finishes.
  for (const b of books) state.tray.push(Object.assign(b, { checked: b.checked ?? true }));
  renderTray();
}

function renderTray() {
  const tray = state.tray;
  $('#tray').hidden = !tray.length;
  $('#tray-list').innerHTML = tray
    .map(
      (b, i) => `<li class="book small ${b.checked ? '' : 'unchecked'}">
        <input type="checkbox" data-i="${i}" ${b.checked ? 'checked' : ''} aria-label="Include">
        ${cover(b)}
        <div class="info">${
          b.loading
            ? `<div class="title muted">Looking up ISBN ${esc(b.isbn)}…</div>`
            : b.title
              ? `<div class="title">${esc(b.title)}</div><div class="author">${esc(b.author)}</div>`
              : `<input class="fix-title" data-i="${i}" placeholder="Book title, e.g. Dune by Frank Herbert">
                 <div class="author">Not found automatically · ISBN ${esc(b.isbn)}</div>`
        }</div>
        <button class="icon-btn" data-remove="${i}" aria-label="Remove">✕</button></li>`,
    )
    .join('');
  updateAddButton();

  $$('#tray-list input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', () => {
      tray[cb.dataset.i].checked = cb.checked;
      renderTray();
    }),
  );
  $$('#tray-list .fix-title').forEach((inp) => {
    // Save as they type so "Add" is enabled without first leaving the box.
    inp.addEventListener('input', () => {
      Object.assign(tray[inp.dataset.i], parseTyped(inp.value.trim()));
      updateAddButton();
    });
    inp.addEventListener('change', renderTray);
  });
  $$('#tray-list [data-remove]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [b] = tray.splice(Number(btn.dataset.remove), 1);
      if (b?.isbn) state.scanned.delete(b.isbn);
      renderTray();
    }),
  );
}

function updateAddButton() {
  const n = state.tray.filter((b) => b.checked && b.title).length;
  $('#add-all').textContent = `Add ${n} book${n === 1 ? '' : 's'}`;
  $('#add-all').disabled = !n;
}

$('#add-all').addEventListener('click', async () => {
  const books = state.tray.filter((b) => b.checked && b.title);
  if (!books.length) return;
  $('#add-all').disabled = true;
  try {
    const { added, skipped } = await api('/api/books', { method: 'POST', body: { books } });
    state.tray = [];
    state.scanned.clear();
    renderTray();
    $('#suggestions').innerHTML = '';
    $('#type-input').value = '';
    const msg = $('#add-message');
    msg.hidden = false;
    msg.textContent =
      `✅ Added ${added.length} book${added.length === 1 ? '' : 's'} to the catalogue.` +
      (skipped ? ` (${skipped} already in your list)` : '');
  } catch (ex) {
    toast(ex.message);
    renderTray();
  }
});

// ---------- me: my books & wishes ----------

async function loadMe() {
  let books, wishes;
  try {
    [{ books }, { wishes }] = await Promise.all([api('/api/my-books'), api('/api/wishes')]);
  } catch (ex) {
    return toast(ex.message);
  }
  $('#mine-count').textContent = books.length ? `(${books.length})` : '';
  $('#mine').innerHTML = books.length
    ? books
        .map(
          (b) => `<li class="book">${cover(b)}<div class="info">
            <div class="title">${esc(b.title)}</div>
            ${b.author ? `<div class="author">${esc(b.author)}</div>` : ''}
            <div class="actions">
              <button class="btn small ${b.status === 'lent' ? 'warn' : ''}" data-toggle="${b.id}" data-status="${b.status}">
                ${b.status === 'lent' ? '🤝 Lent out: mark returned' : '✅ Available: mark lent'}</button>
              <button class="icon-btn" data-del="${b.id}" aria-label="Remove">🗑️</button>
            </div></div></li>`,
        )
        .join('')
    : '<li class="empty">You haven’t added any books yet.</li>';

  $('#wishes').innerHTML = wishes.length
    ? wishes
        .map((w) => `<li class="book small"><div class="info">🔔 ${esc(w.query)}</div><button class="icon-btn" data-unwish="${w.id}" aria-label="Remove">✕</button></li>`)
        .join('')
    : '<li class="muted small">Nothing. When a search finds nothing, tap “Tell me when someone adds it”.</li>';

  $$('#mine [data-toggle]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const status = btn.dataset.status === 'lent' ? 'available' : 'lent';
      await api(`/api/books/${btn.dataset.toggle}`, { method: 'PATCH', body: { status } }).catch((ex) => toast(ex.message));
      loadMe();
    }),
  );
  $$('#mine [data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if ((await sheet({ title: 'Remove this book from the catalogue?', ok: 'Remove' })) === null) return;
      await api(`/api/books/${btn.dataset.del}`, { method: 'DELETE' }).catch((ex) => toast(ex.message));
      loadMe();
    }),
  );
  $$('#wishes [data-unwish]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/api/wishes/${btn.dataset.unwish}`, { method: 'DELETE' }).catch((ex) => toast(ex.message));
      loadMe();
    }),
  );
}

// A sign-in link opened in a tab that already shows the site only changes the #hash.
window.addEventListener('hashchange', () => {
  if (location.hash.includes('login=')) boot();
});

boot();
