importScripts('utils.js');

let syncIntervalId = null;

async function performAutoSync() {
  chrome.storage.sync.get(['backendUrl', 'apiKey', 'autoSync', 'extraHeaders'], async (settings) => {
    if (!settings.autoSync || !settings.backendUrl || !chrome.bookmarks) return;

    try {
      const headers = {
        'Authorization': `Bearer ${settings.apiKey || ''}`,
        'Accept': 'application/json'
      };

      if (settings.extraHeaders && Array.isArray(settings.extraHeaders)) {
        settings.extraHeaders.forEach(h => {
          if (h.key) {
             headers[h.key] = h.value;
          }
        });
      }

      // Fetch all bookmarks from backend
      const res = await fetchWithRetry(new URL('/bookmarks/sync', settings.backendUrl).toString(), { headers });
      
      if (!res.ok) throw new Error('Failed to fetch bookmarks from backend');
      
      const backendBookmarks = await res.json();
      if (!backendBookmarks) return;

      const bookmarkTreeNodes = await chrome.bookmarks.getTree();
      
      const nativeBookmarks = [];
      const nativeUrls = new Set();
      
      function traverseNodes(nodes) {
        for (let node of nodes) {
          if (node.url) {
            nativeBookmarks.push(node);
            nativeUrls.add(node.url);
          }
          if (node.children) {
            traverseNodes(node.children);
          }
        }
      }
      traverseNodes(bookmarkTreeNodes);

      // Add missing backend bookmarks to native
      for (let bm of backendBookmarks) {
        if (!nativeUrls.has(bm.url)) {
          await chrome.bookmarks.create({
            title: bm.title || bm.url,
            url: bm.url
          });
        }
      }
      
      // Delete native bookmarks that don't exist in backend (takes over completely)
      const backendUrls = new Set(backendBookmarks.map(b => b.url));
      for (let node of nativeBookmarks) {
        if (!backendUrls.has(node.url)) {
           await chrome.bookmarks.remove(node.id);
        }
      }

      console.log("Auto-sync completed.");
    } catch (err) {
      console.error("Auto-sync failed:", err);
    }
  });
}

function startSync() {
  if (syncIntervalId) clearInterval(syncIntervalId);
  // Sync every 5 minutes
  syncIntervalId = setInterval(performAutoSync, 5 * 60 * 1000);
  performAutoSync();
}

function stopSync() {
  if (syncIntervalId) clearInterval(syncIntervalId);
  syncIntervalId = null;
}

chrome.runtime.onInstalled.addListener(() => {
    console.log("linkman extension installed");
    chrome.storage.sync.get(['autoSync'], (settings) => {
        if (settings.autoSync) {
            startSync();
        }
    });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.sync.get(['autoSync'], (settings) => {
      if (settings.autoSync) {
          startSync();
      }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SYNC_SETTINGS_CHANGED") {
    if (message.autoSync) {
      startSync();
    } else {
      stopSync();
    }
  }
});

