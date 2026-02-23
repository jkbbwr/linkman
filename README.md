# 🔗 Linkman

Linkman is a powerful, AI-driven bookmark management suite. It features a high-performance Rust backend and a feature-rich browser extension that seamlessly integrates with your native browser bookmarks.

## ✨ Features

- **🚀 Rust Backend**: Built with Axum and SQLx for maximum speed and reliability.
- **🧠 AI Tagging**: Automatically generates 6 relevant tags for every bookmark using OpenAI (or any compatible LLM like Ollama) based on the actual content of the page.
- **🔄 Native Sync**: 
  - **Manual Import**: Push your existing browser bookmarks to the server.
  - **Manual Sync**: Pull bookmarks from the server down to your browser.
  - **Auto-Sync (Dangerous Mode)**: Completely mirror your server state to your browser, automatically deleting local bookmarks that don't exist on the server.
- **🔍 Advanced Search**: A dedicated full-screen results page with filtering by URL, Title, Tags, and Date range.
- **🛡️ Secure Access**: Database-driven API key management with strict data isolation.
- **🐳 Docker Ready**: Full orchestration with `docker-compose` including automated database health checks and migrations.

## 🛠️ Tech Stack

- **Backend**: Rust (Axum, SQLx, Tokio, Clap CLI)
- **Database**: PostgreSQL
- **AI**: OpenAI API / gpt-4o-mini (via `async-openai`)
- **Frontend**: Vanilla JavaScript / Chrome Extension API v3

## 🚀 Getting Started

### 1. Backend Setup (Docker)

1. Clone the repository.
2. Configure your `.env` file:
   ```env
   OPENAI_URL=https://api.openai.com/v1
   OPENAI_API_KEY=your_key_here
   OPENAI_EXTRA_HEADERS=
   ```
3. Start the services:
   ```bash
   docker-compose up --build
   ```

### 2. Create your API Key

Run the following command while the app is running (or via CLI):
```bash
docker-compose run app create-api-key --description "My Browser Extension"
```
Copy the generated key!

### 3. Extension Setup

1. Open Chrome/Edge and navigate to `chrome://extensions`.
2. Enable **Developer Mode**.
3. Click **Load unpacked** and select the `linkman-extension` folder.
4. Open the extension **Settings** (⚙️ icon) and paste your Backend URL (`http://localhost:3000`) and the API Key you generated.

## ⌨️ CLI Commands

The server binary includes a built-in CLI:

- `serve`: Start the web server.
- `create-api-key`: Generate a new access token.
  - `--description <DESC>`: Label for the key.
  - `--key <KEY>`: (Optional) Specify a custom string.

## ⚠️ Auto-Sync Warning

Enabling "Automatic Sync" in the settings will **WIPE** your browser's native bookmarks to ensure they match the server exactly. Use this feature with caution.

---
Built with ❤️ for better link management.
