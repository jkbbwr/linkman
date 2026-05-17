import { expect, test, mock } from "bun:test";

// Mock chrome API before importing background
const mockGet = mock(() => Promise.resolve({ apiToken: "test-token" }));
global.chrome = {
  storage: {
    local: {
      get: mockGet,
      set: mock(() => Promise.resolve()),
    },
  },
  bookmarks: {
    onCreated: { addListener: mock() },
    onRemoved: { addListener: mock() },
    onChanged: { addListener: mock() },
  },
} as any;

// Mock fetch
global.fetch = mock(() => Promise.resolve({ ok: true })) as any;

import { getAuthToken, syncBookmark } from "./background";

test("getAuthToken retrieves token from storage", async () => {
  const token = await getAuthToken();
  expect(token).toBe("test-token");
  expect(mockGet).toHaveBeenCalled();
});

test("syncBookmark calls fetch with correct headers", async () => {
  const bookmark = { url: "https://example.com", title: "Example" };
  await syncBookmark(bookmark);
  
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining("/bookmarks/sync"),
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Authorization": "Bearer test-token",
      }),
    })
  );
});
