# Linkman

AI-assisted bookmark synchronization and organization system.

## Project Structure

- `api/`: Rust/Axum backend with PostgreSQL (SQLx) and AI integration (Rig).
- `extension/`: Chrome Manifest V3 extension built with React and Bun.

## Features

- **Multi-Device Sync**: Real-time synchronization of browser bookmarks to a private database.
- **AI Tagging**: Automatic extraction of exactly 5 semantic tags and a summary for every bookmark.
- **Semantic Search**: Deep fuzzy searching across URLs, titles, and AI-generated metadata.
- **AI-Driven Organization**: "Sort-to-Folder" feature that automatically categorizes bookmarks into your existing local folder structure using LLMs.
- **Private LLM Support**: Optimized for private deployments (like `gemma-2` or `llama3`) with configurable endpoints and thinking disabled.

## Setup

### Backend (API)

1. **Prerequisites**: PostgreSQL, Rust (stable).
2. **Configuration**: 
   - Copy `api/.env` and update `DATABASE_URL`, `OPENAI_API_KEY`, and `OPENAI_API_BASE`.
   - Set `LLM_MODEL` (defaults to `user.gemma-4-26B-A4B-it-GGUF`).
3. **Run**:
   ```bash
   cd api
   cargo run
   ```
   *Migrations run automatically on boot.*

4. **Register**:
   Generate an API token for your device:
   ```bash
   curl -X POST http://localhost:3000/admin/register \
     -H "Content-Type: application/json" \
     -d '{"username": "yourname", "device_name": "desktop"}'
   ```

### Extension

1. **Prerequisites**: [Bun](https://bun.sh/).
2. **Build**:
   ```bash
   cd extension
   bun install
   bun run build
   ```
3. **Install**:
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable "Developer mode".
   - Click "Load unpacked" and select the `extension/` directory.
4. **Configure**:
   - Open the extension **Options** and paste your API token.
   - Use the **Manager** to search and sort your bookmarks.

## Testing

- **Backend**: `cd api && cargo test`
- **Frontend**: `cd extension && bun test`

## Architecture

- **Backend**: Axum for the web server, SQLx for database interactions, and Rig for LLM abstractions.
- **Frontend**: React for the UI, Bun for bundling and testing, and native Chrome APIs for bookmark manipulation.
- **Database**: PostgreSQL with Relational Tagging.
