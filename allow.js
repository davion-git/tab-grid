import { sitePattern } from "./layout.js";

const $ = (id) => document.getElementById(id);
const tabId = Number(new URLSearchParams(location.search).get("tab"));

const tab = await chrome.tabs.get(tabId).catch(() => null);
if (!tab) {
  $("result").textContent = "That tab is gone.";
  $("result").hidden = false;
  $("allow").disabled = true;
} else {
  $("site").textContent = $("site2").textContent = new URL(tab.url).hostname;
}

const ask = async (origins) => {
  const granted = await chrome.permissions.request({ origins }).catch(() => false);
  if (!granted) {
    $("result").textContent = "Not allowed. Video only stays off for this site.";
    $("result").hidden = false;
    return;
  }
  await chrome.runtime.sendMessage({ type: "setVideoOnly", tabId, on: true });
  window.close();
};
$("allow").onclick = () => ask([sitePattern(tab.url)]);
$("allowAll").onclick = () => ask(["https://*/*", "http://*/*"]);
$("cancel").onclick = () => window.close();
