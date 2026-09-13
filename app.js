import { epubToText, txtToText } from './epub.js';

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
    t.oncomplete = () => res(out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}

const allBooks = () => tx('readonly', s => s.getAll());
const getBook = id => tx('readonly', s => s.get(id));
const putBook = b => tx('readwrite', s => s.put(b));
const delBook = id => tx('readwrite', s => s.delete(id));

const prefs = {
  get(k, d) { try { const v = localStorage.getItem('sr.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sr.' + k, JSON.stringify(v)); } catch {} }
};

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
      <code>.epub</code> or <code>.txt</code> file — from Calibre Sync's download folder, or anywhere
      else on the tablet. Books are copied into the app, so you only pick each one once.</p>`;
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
      frag.append(s);
      el.append(s, document.createTextNode(' '));
    });
    frag.append(el);
  }
  textEl.replaceChildren(frag);
  winFrom = from; winTo = to;

  if (before !== null) {
    const after = wordEl(idx)?.getBoundingClientRect().top;
    if (after != null) pane.scrollTop += (after - before);
  }
}

const wordEl = i => textEl.querySelector(`.w[data-i="${i}"]`);

let lastLineTop = -1;
function show(i, smooth = true) {
  const oldEl = wordEl(idx);
  if (oldEl) oldEl.classList.remove('on');
  idx = i;

  const pi = paraOf(idx);
  if (pi < winFrom + EDGE || pi >= winTo - EDGE) mountWindow(pi, true);

  const el = wordEl(idx);
  if (!el) return;
  el.classList.add('on');

  if (el.offsetTop !== lastLineTop) {              // only scroll when the line changes
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
  progEl.textContent = `${Math.round(p)}%`;
}

// ===========================================================================
// The pacer
// ===========================================================================
function delayFor(word, atParaEnd) {
  const base = 60000 / wpm;
  let d = base;
  if (/[.!?]["'”’)\]]*$/.test(word)) d = base * 2.2;
  else if (/[,;:—–]["'”’)\]]*$/.test(word)) d = base * 1.5;
  else if (word.length > 12) d = base * 1.35;      // long words genuinely take longer
  if (atParaEnd) d += base * 1.2;
  return d;
}

function schedule() {
  const pi = paraOf(idx);
  const atEnd = idx === starts[pi] + paras[pi].length - 1;
  timer = setTimeout(advance, delayFor(currentWord(), atEnd));
}

const currentWord = () => {
  const pi = paraOf(idx);
  return paras[pi][idx - starts[pi]] || '';
};

function advance() {
  if (idx >= total - 1) { stop(); return; }
  show(idx + 1);
  schedule();
}

function play() {
  if (idx >= total - 1) show(0);
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

function setWpm(v) {
  wpm = v;
  wpmIn.value = v;
  wpmOut.textContent = v + ' wpm';
  prefs.set('wpm', v);
}
wpmIn.addEventListener('input', () => setWpm(+wpmIn.value));

document.addEventListener('keydown', e => {
  if (readView.hidden || e.target.closest('button, input')) return;
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
setWpm(wpm);
renderShelf();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
