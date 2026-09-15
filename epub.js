// epub.js — EPUB → reading text, entirely in the browser.
//
// This is the JavaScript counterpart of the layout-aware path in TextExtractor.ahk.
// Same three ideas:
//   • InDesign paragraph style names say what each paragraph IS
//   • word-span coordinates tell us where the typesetter broke each line, so
//     end-of-line hyphens can be removed with certainty
//   • sentences split across page frames get stitched back together
//
// No external library: ZIP inflation uses the browser's own DecompressionStream.

// ---------------------------------------------------------------------------
// Minimal ZIP reader
// ---------------------------------------------------------------------------
const S_EOCD = 0x06054b50, S_CEN = 0x02014b50;

async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);

  // End-of-central-directory record lives in the last 64KB, after a variable comment.
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 65558); i--) {
    if (dv.getUint32(i, true) === S_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip archive (no end-of-directory record).');

  let n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);

  // Zip64: counts/offsets of 0xffff/0xffffffff mean the real values are in the
  // zip64 record that sits just before the EOCD locator.
  if (n === 0xffff || p === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(dv.getBigUint64(loc + 8, true));
      if (dv.getUint32(z64, true) === 0x06064b50) {
        n = Number(dv.getBigUint64(z64 + 32, true));
        p = Number(dv.getBigUint64(z64 + 48, true));
      }
    }
  }

  const files = new Map();
  for (let i = 0; i < n && p + 46 <= dv.byteLength; i++) {
    if (dv.getUint32(p, true) !== S_CEN) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));

    // The central directory's extra-field length can differ from the local
    // header's, so re-read the local header to find where the data starts.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;

    files.set(name, { method, start, compSize });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  // Inflate lazily — a book has hundreds of images we never touch.
  return {
    names: () => [...files.keys()],
    has: (name) => files.has(name),
    async bytes(name) {
      const f = files.get(name);
      if (!f) return null;
      const raw = u8.subarray(f.start, f.start + f.compSize);
      if (f.method === 0) return raw;
      if (f.method !== 8) throw new Error(`Unsupported compression in ${name}`);
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
    async text(name) {
      const b = await this.bytes(name);
      return b ? new TextDecoder('utf-8').decode(b) : null;
    }
  };
}

// ---------------------------------------------------------------------------
// Paragraph classification (InDesign style names)
// ---------------------------------------------------------------------------
const SIDE_PREFIX = ['Sidebars_', 'SS_SBar', 'Special-Section_SS_SBar'];
const DROP_PREFIX = ['Art_', 'Art-Label', 'Basic-Paragraph', 'Cover_', 'Tables_',
                     'p2-3-Masthead-TOC-Letter_TOC', 'p2-3-Masthead-TOC-Letter_Mast'];
const HEAD_MARKS = ['Heds-for-body-copy', '_hed', 'Sidebar-Head', 'SBar-Head'];

// "Sidebars_SB_hed-3 ParaOverride-2" → "Sidebars_SB_hed-3".
// The override tokens are per-instance formatting noise.
function paraStyle(el) {
  for (const c of el.classList) {
    if (c.startsWith('ParaOverride-') || c.startsWith('CharOverride-')) continue;
    return c;
  }
  return '';
}

function classifyStyle(style) {
  if (!style) return 'body';
  if (SIDE_PREFIX.some(p => style.startsWith(p))) return 'sidebar';
  if (DROP_PREFIX.some(p => style.startsWith(p))) return 'drop';
  return 'body';
}

// "Body-copy_B_Head-D" is NOT a heading — it's a body paragraph with a bold run-in
// lead-in ("Iron. A low level of iron is the most common cause..."). The length
// guard is a second line of defence.
function isHeadingStyle(style, txt) {
  if (txt && txt.length > 100) return false;
  return HEAD_MARKS.some(m => style.includes(m));
}

// ---------------------------------------------------------------------------
// Rebuild one paragraph from its absolutely-positioned word spans
// ---------------------------------------------------------------------------
function paraText(p, thresh) {
  const spans = [];
  let loose = '';

  for (const sp of p.querySelectorAll('span')) {
    if (sp.querySelector('span')) continue;       // only innermost spans hold words
    const txt = sp.textContent;
    if (!txt || !txt.trim()) continue;
    const st = sp.getAttribute('style') || '';
    const tm = /top:\s*(-?[\d.]+)px/i.exec(st);
    if (!tm) { loose += txt; continue; }
    const lm = /left:\s*(-?[\d.]+)px/i.exec(st);
    spans.push({ top: parseFloat(tm[1]), left: lm ? parseFloat(lm[1]) : 0, text: txt });
  }

  if (!spans.length) return (p.textContent || '').replace(/\s+/g, ' ').trim();

  // Group spans into printed lines. Run-in heads and subscripts sit a few units
  // off their line's baseline, so exact matching would split them off and sort
  // them into the wrong place.
  spans.sort((a, b) => a.top - b.top);
  const lines = [];
  let cur = [], prev = null;
  for (const s of spans) {
    if (prev !== null && s.top - prev > thresh) { lines.push(cur); cur = []; }
    cur.push(s);
    prev = s.top;
  }
  if (cur.length) lines.push(cur);

  let out = '';
  for (const ln of lines) {
    ln.sort((a, b) => a.left - b.left);

    // Word spans normally carry their own trailing space. A styled run-in head
    // ("Iron.") does not and would weld onto the next word — but inserting a space
    // unconditionally would break "Vitamin B" + subscript "12".
    let line = '';
    for (const w of ln) {
      const t = w.text;
      if (line && !/\s$/.test(line) && !/^\s/.test(t) &&
          (/[.!?:]$/.test(line) || /^[A-Z]/.test(t))) line += ' ';
      line += t;
    }
    line = line.replace(/\s+$/, '');
    if (!line) continue;

    if (out.endsWith('-') && /^[a-z]/.test(line)) {
      out = out.slice(0, -1) + line;              // "dur-" + "ing" → "during"
    } else if (out) {
      out = out.replace(/\s+$/, '') + ' ' + line;
    } else {
      out = line;
    }
  }
  if (loose) out = (out + ' ' + loose).trim();
  return out.replace(/\s+/g, ' ').trim();
}

// Real line gaps and baseline shifts are strongly bimodal (roughly 300 vs under
// 100 in a typical export, with nothing between), so half the median gap is a safe
// cut-off — and deriving it per chapter adapts to whatever scale the exporter used.
function lineGapThreshold(doc) {
  const gaps = [];
  for (const p of doc.querySelectorAll('p')) {
    const tops = new Set();
    for (const sp of p.querySelectorAll('span')) {
      const m = /top:\s*(-?[\d.]+)px/i.exec(sp.getAttribute('style') || '');
      if (m) tops.add(parseFloat(m[1]));
    }
    const t = [...tops].sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] * 0.5;
}

// ---------------------------------------------------------------------------
// Chapter → blocks
// ---------------------------------------------------------------------------
function fixedLayoutChapter(doc, side) {
  const thresh = lineGapThreshold(doc);
  const out = [];
  let carried = 'body';

  for (const p of doc.querySelectorAll('p')) {
    const style = paraStyle(p);
    let kind;
    if (!style) {
      kind = carried;            // override-only paragraph: belongs to the run it sits in
    } else {
      kind = classifyStyle(style);
      carried = kind;
    }
    if (kind === 'drop') continue;

    const txt = paraText(p, thresh);
    if (!txt) continue;
    (kind === 'sidebar' ? side : out).push(isHeadingStyle(style, txt) ? '## ' + txt : txt);
  }
  return out;
}

// Ordinary reflowable EPUB: no coordinates and usually generic class names, so we
// act only on signals that are standardised. Deliberately conservative — wrongly
// exiling a real paragraph is much worse than leaving a sidebar in place.
const SIDE_SEL = 'aside, [epub\\:type~="sidebar"], [epub\\:type~="note"], ' +
  '[class*="sidebar" i], [class*="callout" i], [class*="boxed" i], ' +
  '[class*="textbox" i], [class*="pullquote" i]';

function reflowableChapter(doc, side) {
  for (const box of doc.querySelectorAll(SIDE_SEL)) {
    const t = (box.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) side.push(t);
    box.remove();                                  // so it isn't read twice
  }
  const out = [];
  for (const el of doc.querySelectorAll('p, h1, h2, h3, h4, li, blockquote')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    out.push(/^h[1-4]$/i.test(el.tagName) ? '## ' + t : t);
  }
  // Some EPUBs use bare divs for paragraphs; fall back to the body text.
  if (!out.length) {
    const t = (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(...t.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean));
  }
  return out;
}

// Page frames routinely cut a sentence in two. Same test TextExtractor applies to
// hard-wrapped lines, one level up: if a block doesn't end a sentence and the next
// starts lowercase, they're one paragraph split by the page break.
export function stitch(blocks) {
  const out = [];
  for (let b of blocks) {
    b = b.trim();
    if (!b) continue;
    const prev = out[out.length - 1];
    if (prev && !b.startsWith('## ') && !prev.startsWith('## ') &&
        !/[.!?:;”"’)\]]$/.test(prev) && /^[a-z,;”’)—–]/.test(b)) {
      out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + b;
    } else {
      out.push(b);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function epubToText(arrayBuffer, onProgress) {
  const zip = await unzip(arrayBuffer);

  // container.xml → OPF path (fall back to any .opf in the archive)
  let opfPath = null;
  const container = await zip.text('META-INF/container.xml');
  if (container) {
    const m = /full-path="([^"]+\.opf)"/i.exec(container);
    if (m) opfPath = m[1];
  }
  if (!opfPath || !zip.has(opfPath)) opfPath = zip.names().find(n => n.toLowerCase().endsWith('.opf'));
  if (!opfPath) throw new Error('No OPF package file found — is this a valid EPUB?');

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfDoc = new DOMParser().parseFromString(await zip.text(opfPath), 'application/xml');

  const manifest = new Map();
  for (const it of opfDoc.querySelectorAll('manifest > item')) {
    manifest.set(it.getAttribute('id'), it.getAttribute('href'));
  }
  const spine = [...opfDoc.querySelectorAll('spine > itemref')]
    .map(ir => manifest.get(ir.getAttribute('idref')))
    .filter(Boolean);
  if (!spine.length) throw new Error('EPUB has no readable spine (chapter order is missing).');

  const title = opfDoc.querySelector('metadata > *|title')?.textContent?.trim()
             || opfDoc.getElementsByTagName('dc:title')[0]?.textContent?.trim() || '';
  const author = opfDoc.getElementsByTagName('dc:creator')[0]?.textContent?.trim() || '';

  const body = [], side = [];
  let fixedPages = 0;

  for (let i = 0; i < spine.length; i++) {
    const href = decodeURIComponent(spine[i].split('#')[0]);
    const path = normalize(opfDir + href);
    if (!zip.has(path)) continue;

    const src = await zip.text(path);
    if (!src) continue;
    const doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    // A parse error element means malformed XHTML; retry as loose HTML.
    const clean = doc.querySelector('parsererror')
      ? new DOMParser().parseFromString(src, 'text/html') : doc;

    clean.querySelectorAll('script, style, head').forEach(n => n.remove());

    // A fixed-layout export positions every word absolutely.
    const isFixed = !![...clean.querySelectorAll('span')].slice(0, 40)
      .find(s => /position\s*:\s*absolute/i.test(s.getAttribute('style') || ''));
    if (isFixed) fixedPages++;

    body.push(...(isFixed ? fixedLayoutChapter(clean, side) : reflowableChapter(clean, side)));
    if (onProgress) onProgress((i + 1) / spine.length);
  }

  let text = stitch(body).join('\n\n');
  if (side.length) {
    const rule = '='.repeat(40);
    text += '\n\n' + rule + '\nSIDEBARS, BOXES AND CAPTIONS\n' + rule + '\n\n' +
            stitch(side).join('\n\n');
  }
  if (!text.trim()) throw new Error('No readable text found in this EPUB.');

  return { title, author, text, fixedLayout: fixedPages > 0, sidebarCount: side.length };
}

function normalize(path) {
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

// Plain .txt: apply the same sentence-stitching so Gutenberg-style hard wraps read
// as paragraphs rather than as a stack of short lines.
export function txtToText(raw) {
  const norm = raw.replace(/\r\n?/g, '\n');
  const blocks = norm.split(/\n\s*\n/).map(b => b.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim());
  return stitch(blocks.filter(Boolean)).join('\n\n');
}
