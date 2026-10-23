// Player detection on sites Tab Grid doesn't know, with stand-in pages built
// like small stream sites: (1) a small ad <video> on the page and the real
// player two frames deep, from another address, without "allowfullscreen";
// (2) a page with its own <video> next to a smaller ad frame. Also: a pasted
// link turns video-only on and asks for the site's permission.
// Needs ffmpeg (test clip) and Python (local server).
//   node detect.mjs   (always headed)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// detect.js is an ES module for Chrome; Node needs a .mjs copy to import it.
const detectCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tabgrid-")), "detect.mjs");
fs.copyFileSync(path.join(ext, "detect.js"), detectCopy);
const { markLargestPlayer } = await import(pathToFileURL(detectCopy));
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabgrid-detect-"));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=60",
  "-c:v", "libvpx", "-b:v", "400k", path.join(dir, "clip.webm")]);
const page = (body) => `<!doctype html><body style="margin:0;font:16px sans-serif;background:#fff">${body}</body>`;
// (1) The real player: localhost:8767 (another address than 127.0.0.1:8767).
// Like real embed pages, both fill whatever frame they're put in.
fs.writeFileSync(path.join(dir, "player.html"), page(`<video src="clip.webm" autoplay muted loop style="position:fixed;inset:0;width:100vw;height:100vh;background:#000"></video>`));
fs.writeFileSync(path.join(dir, "frame.html"), page(`<iframe src="player.html" style="position:fixed;inset:0;border:0;width:100vw;height:100vh"></iframe>`));
fs.writeFileSync(path.join(dir, "site1.html"), page(`
  <header style="height:70px;background:#333;color:#fff">Stream site</header>
  <video src="clip.webm" autoplay muted loop style="position:absolute;right:10px;top:80px;width:200px;height:112px"></video>
  <main style="padding:20px;transform:translateZ(0)">
    <iframe src="http://localhost:8767/frame.html" width="700" height="394" style="border:0"></iframe>
    <p>chat, schedule, links</p></main>
  <div style="position:fixed;left:0;right:0;bottom:0;height:60px;background:#a00;z-index:999">cookie banner</div>`));
// (2) A page with its own video and a smaller ad frame.
fs.writeFileSync(path.join(dir, "site2.html"), page(`
  <div style="display:flex;gap:10px;padding:10px">
    <div style="contain:paint"><video src="clip.webm" autoplay muted loop style="width:640px;height:360px"></video></div>
    <iframe src="http://localhost:8767/frame.html" width="300" height="250" style="border:0"></iframe></div>`));
// (3) A player widget: the video is inside the widget's own shadow DOM.
fs.writeFileSync(path.join(dir, "site3.html"), page(`
  <header style="height:70px;background:#333;color:#fff">Stream site</header>
  <my-player style="display:block;width:640px;height:360px;margin:20px"></my-player>
  <script>customElements.define("my-player", class extends HTMLElement { connectedCallback() {
    const r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<div style="position:relative;width:100%;height:100%"><video src="clip.webm" autoplay muted loop style="width:100%;height:100%;background:#000"></video>' +
      '<button id="mute" style="position:absolute;left:8px;bottom:8px">mute</button></div>'; } });</script>`));
const server = spawn("python", ["-m", "http.server", "8767", "--directory", dir], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const markedCss = path.join(ext, "css", "video-only-marked.css");
const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"] });
try {
  // The detection and the stylesheet, as they run on an allowed site.
  for (const [name, expectTag] of [["site1.html", "iframe"], ["site2.html", "video"], ["site3.html", "video"]]) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 960, height: 540 });
    await p.goto(`http://127.0.0.1:8767/${name}`);
    await p.waitForTimeout(2500);
    const found = await p.evaluate(markLargestPlayer);
    check(found?.player === expectTag, `${name}: found the player (${expectTag}), not the ad`, JSON.stringify(found));
    await p.addStyleTag({ path: markedCss });
    await p.waitForTimeout(500);
    const res = await p.evaluate(() => {
      const el = document.querySelector("[data-tabgrid-player]");
      const r = el.getBoundingClientRect();
      // What's under the click shield at the centre: hide the shield's
      // effect by asking which element paints there.
      const under = document.elementsFromPoint(innerWidth / 2, innerHeight / 3).find((e) => e !== document.documentElement);
      return { rect: [r.x, r.y, r.width, r.height].map(Math.round), vw: innerWidth, vh: innerHeight, topIsPlayer: el === under || el.contains(under) };
    });
    check(res.rect[0] === 0 && res.rect[1] === 0 && res.rect[2] === res.vw && res.rect[3] === res.vh,
      `${name}: the player fills the window`, JSON.stringify(res.rect));
    check(res.topIsPlayer, `${name}: nothing on the page (header, ad, banner) covers it`);
    await p.screenshot({ path: path.join(os.tmpdir(), `tabgrid-detect-${name}.png`) });
    await p.close();
  }

  // Through the extension: paste the stand-in's link.
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const ctl = await ctx.newPage();
  await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  const allow = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("allow.html"), timeout: 10000 }).catch(() => null);
  const r = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "openLink", url: "http://127.0.0.1:8767/site1.html" }));
  check(r.ok, "pasted the stand-in's link", r.error);
  const tile = r.result?.tiles?.[0];
  check(tile?.videoOnly === true, "video-only switched on for the pasted page");
  const ap = await allow;
  check(!!ap, "the Allow window opened for the new site", ap ? ap.url().split("/").pop() : "none");
  const status = await ctl.evaluate(async () => (await chrome.storage.session.get("cssStatus")).cssStatus);
  check(status?.[tile?.tabId] === "needs-permission", "until allowed, nothing is changed on the page", status?.[tile?.tabId]);
  await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "untile" }));
} finally {
  await ctx.close();
  server.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
