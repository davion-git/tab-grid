// Twitch with video-only: a live channel (picked from Twitch's directory)
// fills its tile and Twitch's own controls still work at the bottom edge.
//   node twitch.mjs   (always headed)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import os from "os";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"] });
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const ctl = await ctx.newPage();
  await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
  const tw = await ctx.newPage();
  await tw.goto("https://www.twitch.tv/directory/all", { waitUntil: "domcontentloaded" });
  await tw.waitForTimeout(6000);
  const channel = await tw.evaluate(() => [...document.querySelectorAll('a[data-a-target="preview-card-image-link"]')].map((a) => a.getAttribute("href"))[0]);
  await tw.goto("https://www.twitch.tv" + channel, { waitUntil: "domcontentloaded" });
  await tw.waitForTimeout(9000);
  console.log("channel:", channel);
  const tabId = await ctl.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u)).id, "https://www.twitch.tv" + channel);
  const r = await call("tile", { tabIds: [tabId], layout: { rows: 2, cols: 2 } });
  check(r.ok, "Twitch channel tiled (2x2 tile)");
  await tw.waitForTimeout(2500);
  const s = await tw.evaluate(() => {
    const box = document.querySelector("[data-tabgrid-player]");
    const v = document.querySelector("video");
    const rb = box?.getBoundingClientRect(), rv = v.getBoundingClientRect();
    return { box: box ? [box.tagName, box.className.toString().slice(0, 40)] : null, holdsControls: !!box?.querySelector('[data-a-target="player-mute-unmute-button"]'),
      boxRect: rb && [rb.x, rb.y, rb.width, rb.height].map(Math.round), videoRect: [rv.x, rv.y, rv.width, rv.height].map(Math.round), vw: innerWidth, vh: innerHeight };
  });
  console.log(JSON.stringify(s));
  check(!!s.box && s.holdsControls, "marked Twitch's player box, which holds its controls");
  check(s.boxRect?.[2] === s.vw && s.boxRect?.[3] === s.vh && s.videoRect[2] === s.vw && s.videoRect[3] === s.vh, "player box and video fill the window");
  const status = await ctl.evaluate(async (id) => (await chrome.storage.session.get("cssStatus")).cssStatus[id], tabId);
  check(status === "on", "status: on", status);

  // Hover the bottom edge, then use Twitch's own mute button.
  await tw.mouse.move(s.vw / 2, s.vh - 30);
  await tw.waitForTimeout(800);
  const btn = await tw.evaluate(() => { const b = document.querySelector('[data-a-target="player-mute-unmute-button"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  const top = await tw.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-a-target="player-mute-unmute-button"]') ? "mute button" : document.elementFromPoint(x, y)?.tagName, btn);
  check(top === "mute button", "Twitch's mute button is on top at the bottom edge", `${top} at ${Math.round(btn.x)},${Math.round(btn.y)}`);
  const m0 = await tw.evaluate(() => document.querySelector("video").muted);
  await tw.mouse.click(btn.x, btn.y);
  await tw.waitForTimeout(600);
  const m1 = await tw.evaluate(() => document.querySelector("video").muted);
  check(m0 !== m1, "clicking it mutes/unmutes the stream", `muted ${m0} -> ${m1}`);
  const p0 = await tw.evaluate(() => document.querySelector("video").paused);
  await tw.mouse.click(s.vw / 2, s.vh / 3);
  await tw.waitForTimeout(600);
  check((await tw.evaluate(() => document.querySelector("video").paused)) === p0, "a click on the picture doesn't pause it");
  await tw.screenshot({ path: path.join(os.tmpdir(), "tabgrid-twitch-controls.png") });
  await call("untile");
} finally {
  await ctx.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
