document.addEventListener('DOMContentLoaded', () => {
  const backendUrlInput = document.getElementById('backendUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const autoSyncCheckbox = document.getElementById('autoSync');
  const syncWarning = document.getElementById('syncWarning');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');
  const addHeaderBtn = document.getElementById('addHeaderBtn');
  const headersContainer = document.getElementById('headersContainer');

  function createHeaderRow(key = '', value = '') {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '10px';
    row.style.marginBottom = '10px';
    row.className = 'header-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'Header Name';
    keyInput.value = key;
    keyInput.className = 'header-key';
    keyInput.style.flex = '1';

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.placeholder = 'Header Value';
    valueInput.value = value;
    valueInput.className = 'header-value';
    valueInput.style.flex = '1';

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.style.padding = '0 10px';
    removeBtn.style.backgroundColor = '#ef4444';
    removeBtn.style.color = 'white';
    removeBtn.style.border = 'none';
    removeBtn.style.borderRadius = '4px';
    removeBtn.style.cursor = 'pointer';
    removeBtn.title = 'Remove Header';
    removeBtn.addEventListener('click', () => {
      row.remove();
    });

    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(removeBtn);
    headersContainer.appendChild(row);
  }

  addHeaderBtn.addEventListener('click', (e) => {
    e.preventDefault();
    createHeaderRow();
  });

  // Confirmation for auto-sync
  autoSyncCheckbox.addEventListener('click', (e) => {
    if (autoSyncCheckbox.checked) {
      const confirmed = confirm("Clicking yes will wipe your current bookmarks and force a sync right now. Click no to cancel");
      if (!confirmed) {
        e.preventDefault();
      } else {
        // Force a save of settings and trigger sync immediately
        const backendUrl = backendUrlInput.value.trim();
        const apiKey = apiKeyInput.value.trim();
        const autoSync = true;
        
        const extraHeaders = [];
        document.querySelectorAll('.header-row').forEach(row => {
          const key = row.querySelector('.header-key').value.trim();
          const value = row.querySelector('.header-value').value.trim();
          if (key) {
            extraHeaders.push({ key, value });
          }
        });

        chrome.storage.sync.set({ backendUrl, apiKey, autoSync, extraHeaders }, () => {
          chrome.runtime.sendMessage({ type: "SYNC_SETTINGS_CHANGED", autoSync: true });
          
          if (statusEl) {
            statusEl.textContent = 'Settings saved and sync started!';
            statusEl.style.display = 'block';
            setTimeout(() => {
              statusEl.style.display = 'none';
              statusEl.textContent = 'Settings saved successfully!';
            }, 3000);
          }
        });
      }
    }
  });

  // Load existing settings
  chrome.storage.sync.get(['backendUrl', 'apiKey', 'autoSync', 'extraHeaders'], (result) => {
    if (result.backendUrl) {
      backendUrlInput.value = result.backendUrl;
    }
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
    }
    if (result.autoSync) {
      autoSyncCheckbox.checked = result.autoSync;
    }
    
    if (result.extraHeaders && Array.isArray(result.extraHeaders)) {
      result.extraHeaders.forEach(h => createHeaderRow(h.key, h.value));
    } else if (!result.extraHeaders) {
      // Add one empty row by default if no headers exist
      createHeaderRow();
    }
  });

  const importBookmarksBtn = document.getElementById('importBookmarksBtn');
  const syncToNativeBtn = document.getElementById('syncToNativeBtn');
  const syncStatus = document.getElementById('syncStatus');

  function showSyncStatus(msg, isError = false) {
    if (syncStatus) {
      syncStatus.textContent = msg;
      syncStatus.style.color = isError ? '#dc2626' : '#059669';
      syncStatus.style.display = 'block';
      setTimeout(() => {
        syncStatus.style.display = 'none';
      }, 5000);
    }
  }

  if (importBookmarksBtn) {
    importBookmarksBtn.addEventListener('click', async () => {
      const settings = await getSettings();
      if (!settings.backendUrl) {
        showSyncStatus("Please set the backend URL first.", true);
        return;
      }

      importBookmarksBtn.disabled = true;
      importBookmarksBtn.textContent = 'Importing...';

      try {
        if (!chrome.bookmarks) {
          showSyncStatus("Bookmarks permission missing.", true);
          return;
        }

        const bookmarkTreeNodes = await chrome.bookmarks.getTree();
        const flatBookmarks = [];
        
        function traverseNodes(nodes) {
          for (let node of nodes) {
            if (node.url) {
              flatBookmarks.push({ title: node.title, url: node.url });
            }
            if (node.children) {
              traverseNodes(node.children);
            }
          }
        }
        traverseNodes(bookmarkTreeNodes);
        
        if (flatBookmarks.length === 0) {
           showSyncStatus("No native bookmarks found.");
           return;
        }
        
        let successCount = 0;
        let failCount = 0;
        const currentTags = ["imported"];

        for (let bm of flatBookmarks) {
          try {
            const res = await fetchWithRetry(new URL('/bookmarks', settings.backendUrl).toString(), {
              method: 'POST',
              headers: buildHeaders(settings, true),
              body: JSON.stringify({
                url: bm.url,
                title: bm.title,
                tags: currentTags
              })
            });
            if (res.ok) {
              successCount++;
            } else {
              failCount++;
            }
          } catch (err) {
            failCount++;
          }
        }
        
        showSyncStatus(`Imported ${successCount} bookmarks. ${failCount} failed.`);
      } catch (error) {
        console.error('Error importing bookmarks:', error);
        showSyncStatus("Failed to import bookmarks.", true);
      } finally {
        importBookmarksBtn.disabled = false;
        importBookmarksBtn.textContent = 'Import Native Bookmarks to Backend';
      }
    });
  }

  if (syncToNativeBtn) {
    syncToNativeBtn.addEventListener('click', async () => {
      const settings = await getSettings();
      if (!settings.backendUrl) {
        showSyncStatus("Please set the backend URL first.", true);
        return;
      }

      syncToNativeBtn.disabled = true;
      syncToNativeBtn.textContent = 'Syncing...';

      try {
        if (!chrome.bookmarks) {
          showSyncStatus("Bookmarks permission missing.", true);
          return;
        }

        const res = await fetchWithRetry(new URL('/bookmarks/sync', settings.backendUrl).toString(), {
          headers: buildHeaders(settings, false)
        });
        
        if (!res.ok) throw new Error('Failed to fetch bookmarks from backend');
        
        const backendBookmarks = await res.json();
        if (!backendBookmarks || backendBookmarks.length === 0) {
          showSyncStatus("No bookmarks found on backend.");
          return;
        }

        const bookmarkTreeNodes = await chrome.bookmarks.getTree();
        const nativeUrls = new Set();
        
        function traverseNodes(nodes) {
          for (let node of nodes) {
            if (node.url) {
              nativeUrls.add(node.url);
            }
            if (node.children) {
              traverseNodes(node.children);
            }
          }
        }
        traverseNodes(bookmarkTreeNodes);

        let addCount = 0;
        for (let bm of backendBookmarks) {
          if (!nativeUrls.has(bm.url)) {
            await chrome.bookmarks.create({
              title: bm.title || bm.url,
              url: bm.url
            });
            addCount++;
          }
        }

        showSyncStatus(`Synced ${addCount} new bookmarks to native.`);
      } catch (error) {
        console.error('Error syncing to native:', error);
        showSyncStatus("Failed to sync to native bookmarks.", true);
      } finally {
        syncToNativeBtn.disabled = false;
        syncToNativeBtn.textContent = 'Sync Backend to Native';
      }
    });
  }

  // Save settings
  saveBtn.addEventListener('click', () => {
    const backendUrl = backendUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const autoSync = autoSyncCheckbox.checked;

    const extraHeaders = [];
    document.querySelectorAll('.header-row').forEach(row => {
      const key = row.querySelector('.header-key').value.trim();
      const value = row.querySelector('.header-value').value.trim();
      if (key) {
        extraHeaders.push({ key, value });
      }
    });

    chrome.storage.sync.set({ backendUrl, apiKey, autoSync, extraHeaders }, () => {
      statusEl.style.display = 'block';
      setTimeout(() => {
        statusEl.style.display = 'none';
      }, 3000);
      
      // Notify background script
      chrome.runtime.sendMessage({ type: "SYNC_SETTINGS_CHANGED", autoSync });
    });
  });
});
