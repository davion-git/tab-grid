// Main + 3 layout with 4 public videos: clicking a strip game makes it the
// main one and gives it the sound. Nothing may reload. (Corner: corner.mjs.)
//   node main-swap.mjs [capture.png]   (always headed; Windows screen capture if a path is given)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capture = process.argv[2];
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"] });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const ctl = await ctx.newPage();
await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
const VIDEOS = ["dQw4w9WgXcQ", "LXb3EKWsInQ", "9bZkp7q19f0", "kJQP7kiw5Fk"];
const pages = [];
for (const v of VIDEOS) { const p = await ctx.newPage(); await p.goto(`https://www.youtube.com/watch?v=${v}`, { waitUntil: "domcontentloaded" }); pages.push(p); }
for (const p of pages) { await p.waitForSelector("video", { timeout: 30000 }).catch(() => {}); await p.evaluate(() => { window.__mark = Math.random(); }); }
const marks = await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)));
const ids = await ctl.evaluate(async (vids) => { const t = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" }); return vids.map((v) => t.find((x) => x.url.includes(v)).id); }, VIDEOS);
const info = () => ctl.evaluate(async (ids) => {
  const lf = (await chrome.windows.getLastFocused()).id;
  return Promise.all(ids.map(async (id) => { const t = await chrome.tabs.get(id); const w = await chrome.windows.get(t.windowId);
    return { win: w.id, left: w.left, top: w.top, w: t.width, h: t.height, sound: !t.mutedInfo.muted, focused: w.id === lf, type: w.type }; }));
}, ids);
const noReload = async (label) => check((await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)))).every((m, i) => m === marks[i]), `${label}: no tab reloaded`);
const shoot = (file) => capture && execFileSync("powershell", ["-NoProfile", "-Command",
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file}')`]);
const big = (x) => x.w > 1000;

await call("setSettings", { patch: { wholeScreen: true, tuckTitleBars: true } });

// ---- Main + 3
let r = await call("tile", { tabIds: ids, layout: { rows: 4, cols: 3, merges: [{ r: 0, c: 0, rs: 3, cs: 3 }] } });
check(r.ok, "Main + 3 tiled", r.error);
await ctl.waitForTimeout(2000);
let s = await info();
console.log(s.map((x) => `${x.left},${x.top} ${x.w}x${x.h}${x.sound ? " sound" : ""}`).join(" | "));
check(big(s[0]) && s.slice(1).every((x) => !big(x)), "game 1 is main, 2-4 in the strip");
check(s[0].sound && s.filter((x) => x.sound).length === 1, "main game has the sound");
shoot(capture?.replace(/\.png$/, "-main3.png"));
await ctl.evaluate((w) => chrome.windows.update(w, { focused: true }), s[2].win); // click game 3
await ctl.waitForTimeout(2500);
let s2 = await info();
check(big(s2[2]) && !big(s2[0]), "click game 3 in the strip: it becomes main");
check(s2[0].left === s[2].left && s2[0].top === s[2].top, "the old main takes game 3's strip spot");
check(s2[2].sound && s2.filter((x) => x.sound).length === 1, "sound moved to the new main");
await ctl.evaluate((w) => chrome.windows.update(w, { focused: true }), s2[3].win); // click game 4
await ctl.waitForTimeout(2500);
s2 = await info();
check(big(s2[3]) && s2.filter(big).length === 1, "click game 4: it becomes main");
await noReload("Main + 3");

await call("untile");
await call("setSettings", { patch: { wholeScreen: false, tuckTitleBars: false } });
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
