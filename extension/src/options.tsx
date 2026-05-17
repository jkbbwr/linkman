import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const Options = () => {
    const [token, setToken] = useState('');
    const [status, setStatus] = useState('');

    useEffect(() => {
        chrome.storage.local.get(['apiToken'], (result) => {
            if (result.apiToken) {
                setToken(result.apiToken);
            }
        });
    }, []);

    const saveOptions = () => {
        chrome.storage.local.set({ apiToken: token }, () => {
            setStatus('Options saved.');
            setTimeout(() => setStatus(''), 2000);
        });
    };

    return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
            <h1>Linkman Settings</h1>
            <div style={{ marginBottom: '10px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>
                    API Token:
                </label>
                <input
                    type="text"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    style={{ width: '300px', padding: '8px' }}
                />
            </div>
            <button onClick={saveOptions} style={{ padding: '8px 16px', cursor: 'pointer' }}>
                Save
            </button>
            <div style={{ marginTop: '10px', color: 'green' }}>{status}</div>
        </div>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<Options />);
