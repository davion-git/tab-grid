// A stream site whose whole page is a full-window frame from another
// address, with the real player one frame further in (plus a small ad
// video). Chrome's permission prompt can't be clicked from a test, so this
// loads copies of the extension pre-allowed on the test addresses:
//   A) allowed everywhere involved (what "All sites" gives): the real player
//      fills the window and the status is "on";
//   B) allowed only on the top page: the status says the player is in a
//      frame from another site ("frame-only"), so the popup offers Allow...
// Needs ffmpeg (test clip) and Python (local server).
//   node frames.mjs   (always headed)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? "  -- " + d : ""}`); if (!ok) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabgrid-frames-"));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=60", "-c:v", "libvpx", "-b:v", "400k", path.join(dir, "clip.webm")]);
const page = (body) => `<!doctype html><body style="margin:0;font:16px sans-serif;background:#fff">${body}</body>`;
// Top page (127.0.0.1) = one full-window frame from localhost.
fs.writeFileSync(path.join(dir, "site.html"), page(`<iframe src="http://localhost:8769/shell.html" style="position:fixed;inset:0;width:100vw;height:100vh;border:0"></iframe>`));
// The shell (localhost): header, ad video, the player frame from 127.0.0.1, chat.
fs.writeFileSync(path.join(dir, "shell.html"), page(`
  <header style="height:70px;background:#333;color:#fff">Stream site</header>
  <video src="clip.webm" autoplay muted loop style="position:absolute;right:10px;top:80px;width:200px;height:112px"></video>
  <main style="padding:20px"><iframe src="http://127.0.0.1:8769/player.html" width="700" height="394" style="border:0"></iframe><p>chat</p></main>`));
fs.writeFileSync(path.join(dir, "player.html"), page(`<video src="clip.webm" autoplay muted loop style="position:fixed;inset:0;width:100vw;height:100vh;background:#000"></video>`));
const server = spawn("python", ["-m", "http.server", "8769", "--directory", dir], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

// Extension copies with extra host permissions for the test addresses.
function copyWith(hosts) {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "tabgrid-ext-"));
  for (const f of fs.readdirSync(ext)) if (!["tests", ".git", "node_modules"].includes(f)) fs.cpSync(path.join(ext, f), path.join(to, f), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(to, "manifest.json"), "utf8"));
  m.host_permissions.push(...hosts);
  fs.writeFileSync(path.join(to, "manifest.json"), JSON.stringify(m));
  return to;
}

async function run(label, hosts, expect) {
  const copy = copyWith(hosts);
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, viewport: null,
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`, "--autoplay-policy=no-user-gesture-required"] });
  try {
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
    const ctl = await ctx.newPage();
    await ctl.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    const version = await ctl.evaluate(() => document.getElementById("version").textContent);
    const r = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "openLink", url: "http://127.0.0.1:8769/site.html" }));
    check(r.ok, `${label}: pasted the site's link`, r.error);
    await ctl.waitForTimeout(6000); // page load, frames, the "complete" re-run
    const tabId = r.result.tiles[0].tabId;
    const status = await ctl.evaluate(async (id) => (await chrome.storage.session.get("cssStatus")).cssStatus[id], tabId);
    check(status === expect, `${label}: status "${expect}"`, status);
    const site = ctx.pages().find((p) => p.url().includes("site.html"));
    if (expect === "on") {
      const shell = site.frames().find((f) => f.url().includes("shell.html"));
      const res = await shell.evaluate(() => {
        const el = document.querySelector("[data-tabgrid-player]");
        const r = el?.getBoundingClientRect();
        const under = document.elementsFromPoint(innerWidth / 2, innerHeight / 3).find((e) => e !== document.documentElement);
        return { marked: el?.tagName, rect: r && [r.x, r.y, r.width, r.height].map(Math.round), vw: innerWidth, vh: innerHeight, onTop: !!el && (el === under || el.contains(under)) };
      });
      const top = await site.evaluate(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight].map(Math.round); });
      check(top[0] === top[2] && top[1] === top[3], `${label}: the outer frame fills the window`, JSON.stringify(top));
      check(res.marked === "IFRAME" && res.rect[2] === res.vw && res.rect[3] === res.vh && res.onTop,
        `${label}: inside it, the real player fills the window over the header, ad and chat`, JSON.stringify(res));
      await site.screenshot({ path: path.join(os.tmpdir(), "tabgrid-frames.png") });
    } else {
      await ctl.reload(); await ctl.waitForTimeout(800);
      const line = await ctl.evaluate(() => document.querySelector("#tileList .status")?.textContent || "");
      const btn = await ctl.evaluate(() => document.querySelector("#tileList li").querySelectorAll("button")[1].textContent);
      check(btn === "Allow…" && /another site/.test(line), `${label}: popup offers Allow… and says why`, `${btn} | ${line}`);
    }
    console.log(`(${label} ran extension ${version})`);
  } finally {
    await ctx.close();
  }
}

try {
  await run("A, allowed everywhere", ["http://127.0.0.1/*", "http://localhost/*"], "on");
  await run("B, allowed on the top page only", ["http://127.0.0.1/*"], "frame-only");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
