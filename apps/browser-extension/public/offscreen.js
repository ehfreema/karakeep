const mql = window.matchMedia("(prefers-color-scheme: dark)");
function notify() {
  const isDark = mql.matches;
  try {
    chrome.storage.local.set({ effectiveIsDark: isDark });
  } catch {}
  try {
    chrome.runtime.sendMessage({ type: "KARAKEEP_THEME_UPDATE", isDark });
  } catch {}
}
mql.addEventListener("change", notify);
notify();
