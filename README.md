# How I work with AI agents

A short slide deck on how I run coding agents across several organisations and machines: who does what, where the knowledge lives, and the rules that keep it safe.

**Open the deck:** https://hugoforte.github.io/ai-workflow/

Use the arrow keys or space to move between slides, `S` for a scroll view and `T` to switch between the light and dark theme.

## Building it

`index.html` is a single self-contained page built from `ai-workflow.md`. Each part of the Markdown between horizontal rules becomes one slide, and the Mermaid diagrams are rendered to inline SVG at build time, once per theme.

```sh
npm ci
node build.mjs
```

The build needs Node 18 or later and a Chrome or Edge install (or `PUPPETEER_EXECUTABLE_PATH`) for mermaid-cli, which it runs through `npx`.
