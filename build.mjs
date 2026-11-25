// Builds index.html, a self-contained slide deck, from ai-workflow.md.
//
//   npm install            once, for marked (the Markdown parser)
//   node build.mjs [path]  path defaults to ai-workflow.md beside this script
//
// Each part of the Markdown between horizontal rules becomes one slide; the part before the first
// rule is the title slide. Mermaid diagrams are rendered at build time with mermaid-cli 11.4.2
// (through npx), once in a light and once in a dark palette, and inlined as SVG; the page loads
// nothing external. Without JavaScript, and when printed, every slide shows one after another.
//
// The page is meant to be shared, so the build refuses a relative link: nothing beside the page
// is published, and every link must work for a reader off this machine.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const MERMAID_CLI = '@mermaid-js/mermaid-cli@11.4.2';
const DIAGRAM_FONT = 'Arial, Helvetica, sans-serif';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(process.argv[2] ?? join(here, 'ai-workflow.md'));
const outPath = join(here, 'index.html');
if (!existsSync(srcPath)) throw new Error(`Markdown source not found: ${srcPath}`);

// --- Mermaid ---------------------------------------------------------------------------------

const PALETTES = {
    light: {
        darkMode: false, background: '#ffffff', fontFamily: DIAGRAM_FONT, fontSize: '15px',
        primaryColor: '#e8eefc', primaryTextColor: '#1b1f24', primaryBorderColor: '#7f9be6',
        secondaryColor: '#f3f4f6', secondaryTextColor: '#1b1f24', secondaryBorderColor: '#c3c9d2',
        tertiaryColor: '#f8f9fb', tertiaryTextColor: '#1b1f24', tertiaryBorderColor: '#d5dae1',
        lineColor: '#5a6270', textColor: '#1b1f24', mainBkg: '#e8eefc', nodeBorder: '#7f9be6',
        clusterBkg: '#f5f7fa', clusterBorder: '#c9d0da', titleColor: '#1b1f24', edgeLabelBackground: '#ffffff',
        actorBkg: '#e8eefc', actorBorder: '#7f9be6', actorTextColor: '#1b1f24', actorLineColor: '#9aa3af',
        signalColor: '#3b4250', signalTextColor: '#1b1f24', labelBoxBkgColor: '#f3f4f6',
        labelBoxBorderColor: '#c3c9d2', labelTextColor: '#1b1f24', loopTextColor: '#1b1f24',
        noteBkgColor: '#fff6dc', noteBorderColor: '#e2c46b', noteTextColor: '#1b1f24',
        activationBkgColor: '#dfe6f7', activationBorderColor: '#7f9be6', sequenceNumberColor: '#ffffff',
    },
    dark: {
        darkMode: true, background: '#171a20', fontFamily: DIAGRAM_FONT, fontSize: '15px',
        primaryColor: '#1f2a44', primaryTextColor: '#e5e7eb', primaryBorderColor: '#5b7fe0',
        secondaryColor: '#232833', secondaryTextColor: '#e5e7eb', secondaryBorderColor: '#3a414d',
        tertiaryColor: '#1b1f27', tertiaryTextColor: '#e5e7eb', tertiaryBorderColor: '#343a45',
        lineColor: '#a3acb9', textColor: '#e5e7eb', mainBkg: '#1f2a44', nodeBorder: '#5b7fe0',
        clusterBkg: '#1b1f27', clusterBorder: '#3a414d', titleColor: '#e5e7eb', edgeLabelBackground: '#171a20',
        actorBkg: '#1f2a44', actorBorder: '#5b7fe0', actorTextColor: '#e5e7eb', actorLineColor: '#5a6270',
        signalColor: '#c3cad5', signalTextColor: '#e5e7eb', labelBoxBkgColor: '#232833',
        labelBoxBorderColor: '#3a414d', labelTextColor: '#e5e7eb', loopTextColor: '#e5e7eb',
        noteBkgColor: '#3a3322', noteBorderColor: '#8a7440', noteTextColor: '#f0e6cc',
        activationBkgColor: '#26324f', activationBorderColor: '#5b7fe0', sequenceNumberColor: '#171a20',
    },
};

// mermaid-cli's puppeteer wants its own Chrome download; an installed Chrome or Edge works as
// well, so use PUPPETEER_EXECUTABLE_PATH or the first browser found at its usual place.
const BROWSERS = {
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};
const browser = process.env.PUPPETEER_EXECUTABLE_PATH || (BROWSERS[process.platform] ?? []).find((p) => existsSync(p));

// Renders every diagram in one palette with a single mermaid-cli run; returns the SVGs in order.
function renderDiagrams(sources, palette) {
    const dir = mkdtempSync(join(tmpdir(), 'doc-page-'));
    try {
        const input = join(dir, 'in.md');
        const config = join(dir, 'config.json');
        const puppeteer = join(dir, 'puppeteer.json');
        writeFileSync(input, sources.map((s) => '```mermaid\n' + s.trim() + '\n```\n').join('\n'));
        writeFileSync(config, JSON.stringify({ theme: 'base', themeVariables: PALETTES[palette], flowchart: { htmlLabels: true } }));
        writeFileSync(puppeteer, JSON.stringify(browser ? { executablePath: browser, headless: true } : { headless: true }));
        const args = ['-y', MERMAID_CLI, '-q', '-b', 'transparent', '-c', config, '-p', puppeteer, '-i', input, '-o', join(dir, 'out.md')];
        const win = process.platform === 'win32';
        const run = spawnSync(win ? 'npx.cmd' : 'npx', win ? args.map((a) => `"${a}"`) : args, { shell: win, encoding: 'utf8' });
        if (run.status !== 0) throw new Error(`mermaid-cli failed (${palette}, exit ${run.status}):\n${run.stderr}${run.stdout}`);
        return sources.map((_, i) => {
            const file = join(dir, `out-${i + 1}.svg`);
            if (!existsSync(file)) throw new Error(`mermaid-cli wrote no SVG for diagram ${i + 1} (${palette}) in ${dir}`);
            return readFileSync(file, 'utf8');
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Prefixes every id in one SVG, and every reference to it, so several SVGs can share a page.
function scopeSvg(svg, prefix) {
    svg = svg.replace(/^<\?xml[^>]*>\s*/, '');
    const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const ref = (id) => (ids.has(id) ? prefix + id : null);
    svg = svg.replace(/\sid="([^"]+)"/g, (_, id) => ` id="${prefix}${id}"`);
    svg = svg.replace(/url\(#([^)]+)\)/g, (m, id) => (ref(id) ? `url(#${ref(id)})` : m));
    svg = svg.replace(/href="#([^"]+)"/g, (m, id) => (ref(id) ? `href="#${ref(id)}"` : m));
    svg = svg.replace(/(aria-(?:labelledby|describedby))="([^"]+)"/g, (_, attr, list) =>
        `${attr}="${list.split(/\s+/).map((id) => ref(id) ?? id).join(' ')}"`);
    svg = svg.replace(/<style>([\s\S]*?)<\/style>/g, (_, css) =>
        '<style>' + css.replace(/#([A-Za-z_][\w-]*)/g, (m, id) => (ref(id) ? '#' + ref(id) : m)) + '</style>');
    return svg;
}

// --- Markdown --------------------------------------------------------------------------------

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (s) => s.replace(/[`*_]/g, '');

const diagrams = [];
const marked = new Marked({ gfm: true });
marked.use({
    renderer: {
        code({ text, lang }) {
            if (lang === 'mermaid') {
                diagrams.push(text);
                return `@@DIAGRAM_${diagrams.length - 1}@@\n`;
            }
            return `<pre><code>${escapeHtml(text)}</code></pre>\n`;
        },
        link({ href, title, tokens }) {
            if (!/^https?:\/\//i.test(href)) throw new Error(`Relative or non-web link in a shareable page: "${href}"`);
            const text = this.parser.parseInline(tokens);
            return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener">${text}</a>`;
        },
    },
});

const markdown = readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n');
const tokens = marked.lexer(markdown);
const groups = [[]];
for (const token of tokens) {
    if (token.type === 'hr') groups.push([]);
    else groups[groups.length - 1].push(token);
}
const slides = groups
    .filter((g) => g.some((t) => t.type !== 'space'))
    .map((group, i) => {
        group.links = tokens.links;
        const heading = group.find((t) => t.type === 'heading');
        if (!heading) throw new Error(`Slide ${i} has no heading to title it`);
        let html = marked.parser(group);
        html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
        return { title: plain(heading.text), html };
    });

const deckTitle = slides[0].title;
if (diagrams.length) {
    const light = renderDiagrams(diagrams, 'light');
    const dark = renderDiagrams(diagrams, 'dark');
    for (const slide of slides) {
        slide.html = slide.html.replace(/(?:<p>)?@@DIAGRAM_(\d+)@@(?:<\/p>)?/g, (_, i) =>
            `<figure class="diagram"><div class="d-light">${scopeSvg(light[i], `d${i}l-`)}</div>` +
            `<div class="d-dark">${scopeSvg(dark[i], `d${i}d-`)}</div></figure>`);
    }
}

// --- Page ------------------------------------------------------------------------------------

// The title slide is slide 0, so slide n is the section the Markdown numbers n.
const sections = slides.map((s, i) =>
    `<section class="slide${i === 0 ? ' title-slide' : ''}" id="slide-${i}" aria-label="${i === 0 ? 'Title' : `Slide ${i} of ${slides.length - 1}`}: ${escapeHtml(s.title)}">` +
    `<div class="slide-inner">\n${s.html}</div></section>`).join('\n');
const options = slides.map((s, i) => `<option value="${i}">${i === 0 ? 'Title' : escapeHtml(s.title)}</option>`).join('');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>${escapeHtml(deckTitle)}</title>
<script>try { var t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}</script>
<style>
:root {
  --bg: #f6f7f9; --surface: #ffffff; --text: #1b1f24; --muted: #5a6270; --border: #dde1e6;
  --accent: #2f5bd3; --accent-soft: #e8eefc; --code-bg: #eef0f3;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05), 0 1px 3px rgba(16, 24, 40, .07);
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1115; --surface: #171a20; --text: #e5e7eb; --muted: #9aa3af; --border: #2a2f38;
    --accent: #8aa8ff; --accent-soft: #1f2a44; --code-bg: #20242c; --shadow: none;
  }
  :root:not([data-theme="light"]) .d-light { display: none; }
  :root:not([data-theme="light"]) .d-dark { display: block; }
}
:root[data-theme="dark"] {
  --bg: #0f1115; --surface: #171a20; --text: #e5e7eb; --muted: #9aa3af; --border: #2a2f38;
  --accent: #8aa8ff; --accent-soft: #1f2a44; --code-bg: #20242c; --shadow: none;
}
:root[data-theme="dark"] .d-light { display: none; }
:root[data-theme="dark"] .d-dark { display: block; }
.d-dark { display: none; }

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 var(--sans); -webkit-text-size-adjust: 100%; }
@media (min-width: 1200px) { body { font-size: 18px; } }
a { color: var(--accent); text-underline-offset: 2px; }
code { font-family: var(--mono); font-size: .86em; background: var(--code-bg); padding: .1em .35em; border-radius: 4px; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: .9rem 1rem; border-radius: 8px; overflow-x: auto; font-size: .9em; }
pre code { padding: 0; background: none; overflow-wrap: normal; }
strong { font-weight: 650; }

.slide { padding: 2.5rem 16px; border-bottom: 1px solid var(--border); }
.slide-inner { max-width: 1080px; margin: 0 auto; }
.slide h1 { font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1.12; letter-spacing: -.02em; margin: 0 0 1.25rem; }
.slide h2 { font-size: clamp(1.5rem, 3.2vw, 2.1rem); line-height: 1.2; letter-spacing: -.01em; margin: 0 0 1.25rem; padding-bottom: .6rem; border-bottom: 3px solid var(--accent); display: inline-block; }
.slide p, .slide li { max-width: 62rem; }
.slide li { margin: .45rem 0; }
.title-slide p { font-size: 1.15em; color: var(--muted); max-width: 46rem; }
.title-slide p:first-of-type { color: var(--text); font-size: 1.3em; }

.table-wrap { overflow-x: auto; margin: 1rem 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow); }
table { border-collapse: collapse; width: 100%; font-size: .88em; }
th, td { text-align: left; vertical-align: top; padding: .6rem .85rem; border-bottom: 1px solid var(--border); }
th { background: var(--accent-soft); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td:first-child { min-width: 9rem; }

.diagram { margin: 1.25rem 0; padding: 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); overflow-x: auto; }
.diagram svg { display: block; margin: 0 auto; width: 100%; height: auto; }
.diagram foreignObject { overflow: visible; }
@media (max-width: 700px) { .diagram svg { min-width: 560px; } }
.diagram { position: relative; cursor: zoom-in; }
.diagram.zoomed { cursor: zoom-out; }
.diagram.zoomed svg { min-width: 0; margin: 0; }
.diagram figcaption { position: absolute; top: .5rem; right: .75rem; font-size: .75rem; color: var(--muted); }

/* Deck mode, switched on by the script; without it every slide shows in turn. */
.deck .slide { display: none; border-bottom: 0; min-height: 100vh; min-height: 100dvh; padding: 3.5rem 16px 6.5rem; }
.deck .slide.active { display: block; }
.deck .title-slide.active { display: flex; align-items: center; }
.deck .title-slide .slide-inner { width: 100%; }
@media (min-width: 900px) { .deck .slide { padding: 4rem 3rem 7rem; } }

.progress { position: fixed; top: 0; left: 0; height: 3px; background: var(--accent); width: 0; transition: width .2s ease; z-index: 20; }
.controls { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 20; display: none; align-items: center; gap: .35rem;
  padding: .35rem; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px);
  border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, .12); max-width: calc(100vw - 24px); }
.js .controls { display: flex; }
.controls button, .controls select { font: inherit; font-size: .85rem; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: 8px; padding: .4rem .65rem; cursor: pointer; }
.controls button:hover, .controls select:hover { border-color: var(--border); background: var(--bg); }
.controls button:disabled { opacity: .35; cursor: default; }
.controls select { max-width: 13rem; background: var(--bg); border-color: var(--border); }
.controls .count { font-variant-numeric: tabular-nums; color: var(--muted); font-size: .85rem; padding: 0 .25rem; white-space: nowrap; }
.controls .sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 .15rem; }
.hint { position: fixed; right: 16px; top: 12px; color: var(--muted); font-size: .75rem; display: none; }
@media (min-width: 1100px) { .js .deck .hint { display: block; } }
.controls button { white-space: nowrap; }
@media (max-width: 600px) {
  .controls { gap: .1rem; }
  .controls button, .controls select { padding: .4rem .45rem; font-size: .8rem; }
  .controls select { max-width: 6.5rem; }
  .controls .label { display: none; }
  td:first-child { min-width: 0; }
  th, td { padding: .5rem .6rem; }
}
:not(.deck) > .progress { display: none; }

@media print {
  .controls, .progress, .hint { display: none !important; }
  body { background: #fff; color: #000; font-size: 12pt; }
  .slide, .deck .slide { display: block !important; min-height: 0; padding: 0; border: 0; break-after: page; }
  .d-light { display: block !important; }
  .d-dark { display: none !important; }
  .diagram, .table-wrap { box-shadow: none; break-inside: avoid; overflow: visible; }
  .diagram svg { min-width: 0; }
  a { color: inherit; }
}
</style>
</head>
<body>
<div class="progress" id="progress"></div>
<main id="slides">
${sections}
</main>
<nav class="controls" aria-label="Slide controls">
  <button type="button" id="prev" aria-label="Previous slide">&larr;<span class="label"> Prev</span></button>
  <select id="jump" aria-label="Go to slide">${options}</select>
  <span class="count" id="count"></span>
  <button type="button" id="next" aria-label="Next slide"><span class="label">Next </span>&rarr;</button>
  <span class="sep"></span>
  <button type="button" id="mode" aria-pressed="false">Scroll view</button>
  <button type="button" id="theme" aria-label="Switch colour theme">Dark</button>
</nav>
<div class="hint">&larr; &rarr; or space to move &middot; S scroll view &middot; T theme</div>
<script>
(function () {
  var root = document.documentElement, body = document.body;
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var prev = document.getElementById('prev'), next = document.getElementById('next');
  var jump = document.getElementById('jump'), count = document.getElementById('count');
  var modeBtn = document.getElementById('mode'), themeBtn = document.getElementById('theme');
  var progress = document.getElementById('progress');
  var index = 0;

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  function fromHash() {
    var m = /^#slide-(\\d+)$/.exec(location.hash);
    return m ? Math.min(Math.max(parseInt(m[1], 10), 0), slides.length - 1) : 0;
  }
  function show(i, push) {
    index = Math.min(Math.max(i, 0), slides.length - 1);
    slides.forEach(function (s, n) { s.classList.toggle('active', n === index); });
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    jump.value = String(index);
    count.textContent = index === 0 ? 'Title' : index + ' / ' + (slides.length - 1);
    progress.style.width = (slides.length > 1 ? (index / (slides.length - 1)) * 100 : 100) + '%';
    if (push !== false && location.hash !== '#slide-' + index) history.replaceState(null, '', '#slide-' + index);
    if (isDeck()) window.scrollTo(0, 0);
  }
  function isDeck() { return body.classList.contains('deck'); }
  function setMode(deck) {
    body.classList.toggle('deck', deck);
    modeBtn.textContent = deck ? 'Scroll view' : 'Slide view';
    modeBtn.setAttribute('aria-pressed', deck ? 'false' : 'true');
    [prev, next, jump, count].forEach(function (el) { el.style.display = deck ? '' : 'none'; });
    store('deck-mode', deck ? 'slides' : 'scroll');
    if (deck) show(index);
    else slides[index].scrollIntoView();
  }
  function theme() { return root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  function themeLabel() { themeBtn.textContent = theme() === 'dark' ? 'Light' : 'Dark'; }
  function toggleTheme() {
    var t = theme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = t; store('theme', t); themeLabel();
  }

  prev.addEventListener('click', function () { show(index - 1); });
  next.addEventListener('click', function () { show(index + 1); });
  jump.addEventListener('change', function () { show(parseInt(jump.value, 10)); jump.blur(); });
  modeBtn.addEventListener('click', function () { setMode(!isDeck()); });
  themeBtn.addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeLabel);
  window.addEventListener('hashchange', function () { if (isDeck()) show(fromHash(), false); });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'input' || tag === 'textarea') return;
    var k = e.key;
    if (k === 's' || k === 'S') { setMode(!isDeck()); e.preventDefault(); return; }
    if (k === 't' || k === 'T') { toggleTheme(); e.preventDefault(); return; }
    if (!isDeck()) return;
    if (k === 'ArrowRight' || k === 'PageDown' || k === 'n' || (k === ' ' && !e.shiftKey)) { show(index + 1); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'p' || (k === ' ' && e.shiftKey)) { show(index - 1); e.preventDefault(); }
    else if (k === 'Home') { show(0); e.preventDefault(); }
    else if (k === 'End') { show(slides.length - 1); e.preventDefault(); }
  });

  var touch = null;
  document.addEventListener('touchstart', function (e) {
    if (!isDeck() || e.touches.length !== 1 || e.target.closest('.diagram, .table-wrap, pre, .controls')) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!touch) return;
    var dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) show(index + (dx < 0 ? 1 : -1));
  });

  // A click on a diagram shows it at its natural size, scrolling inside its frame.
  document.querySelectorAll('.diagram').forEach(function (fig) {
    var cap = document.createElement('figcaption');
    cap.textContent = 'Click to enlarge';
    fig.appendChild(cap);
    fig.addEventListener('click', function () {
      var zoomed = fig.classList.toggle('zoomed');
      cap.textContent = zoomed ? 'Click to fit' : 'Click to enlarge';
      fig.querySelectorAll('svg').forEach(function (svg) {
        var vb = svg.viewBox && svg.viewBox.baseVal;
        svg.style.width = zoomed && vb ? Math.max(vb.width, fig.clientWidth) + 'px' : '';
        svg.style.maxWidth = zoomed ? 'none' : '';
      });
    });
  });

  window.addEventListener('beforeprint', function () { slides.forEach(function (s) { s.classList.add('active'); }); });
  window.addEventListener('afterprint', function () { if (isDeck()) show(index, false); });

  root.classList.add('js');
  index = fromHash();
  themeLabel();
  setMode(read('deck-mode') !== 'scroll');
})();
</script>
</body>
</html>
`;

writeFileSync(outPath, page);
console.log(`Wrote ${outPath}: ${slides.length} slides, ${diagrams.length} diagrams, from ${srcPath}`);
