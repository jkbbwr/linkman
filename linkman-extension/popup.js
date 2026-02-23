document.addEventListener('DOMContentLoaded', async () => {
  const saveLinkBtn = document.getElementById('saveLinkBtn');
  const deleteLinkBtn = document.getElementById('deleteLinkBtn');
  const currentTabTitleEl = document.getElementById('currentTabTitle');
  const statusMsgEl = document.getElementById('statusMsg');
  const openSettingsBtn = document.getElementById('openSettings');
  const bookmarkListEl = document.getElementById('bookmarkList');

  // Search Elements
  const searchInput = document.getElementById('searchInput');
  const tagInput = document.getElementById('tagInput');
  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');
  const searchBtn = document.getElementById('searchBtn');
  const toggleAdvancedBtn = document.getElementById('toggleAdvanced');
  const advancedSearchDiv = document.getElementById('advancedSearch');

  // Toggle advanced search visibility
  toggleAdvancedBtn.addEventListener('click', () => {
    if (advancedSearchDiv.style.display === 'block') {
      advancedSearchDiv.style.display = 'none';
      toggleAdvancedBtn.textContent = 'Show Advanced Search';
    } else {
      advancedSearchDiv.style.display = 'block';
      toggleAdvancedBtn.textContent = 'Hide Advanced Search';
    }
  });

  // Tag Input Logic
  const tagContainer = document.getElementById('tagContainer');
  const tagChips = document.getElementById('tagChips');
  const tagInputField = document.getElementById('tagInputField');
  let currentTagsList = [];

  function renderTags() {
    tagChips.innerHTML = '';
    currentTagsList.forEach((tag, index) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.innerHTML = `<span>${tag}</span><span class="tag-chip-remove" data-index="${index}">&times;</span>`;
      tagChips.appendChild(chip);
    });
    tagInput.value = currentTagsList.join(',');
    
    document.querySelectorAll('.tag-chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.getAttribute('data-index'), 10);
        currentTagsList.splice(idx, 1);
        renderTags();
      });
    });
  }

  function addTag(val) {
    const cleaned = val.trim().toLowerCase();
    if (cleaned && !currentTagsList.includes(cleaned)) {
      currentTagsList.push(cleaned);
      renderTags();
    }
  }

  tagInputField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInputField.value);
      tagInputField.value = '';
    } else if (e.key === 'Backspace' && tagInputField.value === '' && currentTagsList.length > 0) {
      currentTagsList.pop();
      renderTags();
    }
  });

  tagContainer.addEventListener('click', () => {
    tagInputField.focus();
    tagContainer.classList.add('focused');
  });
  
  tagInputField.addEventListener('blur', () => {
    tagContainer.classList.remove('focused');
    if (tagInputField.value.trim()) {
      addTag(tagInputField.value);
      tagInputField.value = '';
    }
  });

  // Open Options page
  openSettingsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });

  function showStatus(msg, isError = false) {
    statusMsgEl.textContent = msg;
    statusMsgEl.className = `status-msg ${isError ? 'error' : 'success'}`;
    statusMsgEl.style.display = 'block';
    setTimeout(() => {
      statusMsgEl.style.display = 'none';
    }, 3000);
  }

  // Get current tab info
  let currentTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentTab = tab;
      currentTabTitleEl.textContent = tab.title || tab.url;
      
      // Check if already bookmarked
      const settings = await getSettings();
      if (settings.backendUrl) {
        try {
          const checkUrl = new URL('/bookmarks', settings.backendUrl);
          checkUrl.searchParams.append('q', currentTab.url);
          
          const res = await fetchWithRetry(checkUrl.toString(), {
            headers: buildHeaders(settings)
          });
          
          if (res.ok) {
            const bookmarks = await res.json();
            const existing = bookmarks.find(b => b.url === currentTab.url);
            if (existing) {
              saveLinkBtn.textContent = 'Update Current Page';
              deleteLinkBtn.style.display = 'block';
              
              if (existing.tags && existing.tags.length > 0) {
                 existing.tags.forEach(t => {
                   if (!currentTagsList.includes(t)) {
                     currentTagsList.push(t);
                   }
                 });
                 renderTags();
              }
            }
          }
        } catch (err) {
          console.error("Failed to check existing bookmark", err);
        }
      }
    }
  } catch (err) {
    currentTabTitleEl.textContent = "Unable to get tab info.";
  }

  // Trigger search when the button is clicked
  searchBtn.addEventListener('click', () => {
    const urlParams = new URLSearchParams();
    if (searchInput.value.trim()) urlParams.set('q', searchInput.value.trim());
    if (currentTagsList.length > 0) urlParams.set('tag', currentTagsList.join(','));
    if (startDateInput.value) urlParams.set('startDate', startDateInput.value);
    if (endDateInput.value) urlParams.set('endDate', endDateInput.value);

    chrome.tabs.create({
      url: chrome.runtime.getURL('results.html?' + urlParams.toString())
    });
  });

  // Allow pressing Enter in the main search inputs to trigger search
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        searchBtn.click();
      }
    });
  
  // Save current tab
  saveLinkBtn.addEventListener('click', async () => {
    if (!currentTab) {
      showStatus("No tab selected.", true);
      return;
    }

    const settings = await getSettings();
    if (!settings.backendUrl) {
      showStatus("Please set the backend URL in Settings first.", true);
      return;
    }

    saveLinkBtn.disabled = true;
    saveLinkBtn.textContent = 'Saving...';

    // Extract tags from tagInput if they exist when saving, or just leave empty
    // Alternatively, you could add a dedicated tag input to the save area
    const currentTags = tagInput.value.split(',').map(t => t.trim()).filter(t => t.length > 0);

    try {
      const res = await fetchWithRetry(new URL('/bookmarks', settings.backendUrl).toString(), {
        method: 'POST',
        headers: buildHeaders(settings, true),
        body: JSON.stringify({
          url: currentTab.url,
          title: currentTab.title,
          tags: currentTags // Optional: send the currently typed tags with the new bookmark
        })
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      showStatus("Bookmark saved!");
      saveLinkBtn.textContent = 'Update Current Page';
      deleteLinkBtn.style.display = 'block';
      
    } catch (error) {
      console.error('Error saving bookmark:', error);
      showStatus("Failed to save bookmark.", true);
      saveLinkBtn.textContent = 'Save Current Page';
    } finally {
      saveLinkBtn.disabled = false;
    }
  });

  // Delete current tab
  deleteLinkBtn.addEventListener('click', async () => {
    if (!currentTab) return;

    if (!confirm("Are you sure you want to delete this bookmark?")) {
      return;
    }

    const settings = await getSettings();
    if (!settings.backendUrl) return;

    deleteLinkBtn.disabled = true;
    deleteLinkBtn.textContent = 'Deleting...';

    try {
      const deleteUrl = new URL('/bookmarks', settings.backendUrl);
      deleteUrl.searchParams.append('url', currentTab.url);
      
      const res = await fetchWithRetry(deleteUrl.toString(), {
        method: 'DELETE',
        headers: buildHeaders(settings)
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      showStatus("Bookmark deleted!");
      saveLinkBtn.textContent = 'Save Current Page';
      deleteLinkBtn.style.display = 'none';
      
      currentTagsList = [];
      renderTags();
    } catch (error) {
      console.error('Error deleting bookmark:', error);
      showStatus("Failed to delete bookmark.", true);
    } finally {
      deleteLinkBtn.disabled = false;
      deleteLinkBtn.textContent = 'Delete';
    }
  });
});
