import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const API_URL = "http://localhost:3000";

interface Bookmark {
    id: string;
    url: string;
    title: string | null;
    ai_summary: string | null;
    tags: string[] | null;
}

const Manager = () => {
    const [query, setQuery] = useState('');
    const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
    const [loading, setLoading] = useState(false);
    const [sorting, setSorting] = useState(false);

    useEffect(() => {
        search();
    }, []);

    const search = async () => {
        setLoading(true);
        const result = await chrome.storage.local.get(['apiToken']);
        const token = result.apiToken;

        if (!token) {
            console.warn("No API token found.");
            setLoading(false);
            return;
        }

        try {
            const response = await fetch(`${API_URL}/bookmarks/search?q=${encodeURIComponent(query)}`, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                },
            });

            if (response.ok) {
                const data = await response.json();
                setBookmarks(data);
            }
        } catch (error) {
            console.error("Search error:", error);
        } finally {
            setLoading(false);
        }
    };

    const sortToFolders = async () => {
        setSorting(true);
        try {
            const result = await chrome.storage.local.get(['apiToken']);
            const token = result.apiToken;
            if (!token) return;

            // 1. Get all local folders
            const tree = await chrome.bookmarks.getTree();
            const folders: chrome.bookmarks.BookmarkTreeNode[] = [];
            
            const findFolders = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
                for (const node of nodes) {
                    if (!node.url) { // It's a folder
                        folders.push(node);
                        if (node.children) findFolders(node.children);
                    }
                }
            };
            findFolders(tree);

            const folderNames = folders.map(f => f.title).filter(t => t.length > 0);

            // 2. Get suggestions from API
            const response = await fetch(`${API_URL}/bookmarks/suggest-folders`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`,
                },
                body: JSON.stringify({
                    bookmarks,
                    folders: folderNames
                }),
            });

            if (response.ok) {
                const { suggestions } = await response.json();
                
                // 3. Apply moves
                for (const suggestion of suggestions) {
                    const bookmark = bookmarks.find(b => b.id === suggestion.bookmark_id);
                    if (!bookmark) continue;

                    const targetFolder = folders.find(f => f.title === suggestion.folder_name);
                    if (!targetFolder) continue;

                    // Find the local bookmark ID by URL (simple matching for now)
                    const localBookmarks = await chrome.bookmarks.search({ url: bookmark.url });
                    for (const lb of localBookmarks) {
                        await chrome.bookmarks.move(lb.id, { parentId: targetFolder.id });
                    }
                }
                alert("Organization complete!");
            }
        } catch (error) {
            console.error("Sort error:", error);
        } finally {
            setSorting(false);
        }
    };

    return (
        <div style={{ padding: '40px', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h1>Linkman Manager</h1>
                <button 
                    onClick={sortToFolders}
                    disabled={sorting || bookmarks.length === 0}
                    style={{ padding: '10px 20px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                >
                    {sorting ? 'Organizing...' : 'AI Sort to Folders'}
                </button>
            </div>
            
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && search()}
                    placeholder="Search bookmarks by URL, title, tags, or summary..."
                    style={{ flex: 1, padding: '12px', fontSize: '16px', borderRadius: '4px', border: '1px solid #ccc' }}
                />
                <button 
                    onClick={search}
                    style={{ padding: '12px 24px', fontSize: '16px', borderRadius: '4px', border: 'none', backgroundColor: '#007bff', color: 'white', cursor: 'pointer' }}
                >
                    {loading ? 'Searching...' : 'Search'}
                </button>
            </div>

            <div>
                {bookmarks.map((b) => (
                    <div key={b.id} style={{ marginBottom: '20px', padding: '15px', border: '1px solid #eee', borderRadius: '8px' }}>
                        <a href={b.url} target="_blank" rel="noreferrer" style={{ fontSize: '18px', fontWeight: 'bold', color: '#007bff', textDecoration: 'none' }}>
                            {b.title || b.url}
                        </a>
                        <div style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>{b.url}</div>
                        {b.ai_summary && (
                            <p style={{ marginTop: '10px', lineHeight: '1.4' }}>{b.ai_summary}</p>
                        )}
                        <div style={{ marginTop: '10px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                            {b.tags?.map((t) => (
                                <span key={t} style={{ backgroundColor: '#f0f0f0', padding: '4px 8px', borderRadius: '4px', fontSize: '12px' }}>
                                    #{t}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}
                {!loading && bookmarks.length === 0 && (
                    <p style={{ textAlign: 'center', color: '#999' }}>No bookmarks found.</p>
                )}
            </div>
        </div>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<Manager />);
