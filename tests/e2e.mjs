// End-to-end check of Tab Grid in a throwaway Chromium profile (logged out,
// public videos only). The test plays the part of the user: it opens the
// videos and presses play itself, then asks the extension to tile them.
//   node tests/e2e.mjs   (always headed: chrome.system.display crashes headless Chromium)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const shots = path.join(here, "shots");
fs.mkdirSync(shots, { recursive: true });
const headed = true;

const VIDEOS = ["dQw4w9WgXcQ", "LXb3EKWsInQ", "M7lc1UVf-VE", "9bZkp7q19f0", "kJQP7kiw5Fk", "OPf0YbXqDm0"];

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tabgrid-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: !headed,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"],
  viewport: null,
});
const errors = [];
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const extId = new URL(sw.url()).host;
check(!!extId, "extension loaded, service worker running", extId);

// Control page: an extension page used to send the popup's messages and
// read window/tab state.
const ctl = await ctx.newPage();
ctl.on("pageerror", (e) => errors.push("popup: " + e.message));
ctl.on("console", (m) => m.type() === "error" && errors.push("popup console: " + m.text()));
await ctl.goto(`chrome-extension://${extId}/popup.html`);
await ctl.waitForTimeout(500);
const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
const tabsInfo = () => ctl.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/watch*"] });
  const out = [];
  for (const t of tabs) {
    const w = await chrome.windows.get(t.windowId, { populate: true });
    out.push({ id: t.id, url: t.url, muted: t.mutedInfo.muted, win: { id: w.id, type: w.type, n: w.tabs.length, left: w.left, top: w.top, width: w.width, height: w.height } });
  }
  return out;
});
const display = await ctl.evaluate(async () => (await chrome.system.display.getInfo()).map((d) => ({ id: d.id, primary: d.isPrimary, workArea: d.workArea })));
console.log("displays:", JSON.stringify(display));

// Open and start the videos, as the user would.
const pages = [];
for (const v of VIDEOS) {
  const p = await ctx.newPage();
  await p.goto(`https://www.youtube.com/watch?v=${v}`, { waitUntil: "domcontentloaded" });
  pages.push(p);
}
for (const p of pages) {
  await p.waitForSelector("video", { timeout: 30000 }).catch(() => {});
  await p.evaluate(() => {
    window.__tabgridMarker = Math.random();
    const v = document.querySelector("video");
    if (v) { v.muted = false; v.play().catch(() => {}); }
  });
}
await pages[0].waitForTimeout(6000);
const markers = await Promise.all(pages.map((p) => p.evaluate(() => ({ m: window.__tabgridMarker, t0: performance.timeOrigin }))));

async function pageStatus() {
  return Promise.all(pages.map((p) => p.evaluate(() => {
    const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const mp = document.querySelector("#movie_player")?.getBoundingClientRect();
    const mast = document.querySelector("#masthead-container");
    return {
      marker: window.__tabgridMarker, t0: performance.timeOrigin,
      time: v?.currentTime ?? -1, paused: v?.paused ?? true, ended: v?.ended ?? false,
      ad: !!document.querySelector("#movie_player.ad-showing"), ready: v?.readyState ?? -1,
      vw: innerWidth, vh: innerHeight,
      player: mp ? { x: Math.round(mp.x), y: Math.round(mp.y), w: Math.round(mp.width), h: Math.round(mp.height) } : null,
      mastHidden: mast ? getComputedStyle(mast).display === "none" : null,
      title: document.title, url: location.href,
      err: document.querySelector(".ytp-error")?.innerText?.slice(0, 80) || "",
    };
  }).catch((e) => ({ error: String(e) }))));
}

function noReload(before, after, label) {
  const same = after.every((s, i) => s.marker === before[i].m && s.t0 === before[i].t0);
  check(same, `${label}: no tab reloaded (page marker and timeOrigin unchanged)`);
}

async function stillPlaying(label) {
  const a = await pageStatus();
  await pages[0].waitForTimeout(2500);
  const b = await pageStatus();
  let playing = b.map((s, i) => s.time > a[i].time && !s.paused);
  if (!playing.every(Boolean)) {
    console.log(`  (${label}: not advancing on first look: ${b.map((s, i) => playing[i] ? "" : `${i} paused=${s.paused} ready=${s.ready} t=${s.time.toFixed(1)} ad=${s.ad} ${s.url.slice(-14)} ${s.err}`).filter(Boolean).join("; ")}; looking again)`);
    await pages[0].waitForTimeout(4000);
    const c = await pageStatus();
    playing = c.map((s, i) => (s.time > b[i].time && !s.paused) || s.ad); // an ad break is YouTube, not a fault
    b.splice(0, b.length, ...c);
  }
  check(playing.every(Boolean), `${label}: videos keep playing`, b.map((s, i) => playing[i] ? "P" : `[${i}: paused=${s.paused} ended=${s.ended} ad=${s.ad} ready=${s.ready} t=${s.time.toFixed(1)} url=${s.url.slice(-20)} err=${s.err}]`).join(" "));
}

const before = await pageStatus();
console.log("titles:", before.map((s) => s.title).join(" | "));
check(before.every((s) => s.time > 0), "all videos started", before.map((s) => s.time.toFixed(1)).join(", "));

// ---- 2x2
const firstInfo = await tabsInfo();
const ids = VIDEOS.map((v) => firstInfo.find((t) => t.url.includes(v)).id); // same order as pages[]
let r = await call("tile", { tabIds: ids.slice(0, 4), layout: { rows: 2, cols: 2 } });
check(r.ok, "2x2 tile call", r.error);
await pages[0].waitForTimeout(1500);
let info = await tabsInfo();
const tiled = ids.slice(0, 4).map((id) => info.find((t) => t.id === id));
check(tiled.every((t) => t.win.type === "popup" && t.win.n === 1), "2x2: each tab alone in a popup window");
const wa = display.find((d) => d.primary).workArea;
const exp = (row, col, R, C) => ({ left: wa.left + Math.round((col * wa.width) / C), top: wa.top + Math.round((row * wa.height) / R) });
const near = (t, e) => Math.abs(t.win.left - e.left) <= 2 && Math.abs(t.win.top - e.top) <= 2;
console.log("2x2 bounds:", tiled.map((t) => `${t.win.left},${t.win.top} ${t.win.width}x${t.win.height}`).join(" | "));
check(tiled.every((t, i) => near(t, exp(Math.floor(i / 2), i % 2, 2, 2))), "2x2: windows at their cell positions");
check(tiled.filter((t) => !t.muted).length === 1, "2x2: exactly one tile unmuted");
noReload(markers, await pageStatus(), "2x2");
await stillPlaying("2x2");
let st = await pageStatus();
check(st.slice(0, 4).every((s) => s.mastHidden === true), "video-only: masthead hidden in tiles");
check(st.slice(0, 4).every((s) => s.player && s.player.x === 0 && s.player.y === 0 && Math.abs(s.player.w - s.vw) <= 1 && Math.abs(s.player.h - s.vh) <= 1), "video-only: player fills the window", JSON.stringify(st[0].player) + ` vs ${st[0].vw}x${st[0].vh}`);
await pages[0].screenshot({ path: path.join(shots, "2x2-tile1-video-only.png") });

// Toggle video-only off for tile 1
await call("setVideoOnly", { tabId: ids[0], on: false });
await pages[0].waitForTimeout(800);
st = await pageStatus();
check(st[0].mastHidden === false && st[1].mastHidden === true, "per-tile toggle: tile 1 normal page, tile 2 still video-only");
await pages[0].screenshot({ path: path.join(shots, "2x2-tile1-normal.png") });
await call("setVideoOnly", { tabId: ids[0], on: true });

// Audio switching: focus tile 3's window, as a click would.
await ctl.evaluate((id) => chrome.windows.update(id, { focused: true }), tiled[2].win.id);
await pages[0].waitForTimeout(1000);
info = await tabsInfo();
let audible = info.filter((t) => ids.slice(0, 4).includes(t.id) && !t.muted).map((t) => t.id);
check(audible.length === 1 && audible[0] === ids[2], "audio follows window focus (onFocusChanged)", `unmuted=${audible}`);
await call("focusTile", { tabId: ids[1] });
info = await tabsInfo();
audible = info.filter((t) => ids.slice(0, 4).includes(t.id) && !t.muted).map((t) => t.id);
check(audible.length === 1 && audible[0] === ids[1], "jump-to-tile moves audio (Alt+N path)", `unmuted=${audible}`);

// No page changes mode
await call("setSettings", { patch: { noPageChanges: true } });
await pages[0].waitForTimeout(600);
st = await pageStatus();
check(st.slice(0, 4).every((s) => s.mastHidden === false), "no-page-changes: CSS removed from every tile");
await call("setSettings", { patch: { noPageChanges: false } });
await pages[0].waitForTimeout(600);
st = await pageStatus();
check(st.slice(0, 4).every((s) => s.mastHidden === true), "no-page-changes off: video-only back", st.slice(0, 4).map((s) => s.mastHidden).join(","));

// ---- 3x3 with all six (three cells stay empty) (re-tile: existing windows reused, others moved in)
const winsBefore = new Set(tiled.map((t) => t.win.id));
r = await call("tile", { tabIds: ids, layout: { rows: 3, cols: 3 } });
check(r.ok, "3x3 tile call", r.error);
await pages[0].waitForTimeout(1500);
info = await tabsInfo();
check(info.every((t) => t.win.type === "popup" && t.win.n === 1), "3x3: every tab in its own popup window");
check(ids.slice(0, 4).every((id) => winsBefore.has(info.find((t) => t.id === id).win.id)), "re-tile moved the existing 2x2 windows (same window ids)");
const nine = ids.map((id) => info.find((t) => t.id === id));
console.log("3x3 bounds:", nine.map((t) => `${t.win.left},${t.win.top} ${t.win.width}x${t.win.height}`).join(" | "));
check(nine.every((t, i) => near(t, exp(Math.floor(i / 3), i % 3, 3, 3))), "3x3: positions");
noReload(markers, await pageStatus(), "3x3");
await stillPlaying("3x3");

// ---- custom 2x3
await call("tile", { tabIds: ids.slice(0, 6), layout: { rows: 2, cols: 3 } });
await pages[0].waitForTimeout(1500);
info = await tabsInfo();
const six = ids.slice(0, 6).map((id) => info.find((t) => t.id === id));
check(six.every((t) => t.win.type === "popup" && t.win.n === 1), "custom 2x3: six tiles");
check(six.every((t, i) => near(t, exp(Math.floor(i / 3), i % 3, 2, 3))), "custom 2x3: positions");
noReload(markers, await pageStatus(), "2x3");

// ---- merged 3x3: 2x2 at top-left => 6 cells
const merged = { rows: 3, cols: 3, merges: [{ r: 0, c: 0, rs: 2, cs: 2 }] };
await call("tile", { tabIds: ids.slice(0, 6), layout: merged });
await pages[0].waitForTimeout(1500);
info = await tabsInfo();
const m6 = ids.slice(0, 6).map((id) => info.find((t) => t.id === id));
const bigW = Math.round((2 * wa.width) / 3), bigH = Math.round((2 * wa.height) / 3), smallW = Math.round(wa.width / 3);
console.log("merged bounds:", m6.map((t) => `${t.win.left},${t.win.top} ${t.win.width}x${t.win.height}`).join(" | "));
check(Math.abs(m6[0].win.width - bigW) <= 2 && Math.abs(m6[0].win.height - bigH) <= 2, "merged: tile 1 spans 2x2 of 3x3");
check(m6.slice(1).every((t) => Math.abs(t.win.width - smallW) <= 2), "merged: other tiles are single cells");
noReload(markers, await pageStatus(), "merged");

// swap tile 4 (given audio) into the big cell
await call("focusTile", { tabId: ids[3] });
await call("swapBig", {});
await pages[0].waitForTimeout(1200);
info = await tabsInfo();
const t4 = info.find((t) => t.id === ids[3]), t1 = info.find((t) => t.id === ids[0]);
check(Math.abs(t4.win.width - bigW) <= 2 && t4.win.left === m6[0].win.left && t1.win.left === m6[3].win.left && t1.win.top === m6[3].win.top, "swap into big cell: tile 4 now big, tile 1 took its place");
check(!t4.muted && info.filter((t) => ids.slice(0, 6).includes(t.id) && !t.muted).length === 1, "swap: the swapped-in tile has the audio");
noReload(markers, await pageStatus(), "swap");
await stillPlaying("merged + swap");

// A user reload of a tile keeps video-only (CSS re-applied on load)
await pages[5].reload();
await pages[5].waitForSelector("#movie_player", { timeout: 30000 });
await pages[5].waitForTimeout(2500);
st = await pageStatus();
check(st[5].mastHidden === true, "user reload of a tile: video-only re-applied");
markers[5] = { m: st[5].marker, t0: st[5].t0 };

// ---- untile
await call("untile");
await pages[0].waitForTimeout(1500);
info = await tabsInfo();
const winIds = new Set(info.map((t) => t.win.id));
check(winIds.size === 1 && info[0].win.type === "normal", "un-tile: all tabs back in one normal window", `${winIds.size} windows`);
st = await pageStatus();
check(st.every((s) => s.mastHidden === false), "un-tile: CSS removed");
noReload(markers, st, "un-tile");

// Service worker errors show up on chrome://extensions; check none were logged.
const swErrors = await sw.evaluate(() => self.__errors || []).catch(() => []);
check(errors.length === 0 && swErrors.length === 0, "no errors from service worker or popup", errors.join(" / "));
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
