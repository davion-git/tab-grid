// Twitch, Prime Video and "any site": Twitch's front page (its featured
// stream plays on its own), Prime Video's public page, and a local test page
// standing in for a small stream site, whose player is an embedded frame
// that plays with sound. Checks they are listed, tile, and that video-only
// fills the window.
//   node any-site.mjs   (always headed)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

// A stand-in stream site on localhost: no <video> of its own, the player in
// an embedded frame (a public YouTube video), plus a header and a sidebar.
const site = fs.mkdtempSync(path.join(os.tmpdir(), "tabgrid-site-"));
fs.writeFileSync(path.join(site, "index.html"), `<!doctype html><title>Some stream site</title>
<body style="margin:0;font:16px sans-serif">
<header style="height:80px;background:#225;color:#fff">Stream site header</header>
<div style="display:flex"><main style="flex:1;padding:20px">
  <div style="transform:translateZ(0)"><iframe width="640" height="360" allowfullscreen allow="autoplay; fullscreen"
    src="https://www.youtube.com/embed/9bZkp7q19f0?autoplay=1"></iframe></div>
  <audio src="tone.wav" autoplay loop></audio>
  <p>Chat and other stuff</p></main><aside style="width:300px;background:#eee;height:600px">Sidebar</aside></div></body>`);
// The embed may not start from a localhost page, so the page also plays a
// quiet tone of its own: what makes Chrome report the tab as playing.
{
  const rate = 8000, n = rate * 2, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  fs.writeFileSync(path.join(site, "tone.wav"), buf);
}
const server = spawn("python", ["-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", site], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"] });
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const ctl = await ctx.newPage();
  await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
  const URLS = ["https://www.twitch.tv/", "https://www.primevideo.com/", "http://127.0.0.1:8765/"];
  const pages = [];
  for (const u of URLS) { const p = await ctx.newPage(); await p.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {}); pages.push(p); }
  await ctl.waitForTimeout(9000); // let the featured stream and the embed start
  console.log("landed on:", pages.map((p) => p.url()).join(" | "));
  const tabs = await ctl.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, audible: t.audible })));
  console.log("audible:", tabs.filter((t) => t.audible).map((t) => t.url).join(" | ") || "none");

  await ctl.reload(); await ctl.waitForTimeout(1000);
  const listed = await ctl.evaluate(() => [...document.querySelectorAll("#tabList .title")].map((e) => e.title));
  check(listed.some((u) => u.includes("twitch.tv")), "Twitch tab listed");
  check(listed.some((u) => u.includes("primevideo.com")), "Prime Video tab listed");
  check(listed.some((u) => u.includes("127.0.0.1:8765")), "unknown stream site listed because it's playing sound (no Show all tabs)", listed.join(" | "));

  const ids = URLS.map((u, i) => tabs.find((t) => t.url === pages[i].url())?.id);
  const r = await call("tile", { tabIds: ids, layout: { rows: 1, cols: 3 } });
  check(r.ok, "tiled Twitch + Prime Video + stream site", r.error);
  await ctl.waitForTimeout(2500);
  const st = await ctl.evaluate(async () => (await chrome.storage.session.get("tiling")).tiling);
  check(st.tiles.map((t) => t.videoOnly).join(",") === "true,true,false", "video-only on for Twitch and Prime Video; off for the unknown site until allowed",
    st.tiles.map((t) => t.videoOnly).join(","));

  const twitch = await pages[0].evaluate(() => {
    const v = document.querySelector("video");
    const r = v?.getBoundingClientRect();
    return { overflow: getComputedStyle(document.documentElement).overflow, video: r ? [r.x, r.y, r.width, r.height].map(Math.round) : null, vw: innerWidth, vh: innerHeight };
  });
  check(twitch.overflow === "hidden", "Twitch: video-only stylesheet applied");
  check(twitch.video && twitch.video[0] === 0 && twitch.video[1] === 0 && twitch.video[2] === twitch.vw && twitch.video[3] === twitch.vh,
    "Twitch: the stream fills the window", JSON.stringify(twitch));

  // Unknown site without permission: nothing injected even if switched on.
  await call("setVideoOnly", { tabId: ids[2], on: true });
  await ctl.waitForTimeout(600);
  check((await pages[2].evaluate(() => getComputedStyle(document.documentElement).overflow)) !== "hidden",
    "unknown site: nothing injected until the site is allowed");
  // What it looks like once allowed (Chrome's permission prompt can't be
  // clicked from a test, so the same stylesheet is added directly).
  await pages[2].addStyleTag({ path: path.join(ext, "css", "video-only-generic.css") });
  await pages[2].waitForTimeout(500);
  const embed = await pages[2].evaluate(() => {
    const r = document.querySelector("iframe").getBoundingClientRect();
    return { frame: [r.x, r.y, r.width, r.height].map(Math.round), vw: innerWidth, vh: innerHeight };
  });
  check(embed.frame[0] === 0 && embed.frame[1] === 0 && embed.frame[2] === embed.vw && embed.frame[3] === embed.vh,
    "unknown site: the embedded player fills the window", JSON.stringify(embed));
  await call("untile");
} finally {
  await ctx.close();
  server.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
