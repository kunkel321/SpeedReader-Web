# SpeedReader Web

A reading pacer that runs in your browser and installs to your phone or tablet
like an app. It shows the full text of a book and moves a highlight through it at
a speed you set, so your eye has something to follow.

**→ [Open SpeedReader](https://kunkel321.github.io/SpeedReader-Web/) ←**

You do **not** need to download or clone this repository to use SpeedReader. Just
open the link above. The repo is here for people who want to read or change the
code.

---

## Installing it

SpeedReader is a Progressive Web App, which means it installs from the browser
rather than from an app store. It takes about ten seconds.

**On Android:**

1. Open [the link](https://kunkel321.github.io/SpeedReader-Web/) in Chrome.
2. Tap the three-dot menu at the top right of Chrome.
3. Choose **Install app** or **Add to home screen** — the wording varies by
   Chrome version.
4. A SpeedReader icon appears on your home screen. Open it from there rather
   than from a browser tab; it runs full-screen with no address bar in the way.

**On iPhone or iPad:** open the link in Safari, tap the Share button, and choose
**Add to Home Screen**. Chrome on iOS cannot install web apps, so Safari is
required. This is less tested than Android — see Known limitations below.

**On a computer:** it works fine in a browser tab, no installation needed. Chrome
and Edge also offer an install button in the address bar if you want it in its
own window.

After the first visit it works offline. Your browser keeps a copy of the app, so
it opens on a plane or out of signal exactly as it does at home.

## Getting books into it

**SpeedReader does not come with any books and cannot find them for you.** There
is no store and no catalogue. You supply your own files, and they must already be
on the device you are reading on.

It accepts:

- **EPUB** — converted to reading text when you add it
- **Plain text** (`.txt`) — used as-is

Tap **Add a book**, then pick a file from your device's storage. You only pick a
given book once: SpeedReader copies the text into itself, so the book stays in
your library even if the original file is later moved or deleted.

Where to get files:

- [Project Gutenberg](https://www.gutenberg.org/) — tens of thousands of
  public-domain books, free, in both EPUB and plain text
- [Standard Ebooks](https://standardebooks.org/) — the same books, more carefully
  typeset
- Your own EPUB purchases, if they are not locked with DRM
- [Calibre](https://calibre-ebook.com/) on a computer, with its companion app to
  send books across to a tablet. Calibre can also convert other formats to EPUB.

DRM-protected books from commercial stores will not open. That is a restriction
in the files, not something SpeedReader can work around.

There is a short built-in guide, which appears in your library the first time you
open the app. If you remove it, the **Guide** button brings it back.

## Using it

Tap a book to open it. **Start** begins the pacer; the arrows either side step
back and forward by a sentence. The slider sets words per minute. Tap any word to
jump there.

The **gear** button opens the reading settings:

| Setting | What it does |
| --- | --- |
| Words at a time | Highlight one word per step, or small groups of up to four |
| Smart pacing | Short function words get less time, long words more, balanced so the average stays at your set speed |
| Pause at sentence ends | Adds a beat at each full stop |
| Sentence tint | Washes the current sentence in a quieter colour under the word highlight |
| Centre scroll | Keeps the highlighted word near the middle of the screen |
| Text size, typeface, theme | Comfort settings; theme follows your device unless overridden |

Your position is saved per book, down to the individual word, whenever you pause,
leave a book, or switch away from the app.

## About EPUB conversion

An EPUB is a zip file containing a small website. Turning that into a clean
stream of prose is the least visible part of what SpeedReader does, and the
hardest.

Books made from printed originals carry material that is not part of the
narrative: boxed sidebars, figure captions, photo credits, running heads and page
numbers. On paper your eye skips these without effort. A pacer cannot skip
anything, so dropped into the flow a sidebar cuts a sentence in half and drags
you through an unrelated topic before dumping you back mid-clause.

SpeedReader detects that material and moves it to the end of the book under a
divider, so the narrative runs unbroken and nothing is lost. It also repairs
hyphens left over from print line-breaks, telling a typesetting hyphen from a
real one, so `produc-tion` is mended while `mind-body` is left alone.

Results vary by publisher. EPUBs differ enormously in how they are built, and a
badly assembled one can defeat any parser.

## Privacy

Everything stays on your device. Your books, your reading positions and your
settings are held in your browser's own storage. Nothing is uploaded, there is no
account to create, no tracking, and no server that knows what you read. The app
is served as static files from GitHub Pages.

## Known limitations

- No PDF support yet. Convert to EPUB or plain text first — Calibre does this
  well.
- No text-to-speech. The Windows version has it; the web version does not.
- DRM-protected books cannot be opened.
- Very large books take a few seconds to convert when first added.
- iOS is lightly tested. Safari has historically been less reliable about
  retaining stored data for sites you have not visited in a while, so a long gap
  between sessions could in principle clear your library.

## Running your own copy

Fork this repository, then in the fork's **Settings → Pages** set the source to
**Deploy from a branch**, branch `main`, folder `/ (root)`. After a minute your
copy is live at `https://<your-username>.github.io/<repo-name>/`.

There is no build step and no dependencies. The whole app is these files:

| File | Purpose |
| --- | --- |
| `index.html` | Markup and styling |
| `app.js` | Library, storage, pacer, settings |
| `epub.js` | ZIP reader and EPUB-to-text conversion |
| `sw.js` | Service worker; offline support |
| `guide.txt` | The built-in guide |
| `manifest.json` | Makes it installable |

ZIP inflation uses the browser's built-in `DecompressionStream`, so there is no
third-party library to load and nothing to keep updated.

If you change a file, bump `CACHE` in `sw.js` so browsers pick up the new version
rather than serving the old one from cache.

## Related

The desktop version, [SpeedReader for
Windows](https://github.com/kunkel321/SpeedReader), is written in AutoHotkey v2.
It has more settings and can read aloud. Its companion TextExtractor handles PDF
and EPUB conversion on Windows, and shares its sidebar-separation and hyphen
logic with the web version.
