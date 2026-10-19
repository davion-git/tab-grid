// Renders the toolbar icons (a 2x2 grid with a big cell) to PNG.
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "icons");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const s of [16, 32, 48, 128]) {
  const g = Math.max(1, Math.round(s / 16)), r = Math.round(s / 8);
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<body style="margin:0;background:transparent">
  <div style="width:${s}px;height:${s}px;display:grid;grid-template:1fr 1fr/2fr 1fr;gap:${g}px;padding:${g}px;box-sizing:border-box">
  <div style="grid-row:span 2;background:#2563eb;border-radius:${r}px"></div>
  <div style="background:#2563eb;opacity:.6;border-radius:${r}px"></div>
  <div style="background:#2563eb;opacity:.6;border-radius:${r}px"></div></div></body>`);
  await page.screenshot({ path: path.join(out, `${s}.png`), omitBackground: true });
}
await browser.close();
