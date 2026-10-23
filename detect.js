// Finds the video player on a page and marks it so css/video-only-marked.css
// can make it fill the window. Used on every site except youtube.com, and
// only where Tab Grid has access (known streaming sites, or sites the user
// allowed). Runs once in the page (chrome.scripting.executeScript): it reads
// sizes and sets one attribute; it never touches the player itself.
//
// What it marks is the player's whole box: the biggest visible <video> or
// embedded player (<iframe>, <embed>, <object>), widened to the outermost
// element around it that has the same size. That box holds the site's own
// controls (play, volume), so they keep working. A video inside a player
// widget's own shadow DOM is found too; its widget is marked.
//
// Must stay self-contained: Chrome serialises the function into the page.
export function markLargestPlayer() {
  const ATTR = "data-tabgrid-player";
  for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);

  // Every video/frame, including those inside open shadow roots.
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (/^(VIDEO|IFRAME|EMBED|OBJECT)$/.test(el.tagName)) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  let best = null;
  let bestScore = 0;
  for (const el of found) {
    const r = el.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) continue; // ad pixels, tracking frames
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) continue;
    // A real <video> beats a frame of the same size.
    const score = r.width * r.height * (el.tagName === "VIDEO" ? 1.5 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return null;

  // Out of any shadow root: the widget element on the page itself.
  let box = best;
  while (box.getRootNode() instanceof ShadowRoot) box = box.getRootNode().host;
  // Widen to the outermost element with the same size and position (the
  // player box holding the video and its control overlays).
  const near = (a, b) => Math.abs(a.left - b.left) <= 4 && Math.abs(a.top - b.top) <= 4 &&
    Math.abs(a.width - b.width) <= 4 && Math.abs(a.height - b.height) <= 4;
  const target = best.getBoundingClientRect();
  while (box.parentElement && box.parentElement !== document.body && box.parentElement !== document.documentElement &&
         near(box.parentElement.getBoundingClientRect(), target)) {
    box = box.parentElement;
  }

  box.setAttribute(ATTR, "");
  const r = box.getBoundingClientRect();
  return { player: best.tagName.toLowerCase(), box: box.tagName.toLowerCase(), width: Math.round(r.width), height: Math.round(r.height) };
}
