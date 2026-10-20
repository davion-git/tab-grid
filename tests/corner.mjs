// Corner layout with 2 public videos and "Hide title bars" on: the big game
// is full screen, clicking it changes nothing, clicking the corner game swaps
// the two, and a click never pauses a video.
//   node corner.mjs [capture.png]   (always headed; Windows screen capture if a path is given)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capture = process.argv[2];
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };
const shoot = (name) => capture && execFileSync("powershell", ["-NoProfile", "-Command",
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${capture.replace(/\.png$/, `-${name}.png`)}')`]);

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"] });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const ctl = await ctx.newPage();
await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
const VIDEOS = ["dQw4w9WgXcQ", "9bZkp7q19f0"];
const pages = [];
for (const v of VIDEOS) { const p = await ctx.newPage(); await p.goto(`https://www.youtube.com/watch?v=${v}`, { waitUntil: "domcontentloaded" }); pages.push(p); }
for (const p of pages) { await p.waitForSelector("video", { timeout: 30000 }).catch(() => {}); await p.evaluate(() => { window.__mark = Math.random(); document.querySelector("video")?.play().catch(() => {}); }); }
const marks = await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)));
const ids = await ctl.evaluate(async (vids) => { const t = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" }); return vids.map((v) => t.find((x) => x.url.includes(v)).id); }, VIDEOS);
const info = () => ctl.evaluate(async (ids) => {
  const lf = (await chrome.windows.getLastFocused()).id;
  return Promise.all(ids.map(async (id) => { const t = await chrome.tabs.get(id); const w = await chrome.windows.get(t.windowId);
    return { win: w.id, state: w.state, w: t.width, h: t.height, sound: !t.mutedInfo.muted, focused: w.id === lf }; }));
}, ids);
const holderFocused = () => ctl.evaluate(async () => (await chrome.windows.getLastFocused({ populate: true })).tabs?.[0]?.url?.endsWith("holder.html"));
const big = (x) => x.w > 1000;

await call("setSettings", { patch: { wholeScreen: true, tuckTitleBars: true } });
const r = await call("tile", { tabIds: ids, layout: { rows: 1, cols: 1, pip: { corner: "tr", size: 0.3 } } });
check(r.ok, "Corner tiled", r.error);
await ctl.waitForTimeout(3000);
let s = await info();
console.log(s.map((x) => `${x.state} ${x.w}x${x.h}${x.sound ? " sound" : ""}`).join(" | "));
check(s[0].state === "fullscreen" && s[0].h >= 1079, "big game is full screen, no gap at the bottom", `${s[0].w}x${s[0].h}`);
check(!big(s[1]) && s[1].w === 576, "game 2 in the corner");
check(await holderFocused(), "the helper window is the active one");
check(s[0].sound && !s[1].sound, "big game has the sound");
shoot("start");

// Click the big game: nothing swaps, the corner game comes back on top.
await ctl.evaluate((w) => chrome.windows.update(w, { focused: true }), s[0].win);
await ctl.waitForTimeout(1500);
let s2 = await info();
check(big(s2[0]) && !big(s2[1]) && s2[0].sound, "click the big game: no swap, sound stays");
check(await holderFocused(), "helper active again (corner back on top)");
shoot("after-main-click");

// Click the corner game: they swap.
await ctl.evaluate((w) => chrome.windows.update(w, { focused: true }), s[1].win);
await ctl.waitForTimeout(3500);
s2 = await info();
console.log(s2.map((x) => `${x.state} ${x.w}x${x.h}${x.sound ? " sound" : ""}`).join(" | "));
check(big(s2[1]) && s2[1].state === "fullscreen" && !big(s2[0]) && s2[0].state === "normal", "click the corner game: it becomes the big one, full screen");
check(s2[1].sound && !s2[0].sound, "sound went with the new big game");
check(await holderFocused(), "helper active after the swap");
shoot("after-corner-click");

// Fast clicks: the big game clicked 300 ms after a swap (used to be
// ignored, leaving the corner game hidden), then several swaps in a row.
const winOf = (i) => ctl.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, ids[i]);
const clickWin = (w) => ctl.evaluate((w) => chrome.windows.update(w, { focused: true }), w);
const cornerIndex = async () => ((await info()).findIndex((x) => !big(x)));
await clickWin(await winOf(await cornerIndex()));          // swap
await ctl.waitForTimeout(300);
await clickWin(await winOf(1 - (await cornerIndex())));    // quick click on the big game
await ctl.waitForTimeout(2000);
check(await holderFocused(), "quick click on the big game: corner put back on top");
shoot("after-quick-click");
for (let k = 0; k < 4; k++) {
  const before = await cornerIndex();
  await clickWin(await winOf(before));
  await ctl.waitForTimeout(1500);
  const after = await info();
  check(after.findIndex((x) => !big(x)) === 1 - before && after.filter((x) => x.state === "fullscreen").length === 1 && await holderFocused(),
    `swap ${k + 1} of 4: games swapped, one full screen, corner on top`);
}
shoot("after-swaps");

// A real mouse click on a video must not pause it.
const before = await pages[1].evaluate(() => document.querySelector("video").paused);
await pages[1].mouse.click(600, 400);
await pages[1].waitForTimeout(800);
const after = await pages[1].evaluate(() => ({ paused: document.querySelector("video").paused, ad: !!document.querySelector("#movie_player.ad-showing") }));
check(before === after.paused, "mouse click on the video doesn't pause or play it", `paused before=${before} after=${after.paused} ad=${after.ad}`);

check((await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)))).every((m, i) => m === marks[i]), "no tab reloaded");
await call("untile");
await ctl.waitForTimeout(800);
check(!(await ctl.evaluate(async () => (await chrome.windows.getAll({ populate: true })).some((w) => w.tabs.some((t) => t.url.endsWith("holder.html"))))), "un-tile closes the helper window");
await call("setSettings", { patch: { wholeScreen: false, tuckTitleBars: false } });
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
