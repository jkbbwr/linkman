use axum::{
    Json, Router,
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use color_eyre::eyre::Result;
use dotenvy::dotenv;
use html_to_markdown_rs::{ConversionOptions, convert};
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Postgres, QueryBuilder, postgres::PgPoolOptions};
use std::env;
use tower_http::cors::{Any, CorsLayer};
use tracing::{Level, error, info};
use uuid::Uuid;

use async_openai::{Client, config::OpenAIConfig};

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the linkman server
    Serve,
    /// Create a new API key
    CreateApiKey {
        /// Description for the API key
        #[arg(short, long)]
        description: String,
        /// Optional specific key string. If not provided, a random UUID will be used.
        #[arg(short, long)]
        key: Option<String>,
    },
}

#[derive(Clone)]
struct AppState {
    pool: Pool<Postgres>,
    openai: Client<OpenAIConfig>,
}

#[derive(Clone)]
struct CurrentUser {
    api_key_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
struct Bookmark {
    id: Uuid,
    url: String,
    title: Option<String>,
    tags: Vec<String>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct CreateBookmark {
    url: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct SearchParams {
    q: Option<String>,
    title: Option<String>,
    tag: Option<String>, // Comma separated tags
    #[serde(rename = "startDate")]
    start_date: Option<DateTime<Utc>>,
    #[serde(rename = "endDate")]
    end_date: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct DeleteParams {
    url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    dotenv().ok();

    tracing_subscriber::fmt().with_max_level(Level::INFO).init();

    let cli = Cli::parse();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    info!("Running database migrations...");
    sqlx::migrate!("./migrations").run(&pool).await?;
    info!("Migrations complete.");

    match cli.command {
        Commands::Serve => {
            info!("Starting linkman-server...");

            // Setup OpenAI Client
            let config = OpenAIConfig::new()
                .with_api_base(env::var("OPENAI_URL").expect("You must set OPENAI_URL."))
                .with_api_key("<nothing>");

            let mut headers = HeaderMap::new();
            if let Ok(extra_headers) = env::var("OPENAI_EXTRA_HEADERS") {
                for header_pair in extra_headers.split(',') {
                    if let Some((key, val)) = header_pair.split_once(':') {
                        if let (Ok(name), Ok(value)) = (
                            axum::http::HeaderName::from_bytes(key.trim().as_bytes()),
                            axum::http::HeaderValue::from_str(val.trim()),
                        ) {
                            headers.insert(name, value);
                        }
                    }
                }
            }

            let http_client = reqwest::Client::builder()
                .default_headers(headers)
                .build()?;

            let openai = Client::with_config(config).with_http_client(http_client);

            let state = AppState { pool, openai };

            let cors = CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any);

            let app = Router::new()
                .route(
                    "/bookmarks",
                    get(list_bookmarks)
                        .post(create_bookmark)
                        .delete(delete_bookmark),
                )
                .route("/bookmarks/sync", get(sync_bookmarks))
                .route("/admin/bookmarks/{id}/reprocess", post(reprocess_bookmark))
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth_middleware,
                ))
                .layer(cors)
                .with_state(state);

            let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
            info!("Server listening on {}", listener.local_addr()?);

            axum::serve(listener, app).await?;
        }
        Commands::CreateApiKey { description, key } => {
            let final_key = key.unwrap_or_else(|| Uuid::new_v4().to_string());

            sqlx::query!(
                "INSERT INTO api_keys (key, description) VALUES ($1, $2)",
                final_key,
                description
            )
            .execute(&pool)
            .await?;

            info!("Successfully created new API key:");
            info!("Description: {}", description);
            info!("Key: {}", final_key);
            println!("{}", final_key);
        }
    }

    Ok(())
}

async fn auth_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut request: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = headers
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));

    let key = match auth_header {
        Some(k) => k,
        None => {
            info!("Missing Authorization header");
            return Err(StatusCode::UNAUTHORIZED);
        }
    };

    let record = sqlx::query!("SELECT id FROM api_keys WHERE key = $1", key)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| {
            error!("Database error during auth: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    match record {
        Some(r) => {
            request
                .extensions_mut()
                .insert(CurrentUser { api_key_id: r.id });
            Ok(next.run(request).await)
        }
        None => {
            info!("Invalid API key");
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

async fn create_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<CreateBookmark>,
) -> Result<impl IntoResponse, StatusCode> {
    let tags = payload.tags.clone().unwrap_or_default();
    let url_clone = payload.url.clone();

    let record = sqlx::query!(
        r#"
        INSERT INTO bookmarks (url, title, tags, api_key_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (url, api_key_id) DO UPDATE
        SET title = EXCLUDED.title, tags = EXCLUDED.tags
        RETURNING id
        "#,
        payload.url,
        payload.title,
        &tags,
        user.api_key_id
    )
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        error!("Database error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let bookmark_id = record.id;
    let pool_clone = state.pool.clone();
    let openai_clone = state.openai.clone();

    tokio::spawn(async move {
        if let Err(e) =
            process_bookmark_content(bookmark_id, url_clone, pool_clone, openai_clone).await
        {
            error!(
                "Failed to process background content for bookmark {}: {}",
                bookmark_id, e
            );
        }
    });

    Ok(StatusCode::CREATED)
}

async fn process_bookmark_content(
    bookmark_id: Uuid,
    url: String,
    pool: Pool<Postgres>,
    openai: Client<OpenAIConfig>,
) -> color_eyre::eyre::Result<()> {
    info!("Processing background content for: {}", url);

    let client = reqwest::Client::new();
    let res = client.get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 LinkmanBot/1.0")
        .send()
        .await?;

    if !res.status().is_success() {
        return Err(color_eyre::eyre::eyre!(
            "Request failed with status: {}",
            res.status()
        ));
    }

    let html_content = res.text().await?;

    let mut options = ConversionOptions::default();
    options.preprocessing.enabled = true;
    options.preprocessing.preset = html_to_markdown_rs::PreprocessingPreset::Aggressive;
    options.preprocessing.remove_navigation = true;
    options.preprocessing.remove_forms = true;

    let mut markdown = convert(&html_content, Some(options))?;
    markdown.truncate(markdown.chars().take(3500).map(|c| c.len_utf8()).sum());

    let request = async_openai::types::chat::CreateChatCompletionRequestArgs::default()
        .model("google/gemma-3-27b-it-qat-q4_0-gguf")
        .messages([
            async_openai::types::chat::ChatCompletionRequestSystemMessageArgs::default()
                .content(
                    "Task: Content Tagging.
                    Constraints:
                    - Exactly 6 tags.
                    - Format: Raw JSON ONLY. No markdown code blocks. No intro/outro text.
                    - Tags: Single words only. No hyphens, no spaces, all lowercase.
                    - Schema: {\"tags\": [\"word1\", \"word2\", ...]}",
                )
                .build()?
                .into(),
            async_openai::types::chat::ChatCompletionRequestUserMessageArgs::default()
                .content(format!(
                    "URL: {url}\n\nCONTENT:\n{markdown}\n\nJSON Output:"
                ))
                .build()?
                .into(),
        ])
        .response_format(async_openai::types::chat::ResponseFormat::JsonObject)
        .build()?;

    let response = openai.chat().create(request).await?;
    let ai_output = response
        .choices
        .first()
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();

    info!("AI generated JSON for {}: {}", url, ai_output);

    #[derive(Deserialize)]
    struct AiResponse {
        tags: Vec<String>,
    }

    let mut new_tags = match serde_json::from_str::<AiResponse>(&ai_output) {
        Ok(parsed) => parsed.tags,
        Err(e) => {
            error!("Failed to parse AI JSON response for {}: {}. Response was: {}", url, e, ai_output);
            return Err(e.into());
        }
    };

    // Assert no more than 6 tags
    new_tags.truncate(6);

    sqlx::query!(
        "UPDATE bookmarks SET tags = $1 WHERE id = $2",
        &new_tags,
        bookmark_id
    )
    .execute(&pool)
    .await?;

    info!("Successfully updated tags for {}", url);

    Ok(())
}

async fn list_bookmarks(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(params): Query<SearchParams>,
) -> Result<impl IntoResponse, StatusCode> {
    let mut query_builder: QueryBuilder<Postgres> = QueryBuilder::new(
        "SELECT id, url, title, tags, created_at FROM bookmarks WHERE api_key_id = ",
    );
    query_builder.push_bind(user.api_key_id);

    if let Some(q) = params.q {
        query_builder.push(" AND (url ILIKE ");
        query_builder.push_bind(format!("%{}%", q));
        query_builder.push(" OR title ILIKE ");
        query_builder.push_bind(format!("%{}%", q));
        query_builder.push(") ");
    }

    if let Some(title) = params.title {
        query_builder.push(" AND title ILIKE ");
        query_builder.push_bind(format!("%{}%", title));
    }

    if let Some(tag_str) = params.tag {
        let tags: Vec<String> = tag_str.split(',').map(|s| s.trim().to_string()).collect();
        for tag in tags {
            query_builder.push(" AND ");
            query_builder.push_bind(tag);
            query_builder.push(" = ANY(tags) ");
        }
    }

    if let Some(start) = params.start_date {
        query_builder.push(" AND created_at >= ");
        query_builder.push_bind(start);
    }

    if let Some(end) = params.end_date {
        query_builder.push(" AND created_at <= ");
        query_builder.push_bind(end);
    }

    query_builder.push(" ORDER BY created_at DESC");

    let bookmarks = query_builder
        .build_query_as::<Bookmark>()
        .fetch_all(&state.pool)
        .await
        .map_err(|e| {
            error!("Database error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(Json(bookmarks))
}

async fn sync_bookmarks(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<impl IntoResponse, StatusCode> {
    let bookmarks = sqlx::query_as!(
        Bookmark,
        "SELECT id, url, title, tags, created_at FROM bookmarks WHERE api_key_id = $1 ORDER BY created_at DESC",
        user.api_key_id
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        error!("Database error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(bookmarks))
}

async fn delete_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(params): Query<DeleteParams>,
) -> Result<impl IntoResponse, StatusCode> {
    let result = sqlx::query!(
        "DELETE FROM bookmarks WHERE url = $1 AND api_key_id = $2",
        params.url,
        user.api_key_id
    )
    .execute(&state.pool)
    .await
    .map_err(|e| {
        error!("Database error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn reprocess_bookmark(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, StatusCode> {
    let bookmark = sqlx::query!(
        "SELECT url FROM bookmarks WHERE id = $1 AND api_key_id = $2",
        id,
        user.api_key_id
    )
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        error!("Database error: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let bookmark = match bookmark {
        Some(b) => b,
        None => return Err(StatusCode::NOT_FOUND),
    };

    let pool_clone = state.pool.clone();
    let openai_clone = state.openai.clone();
    let url = bookmark.url;

    tokio::spawn(async move {
        if let Err(e) = process_bookmark_content(id, url, pool_clone, openai_clone).await {
            error!("Failed to reprocess content for bookmark {}: {}", id, e);
        }
    });

    Ok(StatusCode::ACCEPTED)
}
