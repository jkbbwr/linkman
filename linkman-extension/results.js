document.addEventListener('DOMContentLoaded', async () => {
  const searchInput = document.getElementById('searchInput');
  const titleInput = document.getElementById('titleInput');
  const searchBtn = document.getElementById('searchBtn');
  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');
  const bookmarkListEl = document.getElementById('bookmarkList');

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

  // Load bookmarks
  async function loadBookmarks(params = {}) {
    const settings = await getSettings();
    if (!settings.backendUrl) {
      bookmarkListEl.innerHTML = '<div class="empty-state">Please configure your backend URL in Settings to see bookmarks.</div>';
      return;
    }

    try {
      bookmarkListEl.innerHTML = '<div class="empty-state">Loading...</div>';

      const url = new URL('/bookmarks', settings.backendUrl);
      
      if (params.q) url.searchParams.append('q', params.q);
      if (params.title) url.searchParams.append('title', params.title);
      if (params.tag) url.searchParams.append('tag', params.tag);
      if (params.startDate) url.searchParams.append('startDate', params.startDate);
      if (params.endDate) url.searchParams.append('endDate', params.endDate);

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

      const res = await fetchWithRetry(url.toString(), { headers });
      
      if (!res.ok) throw new Error('Failed to fetch bookmarks');
      
      const bookmarks = await res.json();
      
      if (bookmarks && bookmarks.length > 0) {
        bookmarkListEl.innerHTML = bookmarks.map(b => {
          const dateStr = b.created_at ? new Date(b.created_at).toLocaleDateString() : '';
          const tagsHtml = b.tags ? b.tags.map(t => `<span class="bookmark-tag">${t}</span>`).join('') : '';
          
          return `
            <li class="bookmark-item">
              <a href="${b.url}" class="bookmark-title" target="_blank" title="${b.title}">${b.title || b.url}</a>
              <a href="${b.url}" class="bookmark-url" target="_blank" title="${b.url}">${b.url}</a>
              <div class="bookmark-meta">
                <div class="bookmark-tags">${tagsHtml}</div>
                <div style="display: flex; align-items: center; gap: 15px;">
                  <span>${dateStr}</span>
                  <button class="btn-info retag-btn" data-id="${b.id}" data-url="${b.url}">Retag</button>
                  <button class="btn-danger delete-btn" data-url="${b.url}">Delete</button>
                </div>
              </div>
            </li>
          `;
        }).join('');

        // Add event listeners for retag buttons
        document.querySelectorAll('.retag-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const bookmarkId = e.target.getAttribute('data-id');
            const bookmarkUrl = e.target.getAttribute('data-url');
            
            e.target.disabled = true;
            e.target.textContent = 'Processing...';

            try {
              const settings = await getSettings();
              const reprocessUrl = new URL(`/admin/bookmarks/${bookmarkId}/reprocess`, settings.backendUrl);
              
              const res = await fetchWithRetry(reprocessUrl.toString(), {
                method: 'POST',
                headers: buildHeaders(settings)
              });
              
              if (res.ok) {
                alert(`Retagging requested for ${bookmarkUrl}. It will update in a moment.`);
              }
            } catch (err) {
              console.error('Failed to request retag:', err);
              alert('Failed to request retag. Check console for details.');
            } finally {
              e.target.disabled = false;
              e.target.textContent = 'Retag';
            }
          });
        });

        // Add event listeners for delete buttons
        document.querySelectorAll('.delete-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const bookmarkUrl = e.target.getAttribute('data-url');
            if (confirm(`Are you sure you want to delete this bookmark?\n\n${bookmarkUrl}`)) {
               try {
                  const settings = await getSettings();
                  const deleteUrl = new URL('/bookmarks', settings.backendUrl);
                  deleteUrl.searchParams.append('url', bookmarkUrl);
                  
                  const res = await fetchWithRetry(deleteUrl.toString(), {
                    method: 'DELETE',
                    headers: buildHeaders(settings)
                  });
                  
                  if (res.ok) {
                    triggerSearch(); // Refresh list
                  }
               } catch (err) {
                 console.error('Failed to delete bookmark:', err);
                 alert('Failed to delete bookmark. Check console for details.');
               }
            }
          });
        });
      } else {
        bookmarkListEl.innerHTML = '<div class="empty-state">No bookmarks found matching your criteria.</div>';
      }
    } catch (error) {
      console.error('Error fetching bookmarks:', error);
      bookmarkListEl.innerHTML = '<div class="empty-state">Unable to load bookmarks. Check connection/settings.</div>';
    }
  }

  function triggerSearch() {
    // Update URL without reloading
    const urlParams = new URLSearchParams();
    if (searchInput.value.trim()) urlParams.set('q', searchInput.value.trim());
    if (titleInput.value.trim()) urlParams.set('title', titleInput.value.trim());
    if (currentTagsList.length > 0) urlParams.set('tag', currentTagsList.join(','));
    if (startDateInput.value) urlParams.set('startDate', startDateInput.value);
    if (endDateInput.value) urlParams.set('endDate', endDateInput.value);
    
    const newUrl = window.location.pathname + '?' + urlParams.toString();
    window.history.replaceState({}, '', newUrl);

    loadBookmarks({
      q: searchInput.value.trim(),
      title: titleInput.value.trim(),
      tag: currentTagsList.join(','),
      startDate: startDateInput.value,
      endDate: endDateInput.value
    });
  }

  // Parse initial URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('q')) searchInput.value = urlParams.get('q');
  if (urlParams.has('title')) titleInput.value = urlParams.get('title');
  if (urlParams.has('startDate')) startDateInput.value = urlParams.get('startDate');
  if (urlParams.has('endDate')) endDateInput.value = urlParams.get('endDate');
  
  if (urlParams.has('tag')) {
    const tags = urlParams.get('tag').split(',').map(t => t.trim()).filter(t => t);
    tags.forEach(t => addTag(t));
  }

  searchBtn.addEventListener('click', triggerSearch);
  
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') triggerSearch();
  });
  
  titleInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') triggerSearch();
  });

  // Initial load
  triggerSearch();
});
