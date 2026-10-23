// Tab Grid's own player for direct video links pasted into the popup.
const v = document.getElementById("v");
const msg = document.getElementById("msg");
const src = new URLSearchParams(location.search).get("src") || "";

const say = (text) => { msg.textContent = text; msg.hidden = !text; };

try {
  const u = new URL(src);
  document.title = decodeURIComponent(u.pathname.split("/").pop() || u.hostname);
} catch {
  say("This isn't a valid video link.");
}

if (/\.m3u8(\?|#|$)/i.test(src) && !v.canPlayType("application/vnd.apple.mpegurl")) {
  say("This version of Chrome can't play .m3u8 live-stream links by itself. Open the stream's web page instead.");
} else if (src) {
  v.src = src;
  // Chrome may block sound until a click; then start muted (the controls at
  // the bottom unmute it).
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
}
v.addEventListener("error", () => say("Couldn't play this link. It may not be a direct video file, or the site may not allow it to be played elsewhere."));
v.addEventListener("playing", () => say(""));

// "Fill each tile" applies here too.
async function applyFill() {
  const { settings } = await chrome.storage.local.get("settings");
  v.classList.toggle("fill", !!settings?.fillTiles);
}
applyFill();
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.settings) applyFill(); });
