import {
  BookmarkTypes,
  ZNewBookmarkRequest,
} from "@karakeep/shared/types/bookmarks";

import { clearBadgeStatus, getBadgeStatus } from "../utils/badgeCache";
import {
  getPluginSettings,
  Settings,
  subscribeToSettingsChanges,
} from "../utils/settings";
import { getApiClient, initializeClients } from "../utils/trpc";
import { MessageType } from "../utils/type";
import { isHttpUrl } from "../utils/url";
import { NEW_BOOKMARK_REQUEST_KEY_NAME } from "./protocol";

const OPEN_KARAKEEP_ID = "open-karakeep";
const ADD_LINK_TO_KARAKEEP_ID = "add-link";
const CLEAR_CURRENT_CACHE_ID = "clear-current-cache";
const CLEAR_ALL_CACHE_ID = "clear-all-cache";
const SEPARATOR_ID = "separator-1";
const VIEW_PAGE_IN_KARAKEEP = "view-page-in-karakeep";

function getIconSuffix(isDark: boolean): string {
  return isDark ? "-darkmode.png" : ".png";
}

async function getSystemIsDark(): Promise<boolean> {
  // 1. Service worker matchMedia (works in some browsers)
  try {
    if (typeof self !== "undefined" && "matchMedia" in self) {
      return (self as unknown as Window).matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
    }
    if (typeof matchMedia !== "undefined") {
      return matchMedia("(prefers-color-scheme: dark)").matches;
    }
  } catch {
    // ignore
  }
  // 2. Query active tab's matchMedia (reflects OS theme, works even when popup closed)
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.matchMedia("(prefers-color-scheme: dark)").matches,
      });
      if (results?.[0]?.result !== undefined) {
        return results[0].result as boolean;
      }
    }
  } catch {
    // likely missing host permission or no tab — fall through
  }
  // 3. Last effective theme stored by ThemeProvider (popup)
  try {
    const stored = await chrome.storage.local.get("effectiveIsDark");
    if (typeof stored.effectiveIsDark === "boolean") {
      return stored.effectiveIsDark;
    }
  } catch {
    // ignore
  }
  return false;
}

async function resolveIsDark(settings: Settings): Promise<boolean> {
  if (settings.theme === "dark") return true;
  if (settings.theme === "light") return false;
  return await getSystemIsDark();
}

async function ensureOffscreenForSystemTheme(
  settings: Settings,
): Promise<void> {
  // Offscreen document gives us a reliable window.matchMedia even when popup is closed.
  // Only needed for `system` theme and only on Chrome (Firefox has no offscreen API but also has window in background).
  if (settings.theme !== "system") return;
  try {
    const offscreen = (
      chrome as unknown as {
        offscreen?: {
          hasDocument?: () => Promise<boolean>;
          createDocument?: (opts: unknown) => Promise<void>;
        };
      }
    ).offscreen;
    if (!offscreen?.hasDocument || !offscreen?.createDocument) return;
    const hasDoc = await offscreen.hasDocument();
    if (!hasDoc) {
      await offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["MATCH_MEDIA" as unknown as string],
        justification:
          "Keep extension and context-menu icons in sync with browser theme",
      });
    }
  } catch (e) {
    console.warn("Failed to ensure offscreen document:", e);
  }
}

async function updateActionIcon(settings: Settings): Promise<boolean> {
  const isDark = await resolveIsDark(settings);
  const suffix = getIconSuffix(isDark);
  const iconPaths = {
    "16": `logo-16${suffix}`,
    "48": `logo-48${suffix}`,
    "128": `logo-128${suffix}`,
  };
  try {
    await chrome.action.setIcon({ path: iconPaths });
  } catch (e) {
    console.warn("Failed to set action icon:", e);
  }
  // Persist for other contexts and for getSystemIsDark fallback
  try {
    await chrome.storage.local.set({ effectiveIsDark: isDark });
  } catch {
    // ignore
  }
  return isDark;
}

/**
 * Check the current settings state and register or remove context menus accordingly.
 * @param settings The current plugin settings.
 */
async function checkSettingsState(settings: Settings) {
  await initializeClients();
  await ensureOffscreenForSystemTheme(settings);
  await updateActionIcon(settings);
  if (settings?.address && settings?.apiKey) {
    await registerContextMenus(settings);
  } else {
    removeContextMenus();
    await clearAllCache();
  }
}

/**
 * Remove context menus from the browser.
 */
function removeContextMenus() {
  try {
    chrome.contextMenus.removeAll();
  } catch (error) {
    console.error("Failed to remove context menus:", error);
  }
}

/**
 * Register context menus in the browser.
 * * A context menu button to open a tab with the currently configured karakeep instance.
 * * * If the "show count badge" setting is enabled, add context menu buttons to clear the cache for the current page or all pages.
 * * A context menu button to add a link to karakeep without loading the page.
 * @param settings The current plugin settings.
 * @param overrideIsDark Optional explicit dark-mode flag (from ThemeProvider's resolved theme).
 *   When provided, it is used instead of recomputing from settings, ensuring the right-click
 *   menu icon inverts exactly like the toolbar's theme_icons logic.
 */
function isFirefoxEnvironment(): boolean {
  try {
    // Firefox exposes `browser` global; Chrome does not. Also check UA as fallback.
    if (
      typeof (globalThis as unknown as { browser?: unknown }).browser !==
      "undefined"
    ) {
      return true;
    }
    if (
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Firefox")
    ) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function createContextMenu(
  props: chrome.contextMenus.CreateProperties,
  menuIcons?: Record<string, string>,
) {
  const finalProps: chrome.contextMenus.CreateProperties & {
    icons?: Record<string, string>;
  } = { ...props };
  // Only Firefox supports `icons` — passing it on Chrome makes create fail and wipes the menu.
  if (menuIcons && isFirefoxEnvironment()) {
    finalProps.icons = menuIcons;
  }
  try {
    chrome.contextMenus.create(
      finalProps as chrome.contextMenus.CreateProperties,
      () => {
        if (chrome.runtime.lastError) {
          // Fallback: retry without icons if Firefox-specific prop caused error
          console.warn(
            "contextMenus.create failed, retrying without icons:",
            chrome.runtime.lastError.message,
          );
          const { icons: _omit, ...withoutIcons } = finalProps;
          chrome.contextMenus.create(
            withoutIcons as chrome.contextMenus.CreateProperties,
          );
        }
      },
    );
  } catch (e) {
    console.warn("contextMenus.create threw, retrying without icons:", e);
    const { icons: _omit, ...withoutIcons } = finalProps;
    chrome.contextMenus.create(
      withoutIcons as chrome.contextMenus.CreateProperties,
    );
  }
}

async function registerContextMenus(
  settings: Settings,
  overrideIsDark?: boolean,
) {
  removeContextMenus();
  const isDark = overrideIsDark ?? (await resolveIsDark(settings));
  const suffix = getIconSuffix(isDark);
  // Firefox supports `icons` for contextMenus (Chrome fails if present). Provide theme-aware
  // icons only there so the menu icon stays visible on dark backgrounds, mirroring toolbar theme_icons.
  const menuIcons: Record<string, string> | undefined = isFirefoxEnvironment()
    ? {
        "16": `logo-16${suffix}`,
        "48": `logo-48${suffix}`,
      }
    : undefined;

  createContextMenu(
    {
      id: OPEN_KARAKEEP_ID,
      title: "Open Karakeep",
      contexts: ["action"],
    },
    menuIcons,
  );

  createContextMenu(
    {
      id: ADD_LINK_TO_KARAKEEP_ID,
      title: "Add to Karakeep",
      contexts: ["link", "page", "selection", "image"],
    },
    menuIcons,
  );

  if (settings?.showCountBadge) {
    createContextMenu(
      {
        id: VIEW_PAGE_IN_KARAKEEP,
        title: "View this page in Karakeep",
        contexts: ["action", "page"],
      },
      menuIcons,
    );
    if (settings?.useBadgeCache) {
      // Add separator
      createContextMenu({
        id: SEPARATOR_ID,
        type: "separator",
        contexts: ["action"],
      });

      createContextMenu(
        {
          id: CLEAR_CURRENT_CACHE_ID,
          title: "Clear Current Page Cache",
          contexts: ["action"],
        },
        menuIcons,
      );

      createContextMenu(
        {
          id: CLEAR_ALL_CACHE_ID,
          title: "Clear All Cache",
          contexts: ["action"],
        },
        menuIcons,
      );
    }
  }
}

/**
 * Handle context menu clicks by opening a new tab with karakeep or adding a link to karakeep.
 * @param info Information about the context menu click event.
 * @param tab The current tab.
 */
async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
) {
  const { menuItemId, selectionText, srcUrl, linkUrl, pageUrl } = info;
  if (menuItemId === OPEN_KARAKEEP_ID) {
    getPluginSettings().then((settings: Settings) => {
      chrome.tabs.create({ url: settings.address, active: true });
    });
  } else if (menuItemId === CLEAR_CURRENT_CACHE_ID) {
    await clearCurrentPageCache();
  } else if (menuItemId === CLEAR_ALL_CACHE_ID) {
    await clearAllCache();
  } else if (menuItemId === ADD_LINK_TO_KARAKEEP_ID) {
    // Only pass the current page title when the URL being saved is the
    // page itself. When saving a link or image, the title would
    // incorrectly be the current page's title instead of the target's.
    const isCurrentPage = !srcUrl && !linkUrl;
    addLinkToKarakeep({
      selectionText,
      srcUrl,
      linkUrl,
      pageUrl,
      title: isCurrentPage ? tab?.title : undefined,
    });

    // NOTE: Firefox only allows opening context menus if it's triggered by a user action.
    // awaiting on any promise before calling this function will lose the "user action" context.
    await chrome.action.openPopup();
  } else if (menuItemId === VIEW_PAGE_IN_KARAKEEP) {
    if (tab) {
      await searchCurrentUrl(tab.url);
    }
  }
}

/**
 * Add a link to karakeep based on the provided information.
 * @param options An object containing information about the link to add.
 */
function addLinkToKarakeep({
  selectionText,
  srcUrl,
  linkUrl,
  pageUrl,
  title,
}: {
  selectionText?: string;
  srcUrl?: string;
  linkUrl?: string;
  pageUrl?: string;
  title?: string;
}) {
  let newBookmark: ZNewBookmarkRequest | null = null;
  if (selectionText) {
    newBookmark = {
      type: BookmarkTypes.TEXT,
      text: selectionText,
      sourceUrl: pageUrl,
      source: "extension",
    };
  } else {
    const finalUrl = srcUrl ?? linkUrl ?? pageUrl;

    if (finalUrl && isHttpUrl(finalUrl)) {
      newBookmark = {
        type: BookmarkTypes.LINK,
        url: finalUrl,
        source: "extension",
        title,
      };
    } else {
      console.warn("Invalid URL, bookmark not created:", finalUrl);
    }
  }
  if (newBookmark) {
    chrome.storage.session.set({
      [NEW_BOOKMARK_REQUEST_KEY_NAME]: newBookmark,
    });
  }
}

/**
 * Search current URL and open appropriate page.
 */
async function searchCurrentUrl(tabUrl?: string) {
  try {
    if (!tabUrl || !isHttpUrl(tabUrl)) {
      console.warn("Invalid URL, cannot search:", tabUrl);
      return;
    }
    console.log("Searching bookmarks for URL:", tabUrl);

    const settings = await getPluginSettings();
    const serverAddress = settings.address;

    const matchedBookmarkId = await getBadgeStatus(tabUrl);
    let targetUrl: string;
    if (matchedBookmarkId) {
      // Found exact match, open bookmark details page
      targetUrl = `${serverAddress}/dashboard/preview/${matchedBookmarkId}`;
      console.log("Opening bookmark details page:", targetUrl);
    } else {
      // No exact match, open search results page
      const searchQuery = encodeURIComponent(`url:${tabUrl}`);
      targetUrl = `${serverAddress}/dashboard/search?q=${searchQuery}`;
      console.log("Opening search results page:", targetUrl);
    }
    await chrome.tabs.create({ url: targetUrl, active: true });
  } catch (error) {
    console.error("Failed to search current URL:", error);
  }
}

/**
 * Clear badge cache for the current active page.
 */
async function clearCurrentPageCache() {
  try {
    // Get the active tab
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (activeTab.url && activeTab.id) {
      console.log("Clearing cache for current page:", activeTab.url);
      await clearBadgeStatus(activeTab.url);

      // Refresh the badge for the current tab
      await checkAndUpdateIcon(activeTab.id);
    }
  } catch (error) {
    console.error("Failed to clear current page cache:", error);
  }
}

/**
 * Clear all badge cache and refresh badges for all active tabs.
 */
async function clearAllCache() {
  try {
    console.log("Clearing all badge cache");
    await clearBadgeStatus();
  } catch (error) {
    console.error("Failed to clear all cache:", error);
  }
}

let lastResolvedIsDark: boolean | null = null;

async function maybeUpdateSystemTheme(): Promise<void> {
  try {
    const settings = await getPluginSettings();
    if (settings.theme !== "system") return;
    const currentIsDark = await getSystemIsDark();
    if (lastResolvedIsDark !== null && currentIsDark === lastResolvedIsDark)
      return;
    lastResolvedIsDark = currentIsDark;
    await updateActionIcon(settings);
    await registerContextMenus(settings, currentIsDark);
  } catch (e) {
    console.warn("maybeUpdateSystemTheme failed:", e);
  }
}

getPluginSettings().then(async (settings: Settings) => {
  await checkSettingsState(settings);
  // Initialize lastResolvedIsDark for system polling
  try {
    lastResolvedIsDark = await resolveIsDark(settings);
  } catch {
    // ignore
  }
});

subscribeToSettingsChanges(async (settings) => {
  await checkSettingsState(settings);
  try {
    lastResolvedIsDark = await resolveIsDark(settings);
  } catch {
    // ignore
  }
});

// Poll for OS theme changes when popup is closed (manifest theme_icons handles toolbar,
// but Firefox page-menu `icons` need explicit update; Chrome menu follows action icon
// which we now also keep explicit for consistency).
setInterval(() => {
  void maybeUpdateSystemTheme();
}, 2000);

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- Manifest V3 allows async functions for all callbacks
chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

/**
 * Handle command events, such as adding a link to karakeep.
 * @param command The command to handle.
 * @param tab The current tab.
 */
function handleCommand(command: string, tab: chrome.tabs.Tab) {
  if (command === ADD_LINK_TO_KARAKEEP_ID) {
    addLinkToKarakeep({
      selectionText: undefined,
      srcUrl: undefined,
      linkUrl: undefined,
      pageUrl: tab?.url,
    });

    // now try to open the popup
    chrome.action.openPopup();
  } else {
    console.warn(`Received unknown command: ${command}`);
  }
}

chrome.commands.onCommand.addListener(handleCommand);

/**
 * Set the badge text and color based on the provided information.
 * @param badgeStatus
 * @param tabId The ID of the tab to update.
 */
export async function setBadge(badgeStatus: string | null, tabId?: number) {
  if (!tabId) return;

  if (badgeStatus) {
    return await Promise.all([
      chrome.action.setBadgeText({ tabId, text: ` ` }),
      chrome.action.setBadgeBackgroundColor({
        tabId,
        color: "#4CAF50",
      }),
    ]);
  } else {
    await chrome.action.setBadgeText({ tabId, text: `` });
  }
}

/**
 * Check and update the badge icon for a given tab ID.
 * @param tabId The ID of the tab to update.
 */
async function checkAndUpdateIcon(tabId: number) {
  const tabInfo = await chrome.tabs.get(tabId);
  const { showCountBadge } = await getPluginSettings();
  const api = await getApiClient();
  if (
    !api ||
    !showCountBadge ||
    !tabInfo.url ||
    !isHttpUrl(tabInfo.url) ||
    tabInfo.status !== "complete"
  ) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  console.log("Tab activated", tabId, tabInfo);

  try {
    const status = await getBadgeStatus(tabInfo.url);
    await setBadge(status, tabId);
  } catch (error) {
    console.error("Archive check failed:", error);
    await setBadge(null, tabId);
  }
}

chrome.tabs.onActivated.addListener(async (tabActiveInfo) => {
  await checkAndUpdateIcon(tabActiveInfo.tabId);
  void maybeUpdateSystemTheme();
});

chrome.tabs.onUpdated.addListener(async (tabId) => {
  await checkAndUpdateIcon(tabId);
  void maybeUpdateSystemTheme();
});

// Firefox: update menu just before it shows, so OS theme change is reflected immediately
// even if popup has been closed and polling hasn't fired yet.
try {
  const menusApi = (
    globalThis as unknown as {
      browser?: {
        menus?: { onShown?: { addListener: (cb: () => void) => void } };
        contextMenus?: { onShown?: { addListener: (cb: () => void) => void } };
      };
    }
  ).browser;
  const onShown =
    menusApi?.menus?.onShown ??
    (
      chrome.contextMenus as unknown as {
        onShown?: { addListener: (cb: () => void) => void };
      }
    ).onShown;
  if (onShown) {
    onShown.addListener(() => {
      void maybeUpdateSystemTheme();
    });
  }
} catch {
  // ignore — onShown not available in Chrome
}

// Listen for messages from popup (badge refresh + theme updates)
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg && msg.type) {
    if (
      msg.type === "KARAKEEP_THEME_UPDATE" &&
      typeof msg.isDark === "boolean"
    ) {
      // ThemeProvider resolved the effective theme (including system). Mirror it to
      // action icon and context menus so the right-click menu icon inverts like the toolbar's theme_icons.
      const isDark: boolean = msg.isDark;
      lastResolvedIsDark = isDark;
      try {
        await chrome.storage.local.set({ effectiveIsDark: isDark });
      } catch {
        // ignore
      }
      const suffix = getIconSuffix(isDark);
      const iconPaths = {
        "16": `logo-16${suffix}`,
        "48": `logo-48${suffix}`,
        "128": `logo-128${suffix}`,
      };
      try {
        await chrome.action.setIcon({ path: iconPaths });
      } catch (e) {
        console.warn("Failed to set action icon from theme update:", e);
      }
      try {
        const settings = await getPluginSettings();
        if (settings?.address && settings?.apiKey) {
          await registerContextMenus(settings, isDark);
        }
      } catch (e) {
        console.warn("Failed to update context menus from theme update:", e);
      }
      return;
    }
    if (msg.currentTab && msg.type === MessageType.BOOKMARK_REFRESH_BADGE) {
      console.log(
        "Received REFRESH_BADGE message for tab:",
        msg.currentTab.url,
      );
      if (msg.currentTab.url) {
        await clearBadgeStatus(msg.currentTab.url);
      }
      if (typeof msg.currentTab.id === "number") {
        await checkAndUpdateIcon(msg.currentTab.id);
      }
    }
  }
});
