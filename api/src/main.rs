use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, post},
    Extension, Json, Router,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use rig::providers::openai;
use schemars::JsonSchema;
use std::sync::Arc;
use dotenvy::dotenv;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use scraper::{Html, Selector};
use serde_json::{json, Value};

#[derive(Clone)]
struct AppState {
    db: PgPool,
    openai: Arc<openai::Client>,
    model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct CurrentUser {
    id: Uuid,
    username: String,
}

#[tokio::main]
async fn main() {
    dotenv().ok();

    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set in .env");
    
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("Failed to connect to Postgres");

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run database migrations");

    let openai_api_key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY must be set");
    let openai_api_base = std::env::var("OPENAI_API_BASE").unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
    let model = std::env::var("LLM_MODEL").unwrap_or_else(|_| "user.gemma-4-26B-A4B-it-GGUF".to_string());

    // Initialize Rig OpenAI client using builder
    let openai_client = openai::Client::builder()
        .api_key(&openai_api_key)
        .base_url(&openai_api_base)
        .build()
        .expect("Failed to create OpenAI client");

    let state = AppState {
        db: pool,
        openai: Arc::new(openai_client),
        model,
    };

    let app = app(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

fn app(state: AppState) -> Router {
    // Protected routes
    let api_routes = Router::new()
        .route("/bookmarks/sync", post(sync_bookmark))
        .route("/bookmarks/search", get(search_bookmarks))
        .route("/bookmarks/suggest-folders", post(suggest_folders))
        .route("/bookmarks/:id", delete(delete_bookmark))
        .route("/health", get(health_check))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

    // Public routes (Admin for token generation)
    Router::new()
        .route("/", get(hello))
        .route("/admin/register", post(register_user))
        .merge(api_routes)
        .with_state(state)
}

async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req.headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok());

    let token_str = if let Some(auth_header) = auth_header {
        if auth_header.starts_with("Bearer ") {
            &auth_header[7..]
        } else {
            return Err(StatusCode::UNAUTHORIZED);
        }
    } else {
        return Err(StatusCode::UNAUTHORIZED);
    };

    let token_uuid = Uuid::parse_str(token_str).map_err(|_| StatusCode::UNAUTHORIZED)?;

    let user = sqlx::query_as::<_, CurrentUser>(
        "SELECT u.id, u.username FROM users u JOIN api_tokens t ON u.id = t.user_id WHERE t.token = $1"
    )
    .bind(token_uuid)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        eprintln!("Auth DB Error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?
    .ok_or(StatusCode::UNAUTHORIZED)?;

    req.extensions_mut().insert(user);
    Ok(next.run(req).await)
}

async fn hello() -> &'static str {
    "Linkman API"
}

#[derive(Deserialize)]
struct RegisterRequest {
    username: String,
    device_name: String,
}

#[derive(Serialize)]
struct RegisterResponse {
    token: Uuid,
}

async fn register_user(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> Result<Json<RegisterResponse>, StatusCode> {
    let mut tx = state.db.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (username) VALUES ($1) ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username RETURNING id"
    )
    .bind(&payload.username)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        eprintln!("Register User Error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO api_tokens (user_id, device_name) VALUES ($1, $2) RETURNING token"
    )
    .bind(user_id)
    .bind(&payload.device_name)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        eprintln!("Register Token Error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(RegisterResponse { token }))
}

#[derive(Deserialize)]
struct SyncBookmarkRequest {
    url: String,
    title: Option<String>,
}

async fn sync_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<SyncBookmarkRequest>,
) -> Result<StatusCode, StatusCode> {
    let bookmark_id: Uuid = sqlx::query_scalar(
        "INSERT INTO bookmarks (user_id, url, title) VALUES ($1, $2, $3) 
         ON CONFLICT (user_id, url) DO UPDATE SET title = EXCLUDED.title, updated_at = now() 
         RETURNING id"
    )
    .bind(user.id)
    .bind(&payload.url)
    .bind(&payload.title)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        eprintln!("Sync Bookmark Error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // Trigger Phase 2 (Async AI enrichment)
    let url = payload.url.clone();
    let user_id = user.id;
    tokio::spawn(async move {
        if let Err(e) = process_bookmark(state, user_id, bookmark_id, url).await {
            eprintln!("Error processing bookmark {}: {}", bookmark_id, e);
        }
    });
    
    Ok(StatusCode::OK)
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct AiEnrichmentResponse {
    summary: String,
    tags: Vec<String>,
}

fn scrape_metadata(html_content: &str) -> Value {
    let document = Html::parse_document(html_content);
    let mut site_meta = json!({
        "scraped_at": chrono::Utc::now().to_rfc3339()
    });
    
    // Scrape <title>
    let title_selector = Selector::parse("title").unwrap();
    if let Some(title_elem) = document.select(&title_selector).next() {
        let title = title_elem.text().collect::<Vec<_>>().join(" ");
        site_meta["title"] = json!(title.chars().take(300).collect::<String>());
    }

    // Scrape only essential meta tags to avoid flooding context
    let meta_selector = Selector::parse("meta").unwrap();
    let important_names = ["description", "keywords", "og:title", "og:description", "og:site_name", "twitter:title", "twitter:description"];
    
    for element in document.select(&meta_selector) {
        let name = element.value().attr("name").or_else(|| element.value().attr("property"));
        let content = element.value().attr("content");
        
        if let (Some(n), Some(c)) = (name, content) {
            if important_names.contains(&n) {
                // Truncate long content to 1500 chars to save context
                let truncated = c.chars().take(1500).collect::<String>();
                site_meta[n] = json!(truncated);
            }
        }
    }
    site_meta
}

async fn process_bookmark(state: AppState, user_id: Uuid, bookmark_id: Uuid, url: String) -> anyhow::Result<()> {
    // 1. Fetch and Scrape
    let client = reqwest::Client::new();
    let res = client.get(&url).send().await?.text().await?;
    
    // Perform scraping in a scope to ensure non-Send types are dropped
    let site_meta = scrape_metadata(&res);

    // 2. AI Enrichment using Rig
    let extractor = state.openai
        .extractor::<AiEnrichmentResponse>(&state.model)
        .preamble("You are a semantic analysis agent. Your sole task is to extract exactly 5 descriptive tags from the provided input by identifying its core domains, specific technologies, and intent.\n\nRules:\n\nOutput exactly 5 tags.\n\nOrder them from most specific/relevant to most general.\n\nNormalize tags to lowercase with hyphens for spaces.\n\nExtract only what is explicitly stated or strongly implied.")
        .additional_params(json!({ "enable_thinking": false }))
        .build();

    let ai_data = extractor.extract(&site_meta.to_string()).await.map_err(|e| anyhow::anyhow!("Rig extraction error: {}", e))?;

    // 3. Update Database
    let mut tx = state.db.begin().await?;

    sqlx::query(
        "UPDATE bookmarks SET site_meta = $1, ai_summary = $2 WHERE id = $3"
    )
    .bind(&site_meta)
    .bind(&ai_data.summary)
    .bind(bookmark_id)
    .execute(&mut *tx)
    .await?;

    for tag_name in ai_data.tags {
        let tag_id: Uuid = sqlx::query_scalar(
            "INSERT INTO tags (user_id, name) VALUES ($1, $2) 
             ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name 
             RETURNING id"
        )
        .bind(user_id)
        .bind(&tag_name)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES ($1, $2) 
             ON CONFLICT DO NOTHING"
        )
        .bind(bookmark_id)
        .bind(tag_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(())
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
}

#[derive(Serialize, Deserialize, sqlx::FromRow, JsonSchema)]
struct BookmarkResponse {
    id: Uuid,
    url: String,
    title: Option<String>,
    ai_summary: Option<String>,
    tags: Option<Vec<String>>,
}

async fn search_bookmarks(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Vec<BookmarkResponse>>, StatusCode> {
    let q = params.q.unwrap_or_default();
    let q = format!("%{}%", q);

    let bookmarks = sqlx::query_as::<_, BookmarkResponse>(
        "SELECT b.id, b.url, b.title, b.ai_summary, 
         array_agg(t.name) FILTER (WHERE t.name IS NOT NULL) as tags
         FROM bookmarks b
         LEFT JOIN bookmark_tags bt ON b.id = bt.bookmark_id
         LEFT JOIN tags t ON bt.tag_id = t.id
         WHERE b.user_id = $1 AND (b.url ILIKE $2 OR b.title ILIKE $2 OR b.ai_summary ILIKE $2 OR t.name ILIKE $2)
         GROUP BY b.id"
    )
    .bind(user.id)
    .bind(q)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        eprintln!("Search Bookmarks Error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(bookmarks))
}

#[derive(Deserialize)]
struct SuggestFoldersRequest {
    bookmarks: Vec<BookmarkResponse>,
    folders: Vec<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Suggestion {
    bookmark_id: Uuid,
    folder_name: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct SuggestFoldersResponse {
    suggestions: Vec<Suggestion>,
}

async fn suggest_folders(
    State(state): State<AppState>,
    Extension(_user): Extension<CurrentUser>,
    Json(payload): Json<SuggestFoldersRequest>,
) -> Result<Json<SuggestFoldersResponse>, StatusCode> {
    if payload.folders.is_empty() {
        return Ok(Json(SuggestFoldersResponse { suggestions: vec![] }));
    }

    let prompt = format!(
        "Folders: {:?}\n\nBookmarks: {}", 
        payload.folders,
        serde_json::to_string(&payload.bookmarks).unwrap()
    );

    // AI suggestion using Rig
    let extractor = state.openai
        .extractor::<SuggestFoldersResponse>(&state.model)
        .preamble("You are a semantic classification agent. Your sole task is to analyze the input text and select the single most appropriate folder from the provided list.\n\nRules:\n\nOutput exactly one folder path from the list for each bookmark. Do not create new folders.\n\nBase your selection on the closest match to the input's primary domain, technology, or intent.\n\nExtract only what is explicitly stated or strongly implied.")
        .additional_params(json!({ "enable_thinking": false }))
        .build();

    let suggestions = extractor.extract(&prompt).await.map_err(|e| {
        eprintln!("Rig extraction error (Suggest Folders): {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(suggestions))
}

async fn delete_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, StatusCode> {
    sqlx::query("DELETE FROM bookmarks WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}

async fn health_check(State(state): State<AppState>) -> String {
    let row: (i32,) = sqlx::query_as::<_, (i32,)>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .unwrap_or((0,));

    format!("DB Status: {}, OpenAI Client: Ready", if row.0 == 1 { "Connected" } else { "Error" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scrape_metadata() {
        let html = r#"
            <!DOCTYPE html>
            <html>
            <head>
                <title>Test Page</title>
                <meta name="description" content="A test description">
                <meta property="og:title" content="OG Title">
            </head>
            <body></body>
            </html>
        "#;

        let meta = scrape_metadata(html);
        assert_eq!(meta["title"], "Test Page");
        assert_eq!(meta["description"], "A test description");
        assert_eq!(meta["og:title"], "OG Title");
        assert!(meta.get("scraped_at").is_some());
    }

    #[test]
    fn test_sync_request_parsing() {
        let json = r#"{"url": "https://google.com", "title": "Google"}"#;
        let req: SyncBookmarkRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.url, "https://google.com");
        assert_eq!(req.title.unwrap(), "Google");
    }
}
