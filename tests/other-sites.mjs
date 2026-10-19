// Fox One / other-site support: a YouTube video, the public fox.com page
// (no sign-in, no game) and example.com tiled together in a 1x3.
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const ctl = await ctx.newPage();
const errors = [];
ctl.on("pageerror", (e) => errors.push(e.message));
await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
const pages = [];
for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.fox.com/", "https://example.com/", "https://www.paramountplus.com/"]) {
  const p = await ctx.newPage(); await p.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {}); pages.push(p);
}
await ctl.waitForTimeout(4000);
for (const p of pages) await p.evaluate(() => { window.__mark = Math.random(); });
const marks = await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)));
console.log("fox.com landed on:", pages[1].url(), "| paramountplus.com landed on:", pages[3].url());

// What the popup lists: video tabs only, then with "Show all tabs".
await ctl.reload(); await ctl.waitForTimeout(800);
const listed = () => ctl.evaluate(() => [...document.querySelectorAll("#tabList .title")].map((e) => e.title));
let l = await listed();
check(l.some((u) => u.includes("youtube.com")) && l.some((u) => u.includes("fox.com")) && l.some((u) => u.includes("paramountplus.com")) && !l.some((u) => u.includes("example.com")), "popup lists YouTube, Fox and Paramount+ tabs", l.join(" | "));
await ctl.click("#showAll"); await ctl.waitForTimeout(500);
l = await listed();
check(l.some((u) => u.includes("example.com")), "Show all tabs lists other sites too");

const ids = await ctl.evaluate(async (urls) => {
  const tabs = await chrome.tabs.query({});
  return urls.map((u) => tabs.find((t) => t.url === u).id);
}, pages.map((p) => p.url()));
const r = await call("tile", { tabIds: ids, layout: { rows: 2, cols: 2 } });
check(r.ok, "tile YouTube + Fox + other site + Paramount+", r.error);
await ctl.waitForTimeout(1500);
const st = await ctl.evaluate(async () => (await chrome.storage.session.get("tiling")).tiling);
const info = await ctl.evaluate(async (ids) => Promise.all(ids.map(async (id) => { const t = await chrome.tabs.get(id); const w = await chrome.windows.get(t.windowId, { populate: true }); return { type: w.type, n: w.tabs.length, muted: t.mutedInfo.muted }; })), ids);
check(info.every((x) => x.type === "popup" && x.n === 1), "all four in their own tile windows");
check(info.filter((x) => !x.muted).length === 1, "sound rule applies to every site");
check(st.tiles.map((t) => t.videoOnly).join(",") === "true,true,false,true", "video-only starts on for YouTube, Fox and Paramount+, not other sites", st.tiles.map((t) => t.videoOnly).join(","));
const overflow = () => pages[1].evaluate(() => getComputedStyle(document.documentElement).overflow);
check((await overflow()) === "hidden", "Fox tab: video-only CSS applied on tiling");
check((await pages[3].evaluate(() => getComputedStyle(document.documentElement).overflow)) === "hidden", "Paramount+ tab: video-only CSS applied on tiling");
await call("setVideoOnly", { tabId: ids[1], on: false });
await ctl.waitForTimeout(500);
check((await overflow()) !== "hidden", "Fox tab: can be switched off");
const now = await Promise.all(pages.map((p) => p.evaluate(() => window.__mark)));
check(now.every((m, i) => m === marks[i]), "no tab reloaded");
await call("untile");
check(errors.length === 0, "no popup errors", errors.join(" / "));
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
