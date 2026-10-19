// "Only one tile plays sound" on/off, with 2 public videos.
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
for (const v of ["dQw4w9WgXcQ", "9bZkp7q19f0"]) { const p = await ctx.newPage(); await p.goto(`https://www.youtube.com/watch?v=${v}`, { waitUntil: "domcontentloaded" }); }
await ctl.waitForTimeout(3000);
const tabs = () => ctl.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/watch*" })).map((t) => ({ id: t.id, win: t.windowId, muted: t.mutedInfo.muted })));
let t = await tabs();
const ids = t.map((x) => x.id);
await call("tile", { tabIds: ids, layout: { rows: 1, cols: 2 } });
await ctl.waitForTimeout(1500);
const muted = async () => (await tabs()).map((x) => x.muted).join(",");
check((await muted()).split(",").filter((m) => m === "false").length === 1, "default: one tile has sound", await muted());
await call("setSettings", { patch: { singleAudio: false } });
check((await muted()) === "false,false", "option off: both tiles unmuted", await muted());
await call("toggleMute", { tabId: ids[1] });
check((await muted()) === "false,true", "mute button mutes just that tile", await muted());
t = await tabs();
await ctl.evaluate((w) => chrome.windows.update(w, { focused: true }), t[1].win);
await ctl.waitForTimeout(1000);
check((await muted()) === "false,true", "clicking a tile doesn't change sound while off", await muted());
await call("toggleMute", { tabId: ids[1] });
check((await muted()) === "false,false", "unmute again", await muted());
await call("setSettings", { patch: { singleAudio: true } });
check((await muted()).split(",").filter((m) => m === "false").length === 1, "option back on: one tile has sound", await muted());
await call("untile");
await ctx.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
