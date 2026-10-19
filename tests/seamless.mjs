// Seamless mode check: 4 public videos in a 2x2 with "Hide title bars" and
// "Use the whole screen" on. Each page must fill its cell exactly (no gaps,
// no bar inside the cell), and nothing may reload.
//   node tests/seamless.mjs [capture.png]   (always headed; Windows screen capture if a path is given)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import path from "path";

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capture = process.argv[2];
const VIDEOS = ["dQw4w9WgXcQ", "LXb3EKWsInQ", "9bZkp7q19f0", "kJQP7kiw5Fk"];
let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const ctl = await ctx.newPage();
await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);

const pages = [];
for (const v of VIDEOS) {
  const p = await ctx.newPage();
  await p.goto(`https://www.youtube.com/watch?v=${v}`, { waitUntil: "domcontentloaded" });
  pages.push(p);
}
for (const p of pages) {
  await p.waitForSelector("video", { timeout: 30000 }).catch(() => {});
  await p.evaluate(() => { window.__mark = Math.random(); document.querySelector("video")?.play().catch(() => {}); });
}
await pages[0].waitForTimeout(3000);
const marks = await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)));
const tabIds = await ctl.evaluate(async (vids) => {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
  return vids.map((v) => tabs.find((t) => t.url.includes(v)).id);
}, VIDEOS);
const d = await ctl.evaluate(async () => (await chrome.system.display.getInfo()).find((x) => x.isPrimary));

async function measure() {
  const wins = await ctl.evaluate(async (ids) => Promise.all(ids.map(async (id) => {
    const t = await chrome.tabs.get(id); const w = await chrome.windows.get(t.windowId);
    return { left: w.left, top: w.top, width: w.width, height: w.height, tw: t.width, th: t.height };
  })), tabIds);
  const pg = await Promise.all(pages.map((p) => p.evaluate(() => ({ w: innerWidth, h: innerHeight, mark: window.__mark, t: document.querySelector("video")?.currentTime ?? -1 }))));
  return wins.map((w, i) => {
    const b = (w.width - w.tw) / 2, title = w.height - w.th - b;
    return { ...w, b, title, contentLeft: w.left + b, contentTop: w.top + title, ...pg[i] };
  });
}

await call("setSettings", { patch: { wholeScreen: true, tuckTitleBars: true } });
const r = await call("tile", { tabIds, layout: { rows: 2, cols: 2 } });
check(r.ok, "tile 2x2 seamless", r.error);
await pages[0].waitForTimeout(2500);
let m = await measure();
const area = d.bounds, cw = area.width / 2, ch = area.height / 2;
console.log("frame: border", m[0].b, "title", m[0].title);
console.log(m.map((x) => `win ${x.left},${x.top} ${x.width}x${x.height} -> page at ${x.contentLeft},${x.contentTop} ${x.w}x${x.h}`).join("\n"));
check(m.every((x, i) => x.contentLeft === area.left + (i % 2) * cw && x.contentTop === area.top + Math.floor(i / 2) * ch), "each page starts exactly at its cell corner (bar tucked out, no gap)");
check(m.every((x) => x.w === cw && x.h === ch), `each page is exactly ${cw}x${ch}`);
check(m.every((x, i) => x.mark === marks[i]), "no tab reloaded");
// Click (focus) the bottom-left tile: its bar shows over the tile above
// for a moment, then the tiles are restacked and the sound stays with it.
const shoot = (file) => execFileSync("powershell", ["-NoProfile", "-Command",
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file}')`]);
const winOf = (i) => ctl.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, tabIds[i]);
const focusedTile = async () => {
  const w = await ctl.evaluate(async () => (await chrome.windows.getLastFocused()).id);
  for (let i = 0; i < tabIds.length; i++) if ((await winOf(i)) === w) return i;
  return -1;
};
const bottomLeft = await winOf(2);
await pages[0].waitForTimeout(1500);
await ctl.evaluate((w) => chrome.windows.update(w, { focused: true }), bottomLeft);
await pages[0].waitForTimeout(300);
check((await focusedTile()) === 2, "click on bottom-left tile brings it to the front");
if (capture) shoot(capture.replace(/\.png$/, "-clicked.png"));
await pages[0].waitForTimeout(1700);
const f = await focusedTile();
check(f === 0 || f === 1, "a second later the top row is back in front", `focused tile ${f + 1}`);
const sound = await ctl.evaluate(async (ids) => Promise.all(ids.map(async (id) => !(await chrome.tabs.get(id)).mutedInfo.muted)), tabIds);
check(sound.join(",") === "false,false,true,false", "the sound stayed on the clicked tile", sound.join(","));
if (capture) {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${capture}')`]);
  console.log("screen captured:", capture);
}

// Turning the options off re-tiles to the plain layout (bars visible, work area).
await call("setSettings", { patch: { wholeScreen: false, tuckTitleBars: false } });
await pages[0].waitForTimeout(2000);
m = await measure();
check(m.every((x, i) => x.top === d.workArea.top + Math.floor(i / 2) * Math.round(d.workArea.height / 2)), "options off: re-tiled with bars visible inside the work area");
check(m.every((x, i) => x.contentLeft === (i % 2) * cw), "options off: still no gaps between columns");
check(m.every((x, i) => x.mark === marks[i]), "no tab reloaded after re-tile");

await call("untile");
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
