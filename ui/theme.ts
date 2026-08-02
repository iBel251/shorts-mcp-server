/**
 * The Shorts Studio stylesheet.
 *
 * Lifted from the design one token at a time — every hex, size and weight here
 * is the design's, not an approximation. The design expressed it as inline
 * styles on every element; that is fine for a static mockup but unworkable for
 * a live app, so the same values live here as classes and custom properties.
 *
 * Two deliberate departures:
 *   - No border radius anywhere. The design has none, and it is load-bearing
 *     for the look; a stray rounded corner reads as a different product.
 *   - Dark only. The design commits to one palette and the widgets already
 *     handle the theme-aware case; a light variant here would be invention.
 */

export const CSS = `
:root {
  --bg: #101211;
  --bg-deep: #0c0e0d;
  --panel: #171a19;
  --panel-2: #131615;
  --panel-3: #1d2120;
  --sunken: #0f1211;
  --line: #232827;
  --line-2: #2c3230;
  --line-3: #3a413e;
  --line-4: #4a524e;
  --fg: #e8eae7;
  --fg-2: #dfe3e0;
  --fg-3: #d5dad6;
  --fg-4: #c7ccc8;
  --muted: #8b938e;
  --muted-2: #7d857f;
  --muted-3: #6d746f;
  --muted-4: #4f5652;
  --accent: #e0a44a;
  --accent-hi: #f0bd72;
  --good: #7fb5a5;
  --bad: #c8674f;
  --info: #6fa9c8;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: 'Public Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); }
body {
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hi); }
::selection { background: var(--accent); color: var(--bg); }
img, video { display: block; max-width: 100%; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@keyframes spin { to { transform: rotate(360deg); } }

.mono { font-family: var(--mono); }
.muted { color: var(--muted); }
.dim { color: var(--muted-3); }
.hide { display: none !important; }
.spacer { flex: 1; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pretty { text-wrap: pretty; }

/* ------------------------------------------------------------------ shell */

.app {
  display: flex; flex-wrap: wrap; align-items: stretch;
  min-height: 100vh; background: var(--bg);
}

.side {
  flex: 1 1 232px; min-width: 0; max-width: 100%; overflow-wrap: anywhere;
  background: var(--bg-deep); border-right: 1px solid var(--line);
  padding: 20px 18px; display: flex; flex-direction: column; gap: 26px;
}
.brand { display: flex; align-items: center; gap: 10px; }
.brand-mark { width: 26px; height: 26px; border: 2px solid var(--fg); background: var(--accent); flex: none; }
.brand-name { font-weight: 700; letter-spacing: 0.14em; font-size: 12px; }
.brand-sub { font-family: var(--mono); font-size: 10px; color: var(--muted-2); }

.nav { display: flex; flex-wrap: wrap; gap: 2px; min-width: 0; }
.nav-item {
  flex: 1 1 100%; min-width: 0; display: flex; align-items: center; gap: 10px;
  text-align: left; padding: 9px 10px; border: 1px solid transparent;
  background: transparent; color: #9aa19c;
  font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
}
.nav-item:hover { background: #1a1e1c; color: var(--fg); }
.nav-item.on { background: var(--panel-3); border-color: var(--line-3); color: var(--fg); }
.nav-item .key, .nav-item .count { font-family: var(--mono); font-size: 11px; color: var(--muted-2); }
.nav-item .label { flex: 1; }

.side-head {
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.12em; color: var(--muted-3);
}
.side-group { display: flex; flex-direction: column; gap: 8px; }
.side-project {
  display: flex; align-items: center; gap: 8px; text-align: left;
  padding: 7px 9px; border: 1px solid transparent; background: transparent;
  color: var(--fg-4); font-family: inherit; font-size: 13px; cursor: pointer;
}
.side-project:hover { background: #1a1e1c; }
.side-project.on { background: var(--panel-3); border-color: var(--line-3); }
.side-project .dot { width: 6px; height: 6px; flex: none; }
.side-project .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-project .ratio { font-family: var(--mono); font-size: 10px; color: var(--muted-3); }

.side-foot {
  margin-top: auto; border-top: 1px solid var(--line); padding-top: 14px;
  display: flex; flex-direction: column; gap: 6px;
  font-family: var(--mono); font-size: 10px; color: var(--muted-3);
}
.side-foot .live { display: flex; align-items: center; gap: 7px; color: var(--good); }
.side-foot .live b { width: 6px; height: 6px; background: var(--good); animation: pulse 2.4s ease-in-out infinite; }
.side-foot .live.bad { color: var(--bad); }
.side-foot .live.bad b { background: var(--bad); }

/* ----------------------------------------------------------------- buttons */

.btn {
  padding: 8px 12px; border: 1px solid var(--line-2); background: var(--panel);
  color: var(--fg); font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--line-4); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.small { padding: 6px 10px; font-size: 12px; background: var(--panel-3); }
.btn.tiny { padding: 5px 9px; font-size: 12px; font-family: var(--mono); background: transparent; color: var(--muted); }
.btn.tiny:hover:not(:disabled) { color: var(--fg); border-color: var(--line-4); }
.btn.primary {
  border-color: var(--accent); background: var(--accent);
  color: var(--bg); font-weight: 700;
}
.btn.primary:hover:not(:disabled) { background: var(--accent-hi); border-color: var(--accent-hi); }
.btn.ghost { background: transparent; color: var(--muted); }
.btn.ghost:hover:not(:disabled) { color: var(--fg); }
.btn.outline { background: transparent; border-color: var(--accent); color: var(--accent); font-weight: 600; }
.btn.outline:hover:not(:disabled) { background: var(--accent); color: var(--bg); }
.btn.danger:hover:not(:disabled) { border-color: var(--bad); color: var(--bad); }
.btn.accent-hover:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn.busy { position: relative; color: transparent !important; }
.btn.busy::after {
  content: ''; position: absolute; inset: 0; margin: auto;
  width: 12px; height: 12px; border: 2px solid currentColor; border-top-color: transparent;
  color: var(--accent); animation: spin 0.7s linear infinite;
}
.btn.primary.busy::after { color: var(--bg); }

.field {
  width: 100%; background: var(--sunken); border: 1px solid var(--line-2);
  color: var(--fg); padding: 9px 11px; font-family: inherit; font-size: 13.5px; line-height: 1.6;
}
.field:focus { outline: none; border-color: var(--accent); }
textarea.field { min-height: 110px; resize: vertical; }
select.field { cursor: pointer; }
label.lbl {
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.1em; color: var(--muted-3); display: block; margin-bottom: 6px;
}

/* ------------------------------------------------------------------- main */

.main { flex: 9999 1 640px; min-width: 0; display: flex; flex-direction: column; }

.head {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
  justify-content: space-between; padding: 16px 22px;
  border-bottom: 1px solid var(--line); background: var(--bg);
}
.head h1 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.01em; }
.head p { margin: 2px 0 0; font-family: var(--mono); font-size: 11px; color: var(--muted-2); }
.head .left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.head .right { display: flex; flex-wrap: wrap; gap: 8px; }

.tabs { display: flex; padding: 0 22px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab {
  padding: 11px 14px; border: none; border-bottom: 2px solid transparent;
  background: transparent; color: var(--muted); font-family: inherit;
  font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer;
}
.tab:hover { color: var(--fg); }
.tab.on { border-bottom-color: var(--accent); color: var(--fg); }
.tab .count { font-family: var(--mono); font-size: 11px; color: var(--muted-3); }

.content { flex: 1; padding: 22px; display: flex; flex-direction: column; gap: 18px; }
.empty {
  border: 1px dashed var(--line-3); padding: 34px; text-align: center;
  color: var(--muted); font-size: 13px;
}

/* --------------------------------------------------------- project cards */

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.card {
  border: 1px solid var(--line); background: var(--panel);
  cursor: pointer; display: flex; flex-direction: column; text-align: left;
  font: inherit; color: inherit; padding: 0;
}
.card:hover { border-color: var(--line-4); }
.card .strip { display: flex; gap: 2px; padding: 2px; background: var(--bg-deep); }
.card .strip > * { flex: 1; aspect-ratio: 9 / 16; border: 1px solid var(--bg-deep); object-fit: cover; min-width: 0; }
.card .body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.card h2 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.card .logline {
  margin: 0; font-size: 13px; color: var(--muted); text-wrap: pretty;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.card .meter { height: 3px; background: var(--line); }
.card .meter > i { display: block; height: 3px; background: var(--accent); }
.card .foot {
  display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 10px; color: var(--muted-3);
}

.pill {
  font-family: var(--mono); font-size: 10px; padding: 3px 6px;
  border: 1px solid currentColor; white-space: nowrap;
}
.blank { background: #191d1b; }

/* ---------------------------------------------------------------- shots */

.shot-list { display: flex; flex-direction: column; gap: 10px; }
.shot {
  display: flex; flex-wrap: wrap; gap: 14px; padding: 12px;
  border: 1px solid var(--line); background: var(--panel);
}
.shot .thumb {
  flex: 0 0 66px; width: 66px; aspect-ratio: 9 / 16; border: 1px solid var(--line-2);
  position: relative; display: flex; align-items: flex-end; padding: 5px;
  object-fit: cover; cursor: pointer;
}
.shot .thumb-wrap { flex: 0 0 66px; position: relative; cursor: pointer; }
.shot .thumb-tag {
  position: absolute; left: 5px; bottom: 5px; font-family: var(--mono);
  font-size: 9px; color: var(--bg-deep); background: var(--fg-4); padding: 1px 3px;
}
.shot .mid { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.shot .row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.shot .num { font-family: var(--mono); font-size: 12px; font-weight: 700; color: var(--accent); }
.shot .meta { font-family: var(--mono); font-size: 10px; color: var(--muted-3); }
.shot .desc { margin: 0; font-size: 13.5px; color: var(--fg-3); text-wrap: pretty; }
.shot .motion { margin: 0; font-family: var(--mono); font-size: 11px; color: var(--muted-2); }
.shot .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.shot .vars { flex: 0 0 auto; display: flex; gap: 6px; align-items: flex-start; }

.var {
  width: 44px; aspect-ratio: 9 / 16; border: 2px solid var(--line-2);
  padding: 0; cursor: pointer; position: relative; background: #191d1b;
  display: flex; align-items: flex-start; justify-content: flex-end;
}
.var:hover { border-color: var(--accent); }
.var.on { border-color: var(--accent); }
.var img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.var .badge {
  position: relative; font-family: var(--mono); font-size: 9px; padding: 1px 3px;
  background: var(--bg-deep); color: var(--fg-4);
}
.var.on .badge { background: var(--accent); color: var(--bg); }
.var.rejected { border-color: var(--bad); }

/* ---------------------------------------------------------------- story */

.split { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
.panel {
  border: 1px solid var(--line); background: var(--panel); padding: 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.panel h3 {
  margin: 0; font-size: 13px; letter-spacing: 0.1em;
  font-family: var(--mono); color: var(--muted); font-weight: 400;
}
.panel .head-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.story-text { margin: 0; font-size: 15px; line-height: 1.65; color: var(--fg-2); text-wrap: pretty; white-space: pre-wrap; }
.beat { display: flex; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.beat:last-child { border-bottom: none; padding-bottom: 0; }
.beat .n { font-family: var(--mono); font-size: 11px; color: var(--accent); padding-top: 2px; }
.beat p { margin: 0; font-size: 13.5px; color: var(--fg-2); }
.beat .sub { margin: 3px 0 0; font-family: var(--mono); font-size: 10.5px; color: var(--muted-2); }

/* ----------------------------------------------------------- references */

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  font-family: var(--mono); font-size: 10px; padding: 4px 8px;
  border: 1px solid var(--line-2); background: transparent;
  color: var(--muted); cursor: pointer;
}
.chip:hover { color: var(--fg); }
.chip.on { border-color: var(--accent); color: var(--accent); }

.ref-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
.ref { margin: 0; border: 1px solid var(--line); background: var(--panel); }
.ref .plate {
  aspect-ratio: 9 / 16; display: flex; align-items: flex-end; padding: 8px;
  background: #191d1b; position: relative;
}
.ref .plate img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.ref .plate .role {
  position: relative; font-family: var(--mono); font-size: 9px;
  background: var(--bg-deep); color: var(--fg-4); padding: 2px 4px;
}
.ref figcaption { padding: 9px 10px; display: flex; flex-direction: column; gap: 3px; }
.ref .label { font-size: 13px; font-weight: 600; }
.ref .used { font-family: var(--mono); font-size: 10px; color: var(--muted-3); }
.ref .id { font-family: var(--mono); font-size: 10px; color: var(--muted-4); }
.ref .rm { align-self: flex-start; margin: 0 10px 9px; }
.add-ref {
  border: 1px dashed var(--line-3); background: transparent; color: var(--muted);
  font-family: var(--mono); font-size: 11px; min-height: 160px; cursor: pointer;
}
.add-ref:hover { border-color: var(--accent); color: var(--accent); }

/* ----------------------------------------------------------------- jobs */

.jobs { display: flex; flex-direction: column; gap: 8px; }
.job-head {
  display: flex; gap: 12px; padding: 0 12px; font-family: var(--mono);
  font-size: 10px; letter-spacing: 0.1em; color: var(--muted-3);
}
.job {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
  padding: 11px 12px; border: 1px solid var(--line); background: var(--panel); font-size: 13px;
}
.job .c-id { flex: 0 0 74px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.job .c-shot { flex: 0 0 46px; font-family: var(--mono); font-size: 11px; color: var(--accent); }
.job .c-motion { flex: 1 1 110px; min-width: 0; color: var(--fg-4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job .c-status { flex: 0 0 92px; display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; }
.job .c-status i { width: 6px; height: 6px; background: currentColor; flex: none; }
.job .c-status.live i { animation: pulse 1.6s ease-in-out infinite; }
.job .c-elapsed { flex: 0 0 64px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.job .c-act { flex: 0 0 92px; }
.job .c-error { flex: 1 1 100%; margin: 0; font-family: var(--mono); font-size: 11px; color: var(--bad); }

/* -------------------------------------------------------------- overlays */

.scrim { position: fixed; inset: 0; background: rgba(8, 9, 8, 0.66); z-index: 30; border: none; padding: 0; }
.drawer {
  position: fixed; top: 0; right: 0; height: 100vh; width: min(470px, 94vw);
  background: var(--panel-2); border-left: 1px solid var(--line-2); z-index: 31;
  overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 16px;
}
.drawer h2 { margin: 0; font-size: 16px; font-weight: 700; }
.drawer .ids { margin: 3px 0 0; font-family: var(--mono); font-size: 11px; color: var(--muted-2); }
.drawer .sec { display: flex; flex-direction: column; gap: 8px; }
.drawer .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.drawer .grid4 .var { width: auto; }
.drawer .clip { aspect-ratio: 9 / 16; max-height: 340px; border: 1px solid var(--line-2); background: #191d1b; }
.drawer .clip.placeholder { display: flex; align-items: center; justify-content: center; }
.drawer .clip video { width: 100%; height: 100%; object-fit: contain; background: #000; }
.drawer .frames { display: flex; gap: 6px; }
.drawer .frames > * {
  flex: 1; border: 1px solid var(--line); padding: 7px; text-align: center;
  font-family: var(--mono); font-size: 10px; color: var(--muted-2);
  background: transparent; cursor: pointer;
}
.drawer .frames > *:hover { border-color: var(--line-4); color: var(--fg); }
.drawer .foot { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 6px; }
.drawer .foot .btn { flex: 1 1 130px; padding: 9px; }

.critique { border: 1px solid var(--line-2); background: var(--sunken); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.critique .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.critique .flags { display: flex; flex-wrap: wrap; gap: 6px; }
.critique .flag { font-family: var(--mono); font-size: 10px; padding: 2px 6px; background: var(--panel); }
.critique p { margin: 0; font-size: 13px; color: var(--fg-4); }
.critique .fix { font-size: 12.5px; color: var(--muted-2); text-wrap: pretty; }

.cut {
  position: fixed; inset: 0; background: rgba(8, 9, 8, 0.86); z-index: 40;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 22px; overflow-y: auto;
}
.cut .bar { width: 100%; max-width: 960px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.cut h2 { margin: 0; font-size: 16px; font-weight: 700; }
.cut .stage { width: min(300px, 70vw); aspect-ratio: 9 / 16; border: 1px solid var(--line-3); background: #191d1b; }
.cut .stage video { width: 100%; height: 100%; object-fit: contain; background: #000; }
.cut .strip { width: 100%; max-width: 960px; display: flex; gap: 4px; overflow-x: auto; padding-bottom: 6px; }
.cut .strip button {
  flex: 0 0 52px; aspect-ratio: 9 / 16; border: 2px solid var(--line-2);
  padding: 0; cursor: pointer; background: #191d1b; position: relative;
}
.cut .strip button.on { border-color: var(--accent); }
.cut .strip img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }

.modal-scrim {
  position: fixed; inset: 0; background: rgba(8, 9, 8, 0.82); z-index: 50;
  display: flex; align-items: flex-start; justify-content: center;
  padding: 24px; overflow-y: auto;
}
.modal {
  width: min(620px, 100%); background: var(--panel-2); border: 1px solid var(--line-2);
  padding: 20px; display: flex; flex-direction: column; gap: 16px;
}
.modal.wide { width: min(760px, 100%); }
.modal h2 { margin: 0; font-size: 17px; font-weight: 700; }
.modal .head-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.steps { display: flex; gap: 4px; }
.step {
  flex: 1; padding: 8px 4px; border: 1px solid var(--line-2); background: transparent;
  color: var(--muted); font-family: var(--mono); font-size: 10px; cursor: pointer;
}
.step:hover { border-color: var(--line-4); }
.step.on { background: var(--panel-3); border-color: var(--accent); color: var(--accent); }
.step.done { color: var(--good); }
.wiz-body { display: flex; flex-direction: column; gap: 10px; min-height: 200px; }
.wiz-body > p { margin: 0; font-size: 14px; color: var(--fg-4); text-wrap: pretty; }
.modal .foot { display: flex; justify-content: space-between; gap: 8px; }

.pitch {
  border: 1px solid var(--line-2); background: var(--sunken); padding: 12px;
  display: flex; flex-direction: column; gap: 5px; cursor: pointer; text-align: left;
  font: inherit; color: inherit;
}
.pitch:hover { border-color: var(--line-4); }
.pitch.on { border-color: var(--accent); }
.pitch b { font-size: 14px; }
.pitch .hook { font-size: 13px; color: var(--fg-4); }
.pitch .why { font-family: var(--mono); font-size: 10.5px; color: var(--muted-2); }

.plan-row {
  border: 1px solid var(--line); background: var(--sunken); padding: 10px;
  display: flex; flex-direction: column; gap: 6px;
}
.plan-row .n { font-family: var(--mono); font-size: 11px; color: var(--accent); }
.run-log { display: flex; flex-direction: column; gap: 4px; font-family: var(--mono); font-size: 11.5px; max-height: 260px; overflow-y: auto; }
.run-log .ok { color: var(--good); }
.run-log .err { color: var(--bad); }
.run-log .pend { color: var(--muted-2); }

/* ---------------------------------------------------------------- gate */

.gate {
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
}
.gate form {
  width: min(400px, 100%); border: 1px solid var(--line-2); background: var(--panel-2);
  padding: 24px; display: flex; flex-direction: column; gap: 14px;
}
.gate .err { font-family: var(--mono); font-size: 11px; color: var(--bad); margin: 0; }

/* --------------------------------------------------------------- toasts */

.toasts {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  z-index: 90; display: flex; flex-direction: column; gap: 6px; align-items: center;
  pointer-events: none; width: min(560px, calc(100vw - 32px));
}
.toast {
  border: 1px solid var(--line-2); background: var(--panel-2); color: var(--fg-4);
  padding: 9px 12px; font-size: 12.5px; width: 100%; text-wrap: pretty;
}
.toast.err { border-color: var(--bad); color: var(--bad); }
.toast.ok { border-color: var(--good); color: var(--good); }

@media (max-width: 720px) {
  .side { flex-basis: 100%; border-right: none; border-bottom: 1px solid var(--line); }
  .content, .head, .tabs { padding-left: 14px; padding-right: 14px; }
  .shot .vars { flex-basis: 100%; }
}
`;
