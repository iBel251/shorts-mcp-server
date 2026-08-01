/**
 * Bundles each widget into one self-contained HTML document and emits them as a
 * generated TypeScript module.
 *
 * Emitting a .ts module rather than .html files means the server has no runtime
 * file reads and the Dockerfile needs no extra COPY — the widgets are compiled
 * into dist along with everything else. A UI resource has to be a single
 * payload anyway, since the sandboxed iframe cannot fetch sibling assets.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'src', 'widgets.generated.ts');

/** Shared chrome. Deliberately theme-aware — the host renders light and dark. */
const CSS = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --bg: transparent;
  --fg: #1a1a1a;
  --muted: #6b6b6b;
  --line: rgba(0,0,0,0.12);
  --card: rgba(0,0,0,0.03);
  --accent: #2f6f4f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #ededed; --muted: #9a9a9a;
    --line: rgba(255,255,255,0.14); --card: rgba(255,255,255,0.05);
    --accent: #7bc39a;
  }
}
:root[data-theme="dark"] {
  --fg: #ededed; --muted: #9a9a9a;
  --line: rgba(255,255,255,0.14); --card: rgba(255,255,255,0.05);
  --accent: #7bc39a;
}
:root[data-theme="light"] {
  --fg: #1a1a1a; --muted: #6b6b6b;
  --line: rgba(0,0,0,0.12); --card: rgba(0,0,0,0.03);
  --accent: #2f6f4f;
}
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.45 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
img, video { max-width: 100%; display: block; }
.bar {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; margin-bottom: 10px; color: var(--muted); font-size: 12px;
}
.grid {
  display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}
.card {
  margin: 0; border: 1px solid var(--line); border-radius: 10px;
  overflow: hidden; background: var(--card); cursor: pointer;
  transition: border-color .12s ease, transform .12s ease;
}
.card:hover, .card:focus-visible { border-color: var(--accent); transform: translateY(-1px); }
.card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.card.approved { border-color: var(--accent); border-width: 2px; }
.card img { aspect-ratio: 9 / 16; object-fit: cover; width: 100%; }
figcaption {
  display: flex; justify-content: space-between; gap: 8px;
  padding: 6px 8px; font-size: 12px; color: var(--muted);
}
.tick { color: var(--accent); font-weight: 600; }
.note, .empty { color: var(--muted); font-size: 12px; margin: 10px 0 0; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.badge {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--card); color: var(--muted);
}
video { width: 100%; border-radius: 10px; border: 1px solid var(--line); background: #000; }
.frames { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.frames figure { margin: 0; }
.frames img { border-radius: 8px; border: 1px solid var(--line); aspect-ratio: 9/16; object-fit: cover; }
.status { display: flex; gap: 10px; align-items: flex-start; padding: 4px 0; }
.status p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.status.bad strong { color: #c0554d; }
.dot {
  width: 9px; height: 9px; border-radius: 50%; margin-top: 5px;
  background: var(--accent); flex: none;
}
.status.bad .dot { background: #c0554d; }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
@media (max-width: 360px) { .frames { grid-template-columns: 1fr; } }
`;

async function bundle(name) {
    const result = await build({
        entryPoints: [join(here, `${name}.client.ts`)],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'none',
    });
    const js = result.outputFiles[0].text;

    // One document, no external references: the iframe cannot fetch siblings.
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;
}

const gallery = await bundle('gallery');
const player = await bundle('player');

const asLiteral = (html) => JSON.stringify(html);

await mkdir(dirname(outFile), { recursive: true });
await writeFile(
    outFile,
    `// GENERATED FILE — do not edit.
// Produced by widgets/build.mjs from widgets/*.client.ts. Run \`npm run build:widgets\`.

export const GALLERY_HTML: string = ${asLiteral(gallery)};

export const PLAYER_HTML: string = ${asLiteral(player)};
`,
    'utf8',
);

console.log(
    `widgets built: gallery ${(gallery.length / 1024).toFixed(1)}kB, ` +
        `player ${(player.length / 1024).toFixed(1)}kB -> src/widgets.generated.ts`,
);
