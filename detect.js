// Finds the video player on a page whose layout Tab Grid doesn't know: the
// biggest visible <video>, or embedded player (<iframe>, <embed>, <object>),
// and marks it so css/video-only-marked.css can make it fill the window.
// Runs once in the page (chrome.scripting.executeScript), only on sites the
// user has allowed. It reads sizes and sets one attribute; it never touches
// the player itself.
//
// Must stay self-contained: Chrome serialises the function into the page.
export function markLargestPlayer() {
  const ATTR = "data-tabgrid-player";
  for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
  let best = null;
  let bestScore = 0;
  for (const el of document.querySelectorAll("video, iframe, embed, object")) {
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
  best.setAttribute(ATTR, "");
  const r = best.getBoundingClientRect();
  return { tag: best.tagName.toLowerCase(), width: Math.round(r.width), height: Math.round(r.height) };
}
