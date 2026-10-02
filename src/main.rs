mod config;
mod github;
mod queue;

use anyhow::Result;
use axum::{
    extract::{Query, State},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

#[derive(Serialize)]
struct Snapshot {
    viewer: queue::Person,
    /// Milliseconds since the Unix epoch.
    fetched_at: u128,
    refresh_seconds: u64,
    orgs: Vec<String>,
    repos: Vec<String>,
    #[serde(flatten)]
    queue: queue::Queue,
}

struct App {
    config: config::Config,
    github: github::Client,
    cache: Mutex<Option<(Instant, Arc<Snapshot>)>>,
}

#[derive(Deserialize)]
struct QueueParams {
    /// Oldest snapshot the caller accepts, in seconds. Capped at `refresh_seconds`.
    max_age: Option<u64>,
}

async fn fetch(app: &App) -> Result<Snapshot> {
    let scope = app.config.search_scope();
    let base = format!("is:pr is:open archived:false -author:@me{scope}");
    let requested_query = format!("{base} review-requested:@me");
    let reviewed_query = format!("{base} reviewed-by:@me");
    let (requested, reviewed) = tokio::try_join!(
        app.github.search(&requested_query),
        app.github.search(&reviewed_query),
    )?;
    let (viewer, requested) = requested;
    let me = viewer.login.clone().unwrap_or_default();

    Ok(Snapshot {
        queue: queue::build(&me, requested, reviewed.1, &app.config),
        viewer: queue::Person {
            login: me,
            avatar_url: viewer.avatar_url,
        },
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis()),
        refresh_seconds: app.config.refresh_seconds,
        orgs: app.config.orgs.clone(),
        repos: app.config.repos.clone(),
    })
}

async fn get_queue(State(app): State<Arc<App>>, Query(params): Query<QueueParams>) -> Response {
    // Holding the lock across the fetch keeps concurrent requests from hitting GitHub twice.
    let mut cache = app.cache.lock().await;
    let refresh = app.config.refresh_seconds;
    let max_age = Duration::from_secs(params.max_age.map_or(refresh, |s| s.min(refresh)));
    if let Some((at, snapshot)) = cache.as_ref() {
        if at.elapsed() < max_age {
            return Json(snapshot.as_ref()).into_response();
        }
    }

    match fetch(&app).await {
        Ok(snapshot) => {
            let snapshot = Arc::new(snapshot);
            *cache = Some((Instant::now(), snapshot.clone()));
            Json(snapshot.as_ref()).into_response()
        }
        Err(error) => {
            eprintln!("refresh failed: {error:#}");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("{error:#}") })),
            )
                .into_response()
        }
    }
}

async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (path, file) = match Assets::get(path) {
        Some(file) => (path, Some(file)),
        None => ("index.html", Assets::get("index.html")),
    };
    match file {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            "Frontend not built. Run `just build`, or `just dev` and open http://localhost:5173.",
        )
            .into_response(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = config::Config::load()?;
    let port = config.port;
    let open_browser = config.open_browser;
    let app = Arc::new(App {
        config,
        github: github::Client::new()?,
        cache: Mutex::new(None),
    });

    let router = Router::new()
        .route("/api/queue", get(get_queue))
        .fallback(asset)
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let url = format!("http://localhost:{port}");
    println!("Docket is running at {url}");
    if open_browser {
        if let Err(error) = open::that_detached(&url) {
            eprintln!("could not open the browser: {error}");
        }
    }
    axum::serve(listener, router).await?;
    Ok(())
}
