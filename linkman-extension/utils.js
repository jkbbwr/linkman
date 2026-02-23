// Helper to get settings
const getSettings = () => new Promise((resolve) => {
  chrome.storage.sync.get(['backendUrl', 'apiKey', 'extraHeaders'], resolve);
});

// Helper to build headers
function buildHeaders(settings, isJson = false) {
  const headers = {
    'Authorization': `Bearer ${settings.apiKey || ''}`
  };
  if (isJson) {
    headers['Content-Type'] = 'application/json';
  } else {
    headers['Accept'] = 'application/json';
  }
  if (settings.extraHeaders && Array.isArray(settings.extraHeaders)) {
    settings.extraHeaders.forEach(h => {
      if (h.key) {
         headers[h.key] = h.value;
      }
    });
  }
  return headers;
}

// Helper to fetch with retry
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Client error: ${res.status}`);
      }
      throw new Error(`Server returned ${res.status}`);
    }
    return res;
  } catch (error) {
    if (retries > 0) {
      console.warn(`Fetch failed. Retrying in ${backoff}ms... (${retries} left)`, error);
      await new Promise(r => setTimeout(r, backoff));
      return fetchWithRetry(url, options, retries - 1, backoff * 2);
    }
    throw error;
  }
}
