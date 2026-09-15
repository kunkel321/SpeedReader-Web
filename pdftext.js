// pdftext.js — PDF → reading text, entirely in the browser.
//
// The Windows companion shells out to pdftotext.exe and post-processes its plain
// text. There is no subprocess here, so this uses pdf.js, which hands back every
// text run with its coordinates and font size rather than a finished page of text.
//
// That is more raw material than Poppler gives, not less, and it is the same
// material the fixed-layout path in epub.js works from:
//   • grouping runs by baseline says where each printed line ended, so a hyphen
//     at a line end can be removed with certainty
//   • x positions say where paragraphs are indented, which is usually the only
//     honest signal that a paragraph began
//   • a line that repeats in the same place on thirty pages is a running head,
//     not prose
//
// pdf.js is loaded on demand: a reader who never opens a PDF never downloads it.
import { stitch } from './epub.js';

const LIB = './vendor/pdf.min.mjs';
const WORKER = './vendor/pdf.worker.min.mjs';

let libp = null;
function lib() {
  if (!libp) {
    libp = import(LIB).then(m => {
      // Resolved against this module rather than the page, so it survives the app
      // being served from a sub-path.
      m.GlobalWorkerOptions.workerSrc = new URL(WORKER, import.meta.url).href;
      return m;
    }).catch(err => {
      libp = null;                                   // let a later attempt retry
      throw new Error('The PDF reader could not be loaded. If this is the first '
        + 'PDF since installing, you may need to be online once.\n\n' + (err?.message || err));
    });
  }
  return libp;
}

const median = xs => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// ---------------------------------------------------------------------------
// One page → printed lines
// ---------------------------------------------------------------------------
function collectRuns(pdfjs, tc, vp) {
  const runs = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    // Through the viewport transform, so a rotated page comes out upright and y
    // increases downward like the rest of the web.
    const m = pdfjs.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(m[2], m[3]) || it.height || 10;
    runs.push({ x: m[4], y: m[5], w: it.width, size, str: it.str });
  }
  return runs;
}

// Runs are grouped by baseline, with half a font size of tolerance: superscripts
// and small caps sit slightly off their line's baseline, and exact matching would
// split them onto lines of their own and sort them into the wrong place.
function groupLines(runs) {
  if (!runs.length) return [];
  const tol = Math.max(2, median(runs.map(r => r.size)) * 0.5);
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);

  const groups = [];
  let cur = [sorted[0]], base = sorted[0].y;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - base) > tol) { groups.push(cur); cur = []; base = sorted[i].y; }
    cur.push(sorted[i]);
  }
  groups.push(cur);

  const lines = [];
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x);
    let text = '', end = null;
    for (const r of g) {
      // Word spacing in a PDF is a gap, not a character. A fifth of a font size
      // is comfortably wider than kerning and narrower than a real space.
      if (end !== null && r.x - end > r.size * 0.2 &&
          !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
      text += r.str;
      end = r.x + r.w;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push({
      text,
      y: median(g.map(r => r.y)),
      x0: Math.min(...g.map(r => r.x)),
      x1: Math.max(...g.map(r => r.x + r.w)),
      size: median(g.map(r => r.size))
    });
  }
  return lines;
}

// Two columns read as nonsense taken straight across the page, and the damage is
// done before the text is even assembled: the columns share their baselines, so
// grouping by y welds each left line onto the right line beside it. The split has
// to be found among the runs, before they are grouped.
//
// What it looks for is a gutter — a vertical band near the middle that no text
// crosses. The running head and the page number are kept out of that vote, since
// a centred one spans the gutter and would hide it.
function findGutter(runs, width) {
  if (runs.length < 20) return 0;
  const ys = runs.map(r => r.y).sort((a, b) => a - b);
  const top = ys[Math.floor(ys.length * 0.08)], bot = ys[Math.floor(ys.length * 0.92)];

  const B = 2, n = Math.ceil(width / B);
  const occupied = new Uint8Array(n + 2);
  for (const r of runs) {
    if (r.y < top || r.y > bot) continue;
    const a = Math.max(0, Math.floor(r.x / B)), b = Math.min(n, Math.ceil((r.x + r.w) / B));
    for (let i = a; i <= b; i++) occupied[i] = 1;
  }

  const lo = Math.floor(n * 0.35), hi = Math.ceil(n * 0.65);
  let best = null, start = -1;
  for (let i = lo; i <= hi + 1; i++) {
    if (i <= hi && !occupied[i]) { if (start < 0) start = i; continue; }
    if (start >= 0) {
      if (!best || i - start > best[1] - best[0]) best = [start, i];
      start = -1;
    }
  }
  if (!best || (best[1] - best[0]) * B < width * 0.035) return 0;
  return ((best[0] + best[1]) / 2) * B;
}

function pageLines(pdfjs, tc, vp) {
  const runs = collectRuns(pdfjs, tc, vp);
  if (!runs.length) return [];

  const cut = findGutter(runs, vp.width);
  if (!cut) return groupLines(runs);

  const left = [], right = [], span = [];
  for (const r of runs) {
    if (r.x + r.w <= cut) left.push(r);
    else if (r.x >= cut) right.push(r);
    else span.push(r);
  }
  // Both sides must carry real text, in comparable amounts — otherwise this is a
  // figure or a table sitting in the right half of an ordinary page.
  if (left.length < 10 || right.length < 10) return groupLines(runs);
  if (Math.min(left.length, right.length) < 0.3 * Math.max(left.length, right.length))
    return groupLines(runs);

  const cols = [...groupLines(left), ...groupLines(right)];
  const spanning = groupLines(span);        // head, footer, or a title across both
  if (!spanning.length) return cols;
  const firstY = Math.min(...cols.map(l => l.y));
  return [...spanning.filter(l => l.y < firstY), ...cols,
          ...spanning.filter(l => l.y >= firstY)];
}

// ---------------------------------------------------------------------------
// Running heads, feet and page numbers
// ---------------------------------------------------------------------------
// The signal is repetition in place: the same line, at the top or the bottom of
// the page, over and over, with only the number changing. A chapter title that
// happens to head one page is kept; one that heads forty is furniture.
function markFurniture(pages) {
  const counts = new Map();
  const key = s => s.replace(/[\d]+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

  for (const lines of pages) {
    for (const l of [lines[0], lines[lines.length - 1]]) {
      if (!l || l.text.length > 90) continue;
      const k = key(l.text);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.round(pages.length * 0.3));
  let dropped = 0;
  for (const lines of pages) {
    for (const l of [lines[0], lines[lines.length - 1]]) {
      if (!l || l.drop) continue;
      // A bare page number, arabic or roman, needs no corroboration.
      const bare = /^[\s.\-–—[\]()]*([0-9]{1,4}|[ivxlcdm]{1,7})[\s.\-–—[\]()]*$/i.test(l.text);
      if (bare || (l.text.length <= 90 && counts.get(key(l.text)) >= threshold)) {
        l.drop = true; dropped++;
      }
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Lines → paragraphs
// ---------------------------------------------------------------------------
function paragraphs(pages) {
  const kept = pages.map(ls => ls.filter(l => !l.drop)).filter(ls => ls.length);
  if (!kept.length) return [];

  const all = kept.flat();
  const bodySize = median(all.map(l => l.size));
  const leftEdge = median(all.map(l => l.x0));
  const ends = all.map(l => l.x1).sort((a, b) => a - b);
  const rightEdge = ends[Math.floor(ends.length * 0.9)];

  // A short last line only means "paragraph ended here" if the other lines are
  // flush right. In justified text that is near enough every line, and the signal
  // is excellent; in ragged-right text line lengths vary for no reason at all and
  // the same test would invent a paragraph break every few sentences.
  const flushRight = all.filter(l => l.x1 >= rightEdge - bodySize * 0.5).length;
  const justified = flushRight > all.length * 0.6;

  // Leading, measured within pages only — the step from the foot of one page to
  // the head of the next is not a line gap.
  const gaps = [];
  for (const ls of kept) for (let i = 1; i < ls.length; i++) gaps.push(ls[i].y - ls[i - 1].y);
  const leading = median(gaps.filter(g => g > 0)) || bodySize * 1.2;

  const out = [];
  let para = '', prev = null, prevPage = -1;

  const flush = () => { if (para.trim()) out.push(para.trim()); para = ''; };

  kept.forEach((ls, pageNo) => {
    for (const l of ls) {
      const heading = l.size > bodySize * 1.18 && l.text.length < 100;
      const indented = l.x0 > leftEdge + bodySize * 0.7;
      const samePage = pageNo === prevPage;
      const gap = samePage && prev ? l.y - prev.y : 0;
      const prevShort = justified && prev && prev.x1 < rightEdge - bodySize * 1.5;
      const prevClosed = prev && /[.!?…"'”’)\]]$/.test(prev.text);

      // Moving back UP the page means a column ended and the next began. Like a
      // page break, it carries no usable geometry — the gap is negative and the
      // indent is whatever the new column's first line happens to have.
      const columnBreak = samePage && gap < 0;

      let fresh;
      if (!prev || heading || prev.head) fresh = true;
      else if (indented && !columnBreak) fresh = true;
      else if (!samePage || columnBreak) {
        // No geometry to go on, so fall back to the same test used for
        // hard-wrapped lines: an unfinished sentence followed by a lowercase
        // start is one paragraph, split by the break.
        fresh = prevClosed || !/^[a-z,;”’)—–]/.test(l.text);
      }
      else if (gap > leading * 1.6) fresh = true;
      else if (prevShort && prevClosed) fresh = true;
      else fresh = false;

      if (fresh) flush();

      const piece = heading ? '## ' + l.text : l.text;
      if (!para) {
        para = piece;
      } else if (/[-‐‑]$/.test(para) && /^[a-z]/.test(l.text)) {
        para = para.slice(0, -1) + l.text;           // "produc-" + "tion" → "production"
      } else {
        para += ' ' + l.text;
      }

      l.head = heading;
      prev = l;
      prevPage = pageNo;
    }
  });
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function pdfToText(arrayBuffer, onProgress) {
  const pdfjs = await lib();
  // destroy() lives on the loading task, not the document — the document proxy
  // has no such method, and calling it there throws only after the whole book
  // has been converted.
  const task = pdfjs.getDocument({
    data: new Uint8Array(arrayBuffer),
    isEvalSupported: false
  });
  const doc = await task.promise;

  try {
    const pages = [];
    let chars = 0;

    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const lines = pageLines(pdfjs, await page.getTextContent(), vp);
      for (const l of lines) chars += l.text.length;
      pages.push(lines);
      page.cleanup();
      if (onProgress) onProgress(n / doc.numPages);
    }

    // A scanned book is a stack of photographs with no text in it at all. Say so,
    // rather than importing an empty book.
    if (chars < Math.max(200, doc.numPages * 20)) {
      throw new Error('This PDF has almost no selectable text in it, which usually '
        + 'means it is scanned images of pages. It would need OCR first — Calibre '
        + 'or Acrobat can do that.');
    }

    const dropped = markFurniture(pages);
    const text = stitch(paragraphs(pages)).join('\n\n');
    if (!text.trim()) throw new Error('No readable text could be extracted from this PDF.');

    // Publisher metadata is frequently the authoring file's name rather than a
    // title, which is worse than the filename we already have.
    const info = (await doc.getMetadata().catch(() => null))?.info || {};
    let title = (info.Title || '').trim();
    if (/\.(docx?|indd|qxd|pdf|tex|pages)\b/i.test(title) ||
        /^(untitled|document\d*|microsoft word)/i.test(title)) title = '';

    return { title, author: (info.Author || '').trim(), text, pages: doc.numPages, dropped };
  } finally {
    task.destroy();
  }
}
