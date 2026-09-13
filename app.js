import { epubToText, txtToText } from './epub.js';

// Stamped independently of index.html. The two files are cached separately and
// can end up out of step — a new page against a stale script looks like a feature
// that silently does nothing, which is very hard to diagnose from the outside.
const APP_VERSION = '2026-09-13k';

// ===========================================================================
// Storage
// ===========================================================================
// Books live in IndexedDB: the text itself, not a path. A web app can't reopen a
// file by path, so the book has to be copied in. A novel is well under a megabyte
// of plain text, so a shelf of them is no trouble.
const DB = 'speedreader', STORE = 'books';
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) {
        r.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    // A get() that finds nothing has result === undefined, which is a real answer.
    // Test for the request itself, not for a defined result, or "not found" comes
    // back as the request object — truthy, and quietly wrong.
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}

const allBooks = () => tx('readonly', s => s.getAll());
const getBook = id => tx('readonly', s => s.get(id));
const putBook = b => tx('readwrite', s => s.put(b));
const delBook = id => tx('readwrite', s => s.delete(id));

// Reading settings are global, not per book — they describe how you like to read,
// not this particular book. Defaults match the AHK version's out-of-the-box state.
const SETTINGS = {
  chunk: 1, smart: true, sentPause: true,
  tint: true, centre: true, size: 135, font: 'serif', theme: 'auto'
};

// Browsers may evict site storage when the device runs low on space. For a
// library of books the user chose and paced through, that's a real loss, so ask
// for persistent storage. Chrome usually grants it to an installed PWA without
// prompting; if it's refused, nothing breaks, the data is just evictable.
async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

// What the library actually costs, for the settings sheet.
async function storageReport() {
  const books = await allBooks();
  let bytes = 0;
  for (const b of books) bytes += (b.text || '').length * 2;   // UTF-16 in storage
  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.(); } catch {}
  return { count: books.length, bytes, persisted };
}

const prefs = {
  get(k, d) { try { const v = localStorage.getItem('sr.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sr.' + k, JSON.stringify(v)); } catch {} }
};

function loadSettings() {
  const saved = prefs.get('settings', null);
  if (saved) Object.assign(SETTINGS, saved);
}

function saveSettings() { prefs.set('settings', SETTINGS); }

const FONTS = {
  serif: 'Charter,"Iowan Old Style","Palatino Linotype",Georgia,serif',
  sans: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
  // Real Calibri first, so Windows uses the installed font and downloads nothing;
  // everyone else gets the bundled Carlito, which has identical metrics.
  calibri: 'Calibri,Carlito,system-ui,sans-serif',
  mono: 'ui-monospace,"Cascadia Mono",Consolas,"Courier New",monospace'
};

function applySettings() {
  const r = document.documentElement;
  r.style.setProperty('--readSize', (SETTINGS.size / 100) + 'rem');
  r.style.setProperty('--readFont', FONTS[SETTINGS.font] || FONTS.serif);
  if (SETTINGS.theme === 'auto') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', SETTINGS.theme);
  if (!SETTINGS.tint) clearTint();
  if (book) { measureOverhead(); paintChunk(); paintTint(); updateProgress(); }
}

// ===========================================================================
// Elements
// ===========================================================================
const $ = id => document.getElementById(id);
const libView = $('library'), readView = $('reader');
const shelf = $('shelf'), pane = $('pane'), textEl = $('text');
const playBtn = $('play'), wpmIn = $('wpm'), wpmOut = $('wpmOut');
const titleEl = $('bookTitle'), progEl = $('progress'), barEl = $('bar');
const fileIn = $('file'), busy = $('busy'), busyMsg = $('busyMsg');

// ===========================================================================
// Reader state
// ===========================================================================
let book = null;        // { id, title, text, pos }
let paras = [];         // string[][]  — paragraphs of words
let starts = [];        // global index of each paragraph's first word
let total = 0;
let idx = 0;            // global word index
let wpm = prefs.get('wpm', 300);
let timer = null, playing = false;
let sentOf = null;            // word index → sentence id
let sentRange = [];           // sentence id → [firstWord, lastWord]
let shownSent = -1;           // sentence currently tinted
let winFrom = 0, winTo = 0;   // paragraph window currently in the DOM
const WINDOW = 24, EDGE = 6;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ===========================================================================
// Library
// ===========================================================================
function pct(b) {
  return b.total ? Math.min(100, Math.round((b.pos / b.total) * 100)) : 0;
}

async function renderShelf() {
  const books = (await allBooks()).sort((a, b) => (b.opened || 0) - (a.opened || 0));
  shelf.innerHTML = '';
  if (!books.length) {
    shelf.innerHTML = `<p class="empty">No books yet. Tap <strong>Add a book</strong> and pick an
      <code>.epub</code> or <code>.txt</code> file from anywhere on the tablet — books are copied
      into the app, so you only pick each one once. Or tap <strong>Guide</strong> for a short book
      about how to use this one.</p>`;
    return;
  }
  for (const b of books) {
    const card = document.createElement('article');
    card.className = 'card';
    const p = pct(b);
    card.innerHTML = `
      <button class="open" type="button">
        <span class="t"></span>
        <span class="meta"></span>
        <span class="track"><span class="fill" style="width:${p}%"></span></span>
      </button>
      <button class="ren" type="button" aria-label="Rename book">✎</button>
      <button class="del" type="button" aria-label="Remove book">✕</button>`;
    card.querySelector('.t').textContent = b.title;
    card.querySelector('.meta').textContent =
      `${b.total.toLocaleString()} words · ${p ? p + '% read' : 'not started'}` +
      (b.author ? ` · ${b.author}` : '');
    card.querySelector('.open').addEventListener('click', () => openBook(b.id));
    // Publisher metadata is often a production code rather than a title
    // ("BE0324rv0724_BoostingEnergy"), so let the shelf be renamed.
    card.querySelector('.ren').addEventListener('click', async () => {
      const name = prompt('Title for this book:', b.title);
      if (name && name.trim() && name.trim() !== b.title) {
        const rec = await getBook(b.id);
        rec.title = name.trim();
        await putBook(rec);
        renderShelf();
      }
    });
    card.querySelector('.del').addEventListener('click', async () => {
      if (confirm(`Remove "${b.title}" and forget your place in it?`)) {
        await delBook(b.id);
        renderShelf();
      }
    });
    shelf.append(card);
  }
}

// ===========================================================================
// Importing
// ===========================================================================
fileIn.addEventListener('change', async () => {
  const f = fileIn.files?.[0];
  fileIn.value = '';
  if (!f) return;

  busy.hidden = false;
  busyMsg.textContent = 'Reading ' + f.name + '…';
  try {
    const tidy = t => t.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    let title = tidy(f.name.replace(/\.(epub|txt)$/i, ''));
    let author = '', text, note = '';

    if (/\.epub$/i.test(f.name)) {
      const res = await epubToText(await f.arrayBuffer(), fr => {
        busyMsg.textContent = `Converting… ${Math.round(fr * 100)}%`;
      });
      text = res.text;
      if (res.title) title = tidy(res.title);
      author = res.author;
      if (res.sidebarCount) note = `Moved ${res.sidebarCount} sidebar/caption blocks to the end.`;
    } else {
      text = txtToText(await f.text());
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    if (!words) throw new Error('That file had no readable text in it.');

    await putBook({
      id: 'b' + Date.now().toString(36),
      title, author, text, total: words, pos: 0,
      added: Date.now(), opened: Date.now()
    });
    busy.hidden = true;
    await renderShelf();
    if (note) toast(note);
  } catch (err) {
    busy.hidden = true;
    alert('Could not open that file.\n\n' + (err?.message || err));
  }
});

// The desktop version opens its guide on first launch. Same idea here: a new
// shelf is an unhelpful place to land, and the guide doubles as a real book to
// try the pacer on.
const GUIDE_ID = 'guide';

async function addGuide(open) {
  let rec = await getBook(GUIDE_ID);
  if (!rec) {
    const res = await fetch('guide.txt');
    if (!res.ok) throw new Error('guide.txt not found');
    const text = txtToText(await res.text());
    rec = {
      id: GUIDE_ID,
      title: 'SpeedReader — A Guide to Faster Reading',
      author: '', text, total: text.split(/\s+/).filter(Boolean).length,
      pos: 0, added: Date.now(), opened: Date.now()
    };
    await putBook(rec);
  }
  await renderShelf();
  if (open) openBook(GUIDE_ID);
}

$('guide').addEventListener('click', async () => {
  try { await addGuide(true); }
  catch (e) { alert('Could not open the guide.\n\n' + (e?.message || e)); }
});

// First run only: seed the shelf, then never again — so removing the guide
// doesn't just bring it back next time.
async function seedGuide() {
  if (prefs.get('seeded', false)) return;
  try {
    await addGuide(false);
    prefs.set('seeded', true);      // only once it's really there, so a failed
  } catch (e) {                     // first load (offline) retries next time
    console.warn('Could not seed the guide:', e);
  }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4000);
}

// ===========================================================================
// Opening a book
// ===========================================================================
async function openBook(id) {
  book = await getBook(id);
  if (!book) return;

  paras = book.text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
                   .map(p => p.split(/\s+/).filter(Boolean));
  starts = [];
  let n = 0;
  for (const p of paras) { starts.push(n); n += p.length; }
  total = n;

  buildSentences();
  buildWeights();

  // Stored totals can drift if the splitter changes; trust the live count.
  if (book.total !== total) { book.total = total; }
  idx = Math.min(book.pos || 0, Math.max(0, total - 1));

  titleEl.textContent = book.title;
  libView.hidden = true;
  readView.hidden = false;
  document.body.classList.add('reading');

  mountWindow(paraOf(idx), false);
  show(idx, false);
  stop();

  book.opened = Date.now();
  putBook(book);
}

// Sentence boundaries, precomputed once. The pacer needs the sentence a word
// belongs to on every step, so this has to be a lookup rather than a scan.
function buildSentences() {
  sentOf = new Int32Array(total);
  sentRange = [];
  let sid = 0, first = 0;
  for (let pi = 0; pi < paras.length; pi++) {
    const base = starts[pi], words = paras[pi];
    for (let wi = 0; wi < words.length; wi++) {
      const g = base + wi;
      sentOf[g] = sid;
      const last = (wi === words.length - 1);          // paragraph end ends a sentence too
      if (last || /[.!?]["'”’)\]]*$/.test(words[wi])) {
        sentRange.push([first, g]);
        sid++;
        first = g + 1;
      }
    }
  }
  if (first < total) sentRange.push([first, total - 1]);
  shownSent = -1;
}

function closeBook() {
  stop();
  saveNow();
  book = null;
  readView.hidden = true;
  libView.hidden = false;
  document.body.classList.remove('reading');
  renderShelf();
}

// ===========================================================================
// Windowed rendering
// ===========================================================================
// A full book is tens of thousands of words. Putting every one in the DOM makes
// the first paint slow on a tablet, so only a window of paragraphs is mounted and
// it slides as you read.
function paraOf(i) {
  let lo = 0, hi = paras.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function mountWindow(centerPara, keepAnchor) {
  const from = Math.max(0, centerPara - Math.floor(WINDOW / 2));
  const to = Math.min(paras.length, from + WINDOW);
  if (keepAnchor && from === winFrom && to === winTo) return;

  // Remember where the current word sits on screen, so re-mounting doesn't jump.
  const before = keepAnchor ? (wordEl(idx)?.getBoundingClientRect().top ?? null) : null;

  const frag = document.createDocumentFragment();
  for (let pi = from; pi < to; pi++) {
    const words = paras[pi];
    const isHead = words[0] === '##';
    const el = document.createElement(isHead ? 'h2' : 'p');
    el.dataset.p = pi;
    const base = starts[pi];
    words.forEach((w, wi) => {
      if (isHead && wi === 0) return;              // drop the "##" marker itself
      const s = document.createElement('span');
      s.className = 'w';
      s.textContent = w;
      s.dataset.i = base + wi;
      el.append(s);
      if (wi < words.length - 1) {
        // The gaps between words are elements too, so the sentence tint reads as
        // one continuous band instead of a row of stripes.
        const gap = document.createElement('span');
        gap.className = 'sp';
        gap.textContent = ' ';
        el.append(gap);
      }
    });
    frag.append(el);
  }
  textEl.replaceChildren(frag);
  winFrom = from; winTo = to;

  if (before !== null) {
    const after = wordEl(idx)?.getBoundingClientRect().top;
    if (after != null) pane.scrollTop += (after - before);
  }
  // The window was rebuilt, so the marks went with it.
  if (book) { paintChunk(); paintTint(); }
}

const wordEl = i => textEl.querySelector(`.w[data-i="${i}"]`);

function clearMarks(cls) {
  for (const el of textEl.querySelectorAll('.' + cls)) el.classList.remove(cls);
}
const clearTint = () => clearMarks('sent');

// The chunk is idx .. idx+chunk-1, clipped to the sentence so a chunk never
// straddles a full stop — stepping over "...end. Next..." in one go reads badly.
function chunkEnd() {
  let end = Math.min(total - 1, idx + SETTINGS.chunk - 1);
  if (sentOf) {
    const limit = sentRange[sentOf[idx]]?.[1];
    if (limit != null && end > limit) end = limit;
  }
  return end;
}

function paintChunk() {
  clearMarks('on');
  for (let i = idx; i <= chunkEnd(); i++) wordEl(i)?.classList.add('on');
}

function paintTint() {
  if (!SETTINGS.tint || !sentOf) return;
  const r = sentRange[sentOf[idx]];
  if (!r) return;
  clearTint();
  for (let i = r[0]; i <= r[1]; i++) {
    const el = wordEl(i);
    if (!el) continue;
    el.classList.add('sent');
    const gap = el.nextElementSibling;              // carry the tint across the space
    if (i < r[1] && gap?.classList.contains('sp')) gap.classList.add('sent');
  }
}

let lastLineTop = -1;
function show(i, smooth = true) {
  clearMarks('on');
  idx = i;

  const pi = paraOf(idx);
  if (pi < winFrom + EDGE || pi >= winTo - EDGE) mountWindow(pi, true);

  const el = wordEl(idx);
  if (!el) return;
  paintChunk();

  const sid = sentOf ? sentOf[idx] : -1;
  if (SETTINGS.tint && sid !== shownSent) { shownSent = sid; paintTint(); }

  if (SETTINGS.centre && el.offsetTop !== lastLineTop) {   // only scroll on a line change
    lastLineTop = el.offsetTop;
    pane.scrollTo({
      top: el.offsetTop - pane.clientHeight * 0.45,
      behavior: smooth && !reduceMotion ? 'smooth' : 'auto'
    });
  }
  updateProgress();
}

function updateProgress() {
  const p = total ? (idx / total) * 100 : 0;
  barEl.style.width = p.toFixed(1) + '%';
  const mins = Math.round(((total - idx) / Math.max(1, wpm)) * paceOverhead);
  const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m left` : `${mins}m left`;
  progEl.innerHTML = `${Math.round(p)}%<small></small>`;
  progEl.querySelector('small').textContent = left;
}

// ===========================================================================
// The pacer
// ===========================================================================
// ---------------------------------------------------------------------------
// Smart pacing
// ---------------------------------------------------------------------------
// Reading isn't metronomic. The eye barely stops on "the" or "of" and lingers on
// "encephalomyelitis". Word LENGTH is a poor proxy for that — it made "government"
// and "unbelievable" equal. Syllables track it much better.

// Function words: grammatical scaffolding, recognised as a shape rather than read.
const STOP = new Set(('a an the and or but if of to in on at by for from with as is are was ' +
  'were be been being am do does did have has had will would can could shall should may ' +
  'might must it its this that these those i you he she we they them him her his their our ' +
  'my your me us not no nor so than then there here when while about into over under up ' +
  'out off down very too also just only such own same each any all both more most other ' +
  'some who whom which what where why how').split(' '));

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

// Relative time for one word, before normalisation.
function weightOf(word) {
  const bare = word.toLowerCase().replace(/[^a-z']/g, '');
  if (STOP.has(bare)) return 0.55;
  const syl = syllables(word);
  if (syl <= 1) return 0.9;
  if (syl === 2) return 1.05;
  if (syl === 3) return 1.3;
  if (syl === 4) return 1.5;
  return 1.7;
}

// Weights are normalised against the book's own average, so speeding up on "the"
// and slowing on "mitochondria" redistributes time rather than adding it. Without
// this the WPM slider would drift from what it says and the time-remaining
// estimate would be wrong.
let weights = null, meanWeight = 1, paceOverhead = 1;

function buildWeights() {
  weights = new Float32Array(total);
  let sum = 0, g = 0;
  for (const words of paras) {
    for (const w of words) { const x = weightOf(w); weights[g++] = x; sum += x; }
  }
  meanWeight = sum / (total || 1);
  measureOverhead();
}

// Normalising the word weights keeps the average at the set WPM exactly, but the
// sentence, comma and paragraph pauses are real extra time on top. Measure how
// much they add for this book so "time remaining" tells the truth instead of the
// nominal figure. Cheap enough to redo whenever the pacing settings change.
function measureOverhead() {
  if (!total) { paceOverhead = 1; return; }
  let extra = 0;
  for (const words of paras) {
    words.forEach((w, i) => {
      if (SETTINGS.sentPause && /[.!?]["'”’)\]]*$/.test(w)) extra += 1.2;
      if (SETTINGS.smart) {
        if (/[,;:—–]["'”’)\]]*$/.test(w)) extra += 0.5;
        if (i === words.length - 1) extra += 1.2;
      }
    });
  }
  paceOverhead = 1 + extra / total;
}

// Time for the current chunk: the words themselves, plus the natural hesitation
// a reader already makes at punctuation and at the end of a thought.
function chunkDelay() {
  const end = chunkEnd();
  const base = 60000 / wpm;
  let d = 0;

  for (let i = idx; i <= end; i++) {
    d += base * (SETTINGS.smart && weights ? weights[i] / meanWeight : 1);
  }

  const last = wordAt(end);
  if (SETTINGS.sentPause && /[.!?]["'”’)\]]*$/.test(last)) d += base * 1.2;
  if (SETTINGS.smart) {
    if (/[,;:—–]["'”’)\]]*$/.test(last)) d += base * 0.5;
    const pi = paraOf(end);
    if (end === starts[pi] + paras[pi].length - 1) d += base * 1.2;   // end of paragraph
  }
  return d;
}

function schedule() { timer = setTimeout(advance, chunkDelay()); }

const wordAt = g => {
  const pi = paraOf(g);
  return paras[pi][g - starts[pi]] || '';
};

function advance() {
  const next = chunkEnd() + 1;
  if (next >= total) { show(total - 1); stop(); return; }
  show(next);
  schedule();
}

function play() {
  if (idx >= total - 1) { shownSent = -1; show(0); }
  playing = true;
  playBtn.textContent = 'Pause';
  playBtn.classList.add('on');
  schedule();
}

function stop() {
  playing = false;
  clearTimeout(timer);
  playBtn.textContent = idx >= total - 1 ? 'Restart' : 'Start';
  playBtn.classList.remove('on');
  saveNow();
}

function saveNow() {
  if (!book) return;
  book.pos = idx;
  book.total = total;
  putBook(book);
}

// ===========================================================================
// Controls
// ===========================================================================
playBtn.addEventListener('click', () => playing ? stop() : play());
$('back').addEventListener('click', () => jump(-1));
$('fwd').addEventListener('click', () => jump(1));
$('home').addEventListener('click', closeBook);
$('add').addEventListener('click', () => fileIn.click());

// Step by sentence — the useful unit when you lose the thread, not a fixed
// number of words.
function jump(dir) {
  let i = idx;
  const isEnd = j => {
    const pi = paraOf(j);
    return /[.!?]["'”’)\]]*$/.test(paras[pi][j - starts[pi]] || '');
  };
  if (dir < 0) {
    i--;
    while (i > 0 && !isEnd(i - 1)) i--;
  } else {
    while (i < total - 1 && !isEnd(i)) i++;
    i = Math.min(total - 1, i + 1);
  }
  clearTimeout(timer);
  show(Math.max(0, i));
  if (playing) schedule();
}

textEl.addEventListener('click', e => {
  const w = e.target.closest('.w');
  if (!w) return;
  clearTimeout(timer);
  show(+w.dataset.i);
  if (playing) schedule(); else saveNow();
});

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------
const sheet = $('sheet'), sheetBg = $('sheetBg');

function openSheet() {
  syncSheet();
  sheet.hidden = sheetBg.hidden = false;
}
function closeSheet() { sheet.hidden = sheetBg.hidden = true; }

$('gear').addEventListener('click', openSheet);

// Chrome's long-press context menu has nothing useful to offer inside a reader,
// and dismissing it costs a tap. Leave it alone over the settings sheet.
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('#sheet')) e.preventDefault();
});
$('sheetClose').addEventListener('click', closeSheet);
$('sheetDone').addEventListener('click', closeSheet);
sheetBg.addEventListener('click', closeSheet);

// Every control writes straight through and takes effect live — no Apply button,
// because you want to see a tint or a text size against real prose to judge it.
function bind(id, key, read, after) {
  $(id).addEventListener('input', () => {
    SETTINGS[key] = read($(id));
    saveSettings();
    applySettings();
    if (after) after();
  });
}
const bool = el => el.checked;
const num = el => +el.value;
const str = el => el.value;

bind('optChunk', 'chunk', num, () => book && show(idx, false));
bind('optSmart', 'smart', bool);
bind('optSentPause', 'sentPause', bool);
bind('optTint', 'tint', bool, () => { shownSent = -1; if (book) show(idx, false); });
bind('optScroll', 'centre', bool);
bind('optSize', 'size', num, () => { $('optSizeOut').textContent = SETTINGS.size + '%'; });
bind('optFont', 'font', str);
bind('optTheme', 'theme', str);

function syncSheet() {
  const pageV = window.SR_BUILD || '?';
  $('build').textContent = (pageV === APP_VERSION)
    ? 'build ' + APP_VERSION
    : `⚠ version mismatch — page ${pageV}, script ${APP_VERSION}. ` +
      'Close the app completely and reopen it while online.';
  $('build').classList.toggle('warn', pageV !== APP_VERSION);
  storageReport().then(r => {
    const mb = r.bytes / 1048576;
    const size = mb < 1 ? Math.round(r.bytes / 1024) + ' KB' : mb.toFixed(1) + ' MB';
    $('storage').textContent =
      `${r.count} book${r.count === 1 ? '' : 's'} on this device, about ${size}. ` +
      (r.persisted === true
        ? 'Protected from automatic cleanup.'
        : r.persisted === false
          ? 'Not protected — the browser may clear it if storage runs low.'
          : '');
  }).catch(() => {});
  $('optChunk').value = SETTINGS.chunk;
  $('optSmart').checked = SETTINGS.smart;
  $('optSentPause').checked = SETTINGS.sentPause;
  $('optTint').checked = SETTINGS.tint;
  $('optScroll').checked = SETTINGS.centre;
  $('optSize').value = SETTINGS.size;
  $('optSizeOut').textContent = SETTINGS.size + '%';
  $('optFont').value = SETTINGS.font;
  $('optTheme').value = SETTINGS.theme;
}

function setWpm(v) {
  wpm = v;
  wpmIn.value = v;
  wpmOut.textContent = v + ' wpm';
  prefs.set('wpm', v);
  if (book) updateProgress();
}
wpmIn.addEventListener('input', () => setWpm(+wpmIn.value));

document.addEventListener('keydown', e => {
  if (readView.hidden || e.target.closest('button, input')) return;
  if (!sheet.hidden) { if (e.code === 'Escape') closeSheet(); return; }
  if (e.code === 'Space') { e.preventDefault(); playing ? stop() : play(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); jump(-1); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); jump(1); }
  else if (e.code === 'Escape') closeBook();
});

// Pausing on hide is what makes resume trustworthy: switch apps mid-sentence and
// your place is already saved.
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });
window.addEventListener('pagehide', saveNow);

// ===========================================================================
// Boot
// ===========================================================================
// A duplicated id fails silently — getElementById returns the first match and any
// later element with that id is simply never wired up. Catch it at startup.
(function checkIds() {
  const seen = new Set(), dupes = new Set();
  for (const el of document.querySelectorAll('[id]')) {
    if (seen.has(el.id)) dupes.add(el.id); else seen.add(el.id);
  }
  if (dupes.size) throw new Error('Duplicate element id(s): ' + [...dupes].join(', '));
})();

loadSettings();
applySettings();
setWpm(wpm);
renderShelf().then(seedGuide);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
