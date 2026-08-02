/**
 * Bundles the Shorts Studio front end into one self-contained HTML document
 * and emits it as a generated TypeScript module.
 *
 * Same approach as widgets/build.mjs, for the same reason: the Dockerfile runs
 * `tsc` only, never esbuild — esbuild's platform binary is not reliably present
 * under `npm ci --ignore-scripts`. So the bundle is generated locally, checked
 * in as src/ui.generated.ts, and compiled into dist with everything else. The
 * server then has no static directory to serve and no runtime file reads.
 *
 * Regenerate with `npm run build:ui` after changing anything under ui/.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'src', 'ui.generated.ts');

const result = await build({
    entryPoints: [join(here, 'app.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    // es2022 for Array.prototype.at and friends — this is an internal studio,
    // not a public page, so the evergreen-browser floor is the right trade.
    target: 'es2022',
    minify: true,
    legalComments: 'none',
});
const js = result.outputFiles[0].text;

/**
 * Enough style to paint the first frame correctly.
 *
 * The full stylesheet ships inside the bundle (theme.ts) and is injected on
 * boot, which would otherwise mean one frame of white page. These few rules in
 * the head cost nothing and remove the flash.
 */
const CRITICAL = `html,body{margin:0;padding:0;background:#101211;color:#e8eae7;` +
    `font:14px/1.45 'Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}`;

// Google Fonts are the design's own choice (Public Sans + JetBrains Mono).
// They are a progressive enhancement: theme.ts lists system fallbacks in every
// font stack, so the studio is fully usable if the request is blocked.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>Shorts Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CRITICAL}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(
    outFile,
    `// GENERATED FILE — do not edit.
// Produced by ui/build.mjs from ui/*.ts. Run \`npm run build:ui\`.

export const STUDIO_HTML: string = ${JSON.stringify(html)};
`,
    'utf8',
);

console.log(`studio built: ${(html.length / 1024).toFixed(1)}kB -> src/ui.generated.ts`);
