// "Fill each tile" and "Paste a link": Twitch's front page cropped to fill
// its tile; a pasted web page link and a pasted direct video file each open
// as a new tile, the file in Tab Grid's own player. Needs ffmpeg on PATH
// (makes the test clip) and Python (serves it on localhost).
//   node link-fill.mjs   (always headed)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabgrid-clip-"));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=60",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-c:v", "libvpx", "-b:v", "500k", "-c:a", "libvorbis", "-shortest",
  path.join(dir, "clip.webm")]);
const server = spawn("python", ["-m", "http.server", "8766", "--bind", "127.0.0.1", "--directory", dir], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"] });
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const ctl = await ctx.newPage();
  await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  const call = (type, extra = {}) => ctl.evaluate(([type, extra]) => chrome.runtime.sendMessage({ type, ...extra }), [type, extra]);
  const twitch = await ctx.newPage();
  await twitch.goto("https://www.twitch.tv/", { waitUntil: "domcontentloaded" });
  await twitch.waitForTimeout(8000);
  const twitchId = await ctl.evaluate(async () => (await chrome.tabs.query({ url: "https://www.twitch.tv/*" }))[0].id);

  let r = await call("tile", { tabIds: [twitchId], layout: { rows: 1, cols: 2 } });
  check(r.ok, "Twitch tiled (1x2: a tall tile, so black bars above and below)");
  await ctl.waitForTimeout(2000);
  const fit = () => twitch.evaluate(() => getComputedStyle(document.querySelector("video")).objectFit);
  check((await fit()) === "contain", "without Fill: whole picture, with bars", await fit());
  await call("setSettings", { patch: { fillTiles: true } });
  await ctl.waitForTimeout(800);
  check((await fit()) === "cover", "Fill each tile on: picture cropped to fill", await fit());
  await twitch.screenshot({ path: path.join(os.tmpdir(), "tabgrid-fill.png") });

  // Paste a web page link
  r = await call("openLink", { url: "https://example.com/" });
  check(r.ok && r.result.tiles.length === 2, "pasted page link opens as tile 2", r.error);
  // Paste a direct video file link
  r = await call("openLink", { url: "http://127.0.0.1:8766/clip.webm" });
  check(r.ok && r.result.tiles.length === 3 && r.result.layout.rows === 2 && r.result.layout.cols === 2,
    "pasted video file opens as tile 3; the full 1x2 grew to 2x2", r.error || JSON.stringify(r.result.layout));
  await ctl.waitForTimeout(3000);
  const player = ctx.pages().find((p) => p.url().includes("player.html"));
  const ps = player && await player.evaluate(() => ({ t: document.getElementById("v").currentTime, paused: document.getElementById("v").paused,
    msg: document.getElementById("msg").hidden ? "" : document.getElementById("msg").textContent, fill: document.getElementById("v").className }));
  check(ps && ps.t > 0 && !ps.paused, "Tab Grid's player plays the pasted file", JSON.stringify(ps));
  check(ps?.fill === "fill", "Fill each tile applies to the player too");
  const info = await ctl.evaluate(async () => (await chrome.storage.session.get("tiling")).tiling.tiles.length);
  check(info === 3, "grid holds Twitch, the page and the file");
  r = await call("openLink", { url: "not a link" });
  check(!r.ok && /web address/.test(r.error), "a non-link is refused with a message", r.error);
  await call("untile");
  await call("setSettings", { patch: { fillTiles: false } });
} finally {
  await ctx.close();
  server.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
