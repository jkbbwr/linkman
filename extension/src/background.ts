const API_URL = "http://localhost:3000";

interface Bookmark {
  url: string;
  title: string;
}

export async function getAuthToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(["apiToken"]);
  return result.apiToken || null;
}

export async function syncBookmark(bookmark: Bookmark) {
  const token = await getAuthToken();
  if (!token) {
    console.warn("No API token found, skipping sync.");
    return;
  }

  try {
    const response = await fetch(`${API_URL}/bookmarks/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(bookmark),
    });

    if (!response.ok) {
      console.error("Failed to sync bookmark:", response.statusText);
    }
  } catch (error) {
    console.error("Error syncing bookmark:", error);
  }
}

export function init() {
  chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
    if (bookmark.url) {
      await syncBookmark({
        url: bookmark.url,
        title: bookmark.title,
      });
    }
  });

  chrome.bookmarks.onRemoved.addListener(async (id, _removeInfo) => {
    console.log("Bookmark removed:", id);
  });

  chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
    if (changeInfo.url) {
      await syncBookmark({
        url: changeInfo.url,
        title: changeInfo.title || "",
      });
    }
  });
}

// Only run init if we are in a browser extension context
if (typeof chrome !== 'undefined' && chrome.bookmarks) {
  init();
}
