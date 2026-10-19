// "Send back to tab" check with 2 public videos: tile 1x2, send tile 1 back,
// it must land in a normal window without reloading; tile 2 stays tiled.
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"] });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const ctl = await ctx.newPage();
await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
const VIDEOS = ["dQw4w9WgXcQ", "9bZkp7q19f0"];
const pages = [];
for (const v of VIDEOS) { const p = await ctx.newPage(); await p.goto(`https://www.youtube.com/watch?v=${v}`, { waitUntil: "domcontentloaded" }); pages.push(p); }
for (const p of pages) { await p.waitForSelector("video", { timeout: 30000 }).catch(() => {}); await p.evaluate(() => { window.__mark = Math.random(); }); }
const marks = await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)));
const where = () => ctl.evaluate(async (vids) => {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
  return Promise.all(vids.map(async (v) => { const t = tabs.find((x) => x.url.includes(v)); const w = await chrome.windows.get(t.windowId, { populate: true }); return { id: t.id, type: w.type, n: w.tabs.length }; }));
}, VIDEOS);
let w = await where();
await call("tile", { tabIds: w.map((x) => x.id), layout: { rows: 1, cols: 2 } });
await pages[0].waitForTimeout(1500);
w = await where();
check(w.every((x) => x.type === "popup"), "tiled 1x2");
const r = await call("sendBack", { tabId: w[0].id });
await pages[0].waitForTimeout(1500);
w = await where();
check(r.ok && w[0].type === "normal", "tile 1 sent back into a normal window", JSON.stringify(w[0]));
check(w[1].type === "popup" && w[1].n === 1, "tile 2 still tiled");
const after = await Promise.all(pages.map((p) => p.evaluate(() => ({ mark: window.__mark, mast: getComputedStyle(document.querySelector("#masthead-container")).display }))));
check(after.every((a, i) => a.mark === marks[i]), "no tab reloaded");
check(after[0].mast !== "none", "sent-back tab has its normal page (video-only CSS removed)");
const st = await ctl.evaluate(async () => (await chrome.storage.session.get("tiling")).tiling);
check(st.tiles.length === 1 && st.tiles[0].tabId === w[1].id, "grid state now holds only tile 2");
await call("untile");
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
