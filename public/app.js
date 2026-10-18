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
  tray: [], // books waiting to be added: { title, author, isbn, cover, checked }
  scanner: null,
  scanned: new Set(),
};

// ---------- api ----------

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
    signOut();
    throw new Error('Please join again.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

const waLink = (phone, text) => `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

function cover(b) {
  const initials = esc((b.title || '?').replace(/^(the|a|an)\s+/i, '').slice(0, 2));
  const hue = [...(b.title || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const url = b.cover || b.cover_url;
  return `<div class="cover" style="--hue:${hue}">${initials}${
    url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''
  }</div>`;
}

// ---------- join ----------

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
  $('#code-field').hidden = !c.needsCode;
  $('#code-field input').required = Boolean(c.needsCode);
  $('#photo-mode').hidden = !c.photoScan;
  if (c.whatsappNumber) {
    $('#bot-link').href = waLink(c.whatsappNumber, 'hi');
    $('#bot-link').hidden = false;
  }

  if (state.token) {
    try {
      state.me = (await api('/api/me')).member;
    } catch {
      state.me = null;
    }
  }
  state.me ? showApp() : showJoin();
}

function showJoin() {
  $('#join').hidden = false;
  $('#app').hidden = true;
}

function showApp() {
  $('#join').hidden = true;
  $('#app').hidden = false;
  $('#me-name').textContent = state.me.name;
  $('#me-phone').textContent = '+' + state.me.phone;
  showView('find');
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = f.querySelector('.error');
  err.textContent = '';
  try {
    const data = await api('/api/join', {
      method: 'POST',
      body: { name: f.name.value, phone: f.phone.value, code: f.code.value },
    });
    state.token = data.token;
    state.me = data.member;
    store.set('token', data.token);
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

function signOut() {
  state.token = null;
  state.me = null;
  store.set('token', null);
  stopScanner();
  showJoin();
}
$('#logout').addEventListener('click', signOut);

// ---------- navigation ----------

function showView(name) {
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name !== 'add') stopScanner();
  if (name === 'find') runSearch();
  if (name === 'mine') loadMine();
  window.scrollTo(0, 0);
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

  const community = state.config.communityName || 'MuhallaReads';
  $('#find-summary').textContent = q
    ? `${results.length} match${results.length === 1 ? '' : 'es'}`
    : results.length ? 'Recently added' : '';

  if (!results.length) {
    $('#results').innerHTML = q
      ? `<li class="empty">Nobody has “${esc(q)}” yet.<br>
           <a class="btn" target="_blank" rel="noopener" href="${esc(waLink('', `Does anyone have "${q}"? 📚`))}">Ask on WhatsApp</a></li>`
      : `<li class="empty">No books yet — be the first to add yours!</li>`;
    return;
  }

  $('#results').innerHTML = results
    .map((g) => {
      const owners = g.copies
        .map((c) => {
          const mine = c.owner.id === state.me.id;
          const status = c.status === 'lent' ? '<span class="tag lent">lent out</span>' : '<span class="tag ok">available</span>';
          const ask = mine
            ? ''
            : `<a class="wa" target="_blank" rel="noopener" href="${esc(
                waLink(c.owner.phone, `Hi ${c.owner.name}! Could I borrow "${g.title}"? (found it on ${community})`),
              )}">Ask</a>`;
          return `<div class="owner"><span>${mine ? 'You' : esc(c.owner.name)}</span>${status}${ask}</div>`;
        })
        .join('');
      return `<li class="book">${cover(g)}<div class="info">
          <div class="title">${esc(g.title)}</div>
          ${g.author ? `<div class="author">${esc(g.author)}</div>` : ''}
          <div class="owners">${owners}</div></div></li>`;
    })
    .join('');
}

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
  } catch { /* offline lookups are fine — the typed entry is still offered */ }

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
  if (!window.Html5Qrcode) return toast('Scanner is still loading — try again.');
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
  } catch (ex) {
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
    toast(results[0] ? `Found: ${results[0].title}` : `ISBN ${digits}: please type the title`);
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
  for (const b of books) state.tray.push({ checked: true, ...b });
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
              : `<input class="fix-title" data-i="${i}" placeholder="Type the title (ISBN ${esc(b.isbn)})">`
        }</div>
        <button class="icon-btn" data-remove="${i}" aria-label="Remove">✕</button></li>`,
    )
    .join('');
  const n = tray.filter((b) => b.checked && b.title).length;
  $('#add-all').textContent = `Add ${n} book${n === 1 ? '' : 's'}`;
  $('#add-all').disabled = !n;

  $$('#tray-list input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', () => {
      tray[cb.dataset.i].checked = cb.checked;
      renderTray();
    }),
  );
  $$('#tray-list .fix-title').forEach((inp) =>
    inp.addEventListener('change', () => {
      Object.assign(tray[inp.dataset.i], parseTyped(inp.value.trim()));
      renderTray();
    }),
  );
  $$('#tray-list [data-remove]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [b] = tray.splice(Number(btn.dataset.remove), 1);
      if (b?.isbn) state.scanned.delete(b.isbn);
      renderTray();
    }),
  );
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

// ---------- my books ----------

async function loadMine() {
  let books;
  try {
    ({ books } = await api('/api/my-books'));
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
                ${b.status === 'lent' ? '🤝 Lent out — mark returned' : '✅ Available — mark lent'}</button>
              <button class="icon-btn" data-del="${b.id}" aria-label="Remove">🗑️</button>
            </div></div></li>`,
        )
        .join('')
    : '<li class="empty">You haven’t added any books yet.</li>';

  $$('#mine [data-toggle]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const status = btn.dataset.status === 'lent' ? 'available' : 'lent';
      await api(`/api/books/${btn.dataset.toggle}`, { method: 'PATCH', body: { status } }).catch((ex) => toast(ex.message));
      loadMine();
    }),
  );
  $$('#mine [data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this book from the catalogue?')) return;
      await api(`/api/books/${btn.dataset.del}`, { method: 'DELETE' }).catch((ex) => toast(ex.message));
      loadMine();
    }),
  );
}

boot();
