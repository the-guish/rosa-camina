// rosa camina — read-only price comparison. Everything runs in the browser:
// the data is a static JSON file, the search index is built on load, and the
// payload is cached in IndexedDB so repeat visits start instantly.
//
// There is no product picker: the result list *is* the search. Typing filters
// every price matching the text, so two stores' names for the same bottle sit
// next to each other instead of being collapsed into one "product".

// One copy of this script serves every page. The page that loads it says
// which one it is on <html>. A country page (uy/, ar/) reads its own folder:
// relative URLs resolve against the page, so 'data/…' is that country's.
// The world page (mundo/) names the countries it spans in data-countries,
// reads each one's folder ('../uy/data/…') and shows every price in dollars.
const { country, locale, currency, countries } = document.documentElement.dataset;
const WORLD = countries ? countries.split(' ') : null;

const MANIFEST = 'data/manifest.json';
const RATES = 'data/rates.json';
const dbName = cc => `rosa-camina-${cc}`;   // same origin, so one cache per country
const STORE = 'cache';
const KEY = 'payload';

const MIN_QUERY = 3;      // no word this long yet: the list stays empty
const DEBOUNCE_MS = 150;  // redraw at most this often while typing

const $q = document.getElementById('q');
const $clear = document.getElementById('clear');
const $results = document.getElementById('results');
const $status = document.getElementById('status');
const $footer = document.getElementById('footer');
const $scan = document.getElementById('scan');   // absent from a page older than this script

const money = new Intl.NumberFormat(locale, { style: 'currency', currency });

// -------------------------------------------------------------- analytics
// Umami counts the visits (its tag is on every page; website/docs/umami.md in
// rose-walks says what is collected and why); the events below are what the
// tag cannot see: how long the page took to become usable, what was searched
// and whether it found anything. The tracker may be slow, blocked or absent,
// so a call never throws and never waits: an event is handed over when the
// tracker is there and kept for it otherwise, until the page has finished
// loading. Every duration goes out twice, in milliseconds and as a bucket,
// because the dashboard counts distinct values and 1,340 is not 1,352.

const PENDING = [];
const PAGE = country;   // 'uy', 'ar', 'py' or 'mundo'

function track(name, data) {
  PENDING.push([name, data]);
  flush();
}

function flush() {
  try {
    if (!window.umami) {
      if (PENDING.length > 20) PENDING.shift();   // blocked: keep only the latest
      return;
    }
    while (PENDING.length) window.umami.track(...PENDING.shift());
  } catch { /* analytics never breaks the page */ }
}
window.addEventListener('load', flush);   // the tag's script has run by now, if it ever will

// "Actualizar el sitio" leaves this flag before reloading, so that the next
// country load can be told apart: it is the cost of that button.
const AFTER_REFRESH = (() => {
  try {
    const flag = sessionStorage.getItem('rosa-camina-refreshed') === '1';
    if (flag) sessionStorage.removeItem('rosa-camina-refreshed');
    return flag;
  } catch { return false; }
})();

// '<0.5s', '0.5-1s', ..., '>5s' from the edges, in seconds.
function bucket(ms, edges) {
  const s = n => `${n}s`;
  const secs = ms / 1000;
  if (secs < edges[0]) return `<${s(edges[0])}`;
  for (let i = 1; i < edges.length; i++) {
    if (secs < edges[i]) return `${edges[i - 1]}-${s(edges[i])}`;
  }
  return `>${s(edges[edges.length - 1])}`;
}
const LOAD_EDGES = [0.5, 1, 2, 5];
const SEARCH_EDGES = [0.1, 0.25, 0.5, 1];
const ms = t => Math.round(t);

// What every load reports about the visit it happens in.
function visit() {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    page: PAGE,
    nav: nav ? nav.type : 'unknown',            // navigate, reload, back_forward
    after_refresh: AFTER_REFRESH,               // "Actualizar el sitio" was just pressed
    connection: navigator.connection?.effectiveType || 'unknown',
    scanner: !!($scan && !$scan.hidden),        // this browser can scan
    storage: storageOk !== false,               // IndexedDB worked
  };
}

window.addEventListener('error', event =>
  track('error', { page: PAGE, message: String(event.message || event).slice(0, 200) }));
window.addEventListener('unhandledrejection', event =>
  track('error', { page: PAGE, message: String(event.reason?.message || event.reason).slice(0, 200) }));

let index = [];        // [{ item, terms }]
let codes = new Map(); // barcode -> [item], for a query that is a code
let ready = false;     // data loaded at least once
let timer = 0;
let storageOk = null;  // whether IndexedDB answered, once anything has asked

// ---------------------------------------------------------------- storage
// Every access is guarded: private windows, blocked site data and Safari's
// eviction of script-writable storage all make these throw or come back empty.

function openDb(cc) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(cc), 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { storageOk = true; resolve(req.result); };
    req.onerror = () => { storageOk = false; reject(req.error); };
  });
}

async function cacheGet(cc = country) {
  try {
    const db = await openDb(cc);
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    storageOk = false;
    return null;   // a cache miss is normal, never fatal
  }
}

async function cacheSet(value, cc = country) {
  try {
    const db = await openDb(cc);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    storageOk = false;   // running without storage is fine, it costs a download next time
  }
}

// ------------------------------------------------------------------ search
// Accent- and case-insensitive prefix matching over the product name, the
// store and the product group. At this size a linear scan is instant; when
// the catalogue grows to tens of thousands of rows this is the one function
// to swap for a real inverted index (MiniSearch, FlexSearch).

function terms(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9%]+/g) || [];
}

// Shown on a card of the world page, and searchable there: "argentina yerba".
const COUNTRY_NAMES = { uy: 'Uruguay', ar: 'Argentina', py: 'Paraguay' };

let indexMs = 0;   // what the last buildIndex took, for the load event

function buildIndex(items) {
  const started = performance.now();
  codes = new Map();
  for (const item of items) {
    // `e` is absent, one code, or a list when several listings share a row.
    for (const code of [].concat(item.e || [])) {
      codes.set(code, [...(codes.get(code) || []), item]);
    }
  }
  index = items.map(item => ({
    item,
    terms: terms([item.n, item.s, item.g, item.c && COUNTRY_NAMES[item.c]].filter(Boolean).join(' '))
  }));
  indexMs = performance.now() - started;
}

function search(wanted) {
  return index
    .filter(entry => wanted.every(w => entry.terms.some(t => t.startsWith(w))))
    .map(entry => entry.item)
    .sort(byUnitPrice);
}

// The data file is ordered by store and item id, which is what keeps its
// diffs small; it says nothing about what a reader wants to see first. So
// the page decides: cheapest per kilo or litre, and rows whose size the
// store never published last, since they cannot be compared.
function byUnitPrice(a, b) {
  const aUnknown = a.pp === undefined;
  const bUnknown = b.pp === undefined;
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
  if (!aUnknown && a.pp !== b.pp) return a.pp - b.pp;
  return a.n.localeCompare(b.n, 'es');
}

// ---------------------------------------------------------------- barcodes
// A query that is nothing but the digits of a barcode is looked up instead of
// matched as text, so scanning and typing a code are the same search. A row
// carries the code its store publishes for it (`e`), so the rows a code finds
// are the stores' own listings of that product, one per store that sells it.

const CODE = /^\d{8,14}$/;

// A UPC-A is an EAN-13 with a leading zero, and scanners and stores disagree
// on whether to write it. The catalogue drops leading zeros; so does this.
const codeKey = code => code.replace(/^0+/, '');

function lookup(code) {
  const items = codes.get(codeKey(code)) || [];
  if (items.length) render([...items].sort(byUnitPrice), []);
  else {
    $results.replaceChildren();
    $status.textContent = `No hay precios para el código ${code}.`;
  }
  return items.length;
}

// ----------------------------------------------------------------- render

function nameWithHits(name, wanted) {
  const el = document.createElement('span');
  // Mark the whole word when it starts with one of the typed terms, so the
  // reason a row matched is visible without a separate suggestion list.
  for (const word of name.split(/(\s+)/)) {
    const plain = terms(word)[0] || '';
    const hit = plain && wanted.some(w => plain.startsWith(w));
    const node = document.createElement(hit ? 'mark' : 'span');
    node.textContent = word;
    el.append(node);
  }
  return el;
}

function card(item, wanted) {
  const li = document.createElement('li');
  li.className = 'card';

  const size = item.q === undefined ? null : `${item.q} ${item.u}`;

  li.innerHTML = `
    <div class="name"></div>
    <div class="row">
      ${item.c ? '<span class="tag place"></span>' : ''}
      <span class="tag store"></span>
      ${size ? '<span class="tag size"></span>' : ''}
      <span class="price"></span>
      ${item.pp !== undefined ? '<span class="unit"></span>' : ''}
    </div>`;

  li.querySelector('.name').append(nameWithHits(item.n, wanted));
  if (item.c) li.querySelector('.place').textContent = COUNTRY_NAMES[item.c] || item.c;
  li.querySelector('.store').textContent = item.s;
  if (size) li.querySelector('.size').textContent = size;
  li.querySelector('.price').textContent = money.format(item.p);
  if (item.pp !== undefined) {
    li.querySelector('.unit').textContent = `${money.format(item.pp)} por ${item.pu}`;
  }
  return li;
}

function render(items, wanted) {
  // No row is singled out: the page states prices and the reader compares
  // them. Deciding which listings are the same product is deferred.
  $results.replaceChildren(...items.map(item => card(item, wanted)));

  const n = items.length;
  $status.textContent = n ? `${n} ${n === 1 ? 'precio' : 'precios'}` : 'Sin resultados.';
}

// The landing state, and anything shorter than MIN_QUERY: no rows, just a hint.
function idle() {
  $results.replaceChildren();
  $status.textContent = ready
    ? `Escribí al menos ${MIN_QUERY} letras para ver precios.`
    : 'Cargando precios…';
}

// A search is reported once the typing settles, not on every keystroke: one
// event per query, with what it found and how long the last redraw took from
// the keystroke to the drawn list (the debounce included, since that is what
// the reader waits) and the slowest redraw on the way there.
const SETTLE_MS = 1500;
let typedAt = 0;        // the last keystroke, for the latency
let burst = null;       // the query being typed: { query, kind, ... }
let settle = 0;
let lastSent = '';

function noteSearch(query, kind, words, results, redraw) {
  const latency = typedAt ? performance.now() - typedAt : redraw;
  if (!burst || burst.query !== query) burst = { query, kind, words, redraws: 0, slowest: 0 };
  burst.results = results;
  burst.latency = latency;
  burst.redraws += 1;
  burst.slowest = Math.max(burst.slowest, redraw);
  clearTimeout(settle);
  settle = setTimeout(sendSearch, SETTLE_MS);
}

function sendSearch() {
  clearTimeout(settle);
  if (!burst || burst.query === lastSent) return;
  lastSent = burst.query;
  const hits = burst.results === 0 ? '0' : burst.results <= 10 ? '1-10'
    : burst.results <= 50 ? '11-50' : burst.results <= 200 ? '51-200' : '>200';
  track('search', {
    page: PAGE,
    kind: burst.kind,                 // text or barcode
    query: burst.query.slice(0, 100),
    words: burst.words,
    results: burst.results,
    hits,
    latency_ms: ms(burst.latency),
    latency: bucket(burst.latency, SEARCH_EDGES),
    redraw_ms: ms(burst.slowest),
    redraws: burst.redraws,
  });
}

// Flush what was being typed when the page goes away.
document.addEventListener('visibilitychange', () => { if (document.hidden) sendSearch(); });

function update() {
  const started = performance.now();
  const code = $q.value.trim();
  if (ready && CODE.test(code)) {
    const found = lookup(code);
    noteSearch(code, 'barcode', 1, found, performance.now() - started);
    return;
  }
  const wanted = terms($q.value);
  const long = wanted.filter(w => w.length >= MIN_QUERY);
  if (!long.length) {
    sendSearch();   // the previous query is over, if there was one
    idle();
    return;
  }
  const items = search(wanted);
  render(items, wanted);
  noteSearch(wanted.join(' '), 'text', wanted.length, items.length, performance.now() - started);
}

// ------------------------------------------------------------------ events

$q.addEventListener('input', () => {
  typedAt = performance.now();
  $clear.hidden = !$q.value;
  clearTimeout(timer);
  timer = setTimeout(update, DEBOUNCE_MS);
});

$q.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $q.value = '';
    $clear.hidden = true;
    update();
  } else if (event.key === 'Enter') {
    event.preventDefault();   // nothing to submit; fold the keyboard away
    clearTimeout(timer);
    update();
    sendSearch();             // Enter means "that is my query"
    $q.blur();
  }
});

$clear.addEventListener('click', () => {
  $q.value = '';
  $clear.hidden = true;
  clearTimeout(timer);
  update();
  $q.focus();
});

// -------------------------------------------------------------------- scan
// "Escanear código" reads a barcode with the phone's camera and searches for
// it. It needs the browser's own BarcodeDetector, which Chrome on Android has
// and most others do not; where it is missing the button stays hidden and a
// code can still be typed. Nothing leaves the phone: frames are read here.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const SCAN_EVERY_MS = 150;

let $scanner = null;   // the dialog, built on first use
let stream = null;     // the camera, while the dialog is open

function scannerDialog() {
  if ($scanner) return $scanner;
  $scanner = document.createElement('dialog');
  $scanner.className = 'scanner';
  $scanner.setAttribute('aria-label', 'Escanear código');
  $scanner.innerHTML = `
    <video playsinline muted></video>
    <p>Apuntá la cámara al código de barras.</p>
    <button type="button">Cancelar</button>`;
  $scanner.querySelector('button').addEventListener('click', () => $scanner.close());
  // Every way out (a code read, Cancelar, Escape, the back button) ends here.
  $scanner.addEventListener('close', () => {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    $scanner.querySelector('video').srcObject = null;
  });
  document.body.append($scanner);
  return $scanner;
}

// A phone has several rear cameras and "the rear one" may be the ultra-wide,
// whose focus is fixed: a product held close is a blur and the shelf a metre
// behind it is sharp. So the camera wanted is one that can refocus by itself.
// The first answer is kept when it can; otherwise the other rear cameras are
// tried (their labels are readable once the permission is granted), and if
// none can, the first answer's kind is what this phone has.
const SHARP = { width: { ideal: 1920 }, height: { ideal: 1080 } };   // the default is 640x480
const canRefocus = media =>
  (media.getVideoTracks()[0].getCapabilities?.().focusMode || []).includes('continuous');
const stop = media => media.getTracks().forEach(track => track.stop());

async function openCamera() {
  const first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', ...SHARP } });
  if (canRefocus(first)) return first;
  const used = first.getVideoTracks()[0].getSettings().deviceId;
  const others = (await navigator.mediaDevices.enumerateDevices())
    .filter(d => d.kind === 'videoinput' && d.deviceId !== used && /back|rear|environment|trasera/i.test(d.label));
  if (!others.length) return first;
  stop(first);   // a phone rarely lends two cameras at once
  for (const { deviceId } of others) {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, ...SHARP } });
      if (canRefocus(media)) return media;
      stop(media);
    } catch { /* that one would not open; try the next */ }
  }
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', ...SHARP } });
}

// Keep refocusing, and zoom in a little: every lens has a nearest distance it
// can focus at, and a small code fills enough of the frame from beyond it.
async function tune(media) {
  const track = media.getVideoTracks()[0];
  const can = track.getCapabilities?.() || {};
  const wanted = {};
  if ((can.focusMode || []).includes('continuous')) wanted.focusMode = 'continuous';
  if (can.zoom) wanted.zoom = Math.min(Math.max(2, can.zoom.min), can.zoom.max);
  try { await track.applyConstraints({ advanced: [wanted] }); } catch { /* it scans untuned */ }
}

async function scan() {
  const pressed = performance.now();
  const dialog = scannerDialog();
  const video = dialog.querySelector('video');
  let mine;
  try {
    mine = await openCamera();
    await tune(mine);
  } catch {
    $status.textContent = 'No se pudo usar la cámara. Revisá el permiso del sitio.';
    track('scan', { page: PAGE, outcome: 'no_camera', ms: ms(performance.now() - pressed) });
    return;
  }
  stream = mine;
  video.srcObject = mine;
  dialog.showModal();
  try { await video.play(); } catch { /* closed before the first frame */ }

  const supported = await BarcodeDetector.getSupportedFormats();
  const detector = new BarcodeDetector({ formats: FORMATS.filter(f => supported.includes(f)) });
  while (stream === mine) {
    let found = [];
    try { found = await detector.detect(video); } catch { /* no frame yet */ }
    const hit = found.find(b => CODE.test(b.rawValue));
    if (hit && stream === mine) {
      dialog.close();
      const took = performance.now() - pressed;
      $q.value = hit.rawValue;
      $clear.hidden = false;
      clearTimeout(timer);
      typedAt = 0;   // no keystroke to measure from
      update();
      track('scan', {
        page: PAGE, outcome: 'found', format: hit.format,
        results: (codes.get(codeKey(hit.rawValue)) || []).length,
        ms: ms(took), took: bucket(took, LOAD_EDGES),
      });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, SCAN_EVERY_MS));
  }
  track('scan', {
    page: PAGE, outcome: document.hidden ? 'tab_hidden' : 'cancelled',
    ms: ms(performance.now() - pressed),
  });
}

if ($scan && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
  $scan.hidden = false;
  $scan.addEventListener('click', scan);
  // A camera left on behind a hidden tab is a lit indicator and a drained battery.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && $scanner?.open) $scanner.close();
  });
}

// -------------------------------------------------------------------- boot
// Show the cached data at once, then check the manifest and swap in a newer
// version if the build has moved on (stale-while-revalidate).

// The catalogue over the network, timed: the wait for the bytes, the parse,
// and how many bytes they were (from Resource Timing, which knows the
// compressed size on the wire).
async function download(url, cc, reason) {
  const started = performance.now();
  const response = await fetch(url);
  const text = await response.text();
  const fetched = performance.now();
  const payload = JSON.parse(text);
  const parsed = performance.now();
  const entry = performance.getEntriesByName(response.url).pop();
  track('catalog', {
    country: cc,
    reason,                                     // cold, update or refresh
    fetch_ms: ms(fetched - started),
    fetch: bucket(fetched - started, LOAD_EDGES),
    parse_ms: ms(parsed - fetched),
    bytes: entry ? entry.encodedBodySize : text.length,
    rows: payload.items.length,
    connection: navigator.connection?.effectiveType || 'unknown',
  });
  return payload;
}

const ageDays = generated => Math.round((Date.now() - Date.parse(generated)) / 86400000);

function apply(payload) {
  buildIndex(payload.items);
  ready = true;
  update();
  $footer.textContent =
    `${payload.items.length} precios · ${payload.stores.join(' · ')} · datos del ${payload.generated}`;
}

// One event per visit to a country page, sent when the boot sequence is
// over so that it can say how it went: where the first usable list came
// from, how long that took since navigation began, and what the check for
// a newer catalogue found.
function reportLoad(source, check, usableAt, payload) {
  const data = {
    ...visit(),
    source,                                      // cache, network or none
    check,                                       // current, updated, offline or failed
    ms: ms(usableAt),
    took: bucket(usableAt, LOAD_EDGES),
    index_ms: ms(indexMs),
  };
  if (payload) {
    data.rows = payload.items.length;
    data.age_days = ageDays(payload.generated);
  }
  track('load', data);
}

async function boot() {
  // Before the site had countries there was one cache under this name;
  // nothing reads it any more, so give the space back.
  try { indexedDB.deleteDatabase('rosa-camina'); } catch { /* no storage */ }

  const cached = await cacheGet();
  let usableAt = 0;
  if (cached) {
    apply(cached.payload);
    usableAt = performance.now();
  }

  let manifest;
  try {
    manifest = await (await fetch(MANIFEST, { cache: 'no-cache' })).json();
  } catch {
    if (!cached) $status.textContent = 'No se pudieron cargar los precios.';
    // offline with a warm cache: keep showing what we have
    reportLoad(cached ? 'cache' : 'none', 'offline', usableAt, cached?.payload);
    return;
  }

  if (cached && cached.version === manifest.version) {
    reportLoad('cache', 'current', usableAt, cached.payload);
    return;
  }

  try {
    const payload = await download(manifest.url, country, cached ? 'update' : AFTER_REFRESH ? 'refresh' : 'cold');
    await cacheSet({ version: manifest.version, payload });
    apply(payload);
    if (!cached) usableAt = performance.now();
    reportLoad(cached ? 'cache' : 'network', 'updated', usableAt, payload);
  } catch {
    if (!cached) $status.textContent = 'No se pudieron cargar los precios.';
    reportLoad(cached ? 'cache' : 'none', 'failed', usableAt, cached?.payload);
  }
}

// ------------------------------------------------------------------- world
// The world page has no data of its own. For each country it takes the
// catalogue (from that country's cache when the manifest says it is current,
// which also warms the cache for the country page) and the exchange rates,
// and converts every price to dollars once, here, on load: results are sorted
// by price per kilo or litre across countries, so every match would need
// converting on every keystroke otherwise. The conversion happens on the
// in-memory rows only. What is cached stays in local currency, because the
// country pages read the same cache.

async function loadCountry(cc) {
  const base = `../${cc}/`;
  const manifest = await (await fetch(base + MANIFEST, { cache: 'no-cache' })).json();
  let cached = await cacheGet(cc);
  let source = 'cache';
  if (!cached || cached.version !== manifest.version) {
    const payload = await download(base + manifest.url, cc, cached ? 'update' : AFTER_REFRESH ? 'refresh' : 'cold');
    cached = { version: manifest.version, payload };
    await cacheSet(cached, cc);
    source = 'network';
  }
  const quotes = await (await fetch(base + RATES, { cache: 'no-cache' })).json();
  const known = quotes.rates.filter(r => r !== null);
  if (!known.length) throw new Error(`no exchange rate for ${cc}`);
  return { cc, payload: cached.payload, rate: known[known.length - 1], currency: quotes.currency, source };
}

function inDollars({ cc, payload, rate }) {
  return payload.items.map(item => {
    const row = { ...item, c: cc, p: item.p / rate };
    if (item.pp !== undefined) row.pp = item.pp / rate;
    return row;
  });
}

async function bootWorld() {
  const loaded = await Promise.allSettled(WORLD.map(loadCountry));
  const ok = loaded.filter(r => r.status === 'fulfilled').map(r => r.value);
  const missing = WORLD.filter(cc => !ok.some(c => c.cc === cc));
  if (!ok.length) {
    $status.textContent = 'No se pudieron cargar los precios.';
    track('load', { ...visit(), source: 'none', check: 'failed', ms: ms(performance.now()), missing: missing.join(' ') });
    return;
  }
  buildIndex(ok.flatMap(inDollars));
  ready = true;
  update();
  // The world page is usable once every country answered; "network" when
  // any of them had to be downloaded.
  const usableAt = performance.now();
  track('load', {
    ...visit(),
    source: ok.some(c => c.source === 'network') ? 'network' : 'cache',
    check: missing.length ? 'partial' : 'current',
    ms: ms(usableAt),
    took: bucket(usableAt, LOAD_EDGES),
    index_ms: ms(indexMs),
    rows: index.length,
    age_days: Math.max(...ok.map(c => ageDays(c.payload.generated))),
    missing: missing.join(' '),
  });

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const parts = ok.map(c =>
    `${COUNTRY_NAMES[c.cc]}: ${c.payload.items.length} precios del ${c.payload.generated}, ` +
    `1 US$ = ${number.format(c.rate)} ${c.currency}`);
  if (missing.length) parts.push(`sin datos de ${missing.map(cc => COUNTRY_NAMES[cc] || cc).join(', ')}`);
  $footer.textContent = parts.join(' · ');
}

if (WORLD) bootWorld(); else boot();
