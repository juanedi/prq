use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::json;

const QUERY: &str = r#"
query($q: String!, $cursor: String) {
  viewer { login avatarUrl }
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt additions deletions
        baseRefName headRefName
        repository { nameWithOwner defaultBranchRef { name } }
        author { login avatarUrl }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { slug } } }
        }
        latestReviews(first: 20) { nodes { state author { __typename login avatarUrl } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) {
          nodes {
            ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
          }
        }
      }
    }
  }
}"#;

const MAX_PAGES: usize = 4;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    #[serde(rename = "__typename")]
    pub typename: Option<String>,
    pub login: Option<String>,
    pub avatar_url: Option<String>,
    /// Set when the actor is a team.
    pub slug: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Nodes<T> {
    pub nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub name_with_owner: String,
    pub default_branch_ref: Option<Ref>,
}

#[derive(Debug, Deserialize)]
pub struct Ref {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub requested_reviewer: Option<Actor>,
}

#[derive(Debug, Deserialize)]
pub struct Review {
    pub state: String,
    pub author: Option<Actor>,
}

#[derive(Debug, Deserialize)]
pub struct CommitNode {
    pub commit: Commit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub status_check_rollup: Option<Rollup>,
}

#[derive(Debug, Deserialize)]
pub struct Rollup {
    pub state: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEvent {
    pub created_at: Option<String>,
    pub requested_reviewer: Option<Actor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub created_at: String,
    pub updated_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub repository: Repository,
    pub author: Option<Actor>,
    pub review_requests: Nodes<ReviewRequest>,
    pub latest_reviews: Nodes<Review>,
    pub commits: Nodes<CommitNode>,
    pub timeline_items: Nodes<RequestEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    page_info: PageInfo,
    nodes: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct Data {
    viewer: Actor,
    search: Search,
}

#[derive(Deserialize)]
struct Response {
    data: Option<Data>,
    errors: Option<Vec<GraphqlError>>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

pub struct Client {
    http: reqwest::Client,
    token: String,
}

impl Client {
    pub fn new() -> Result<Client> {
        Ok(Client {
            http: reqwest::Client::builder().user_agent("docket").build()?,
            token: token()?,
        })
    }

    /// Runs a pull request search, returning the viewer alongside the results.
    pub async fn search(&self, query: &str) -> Result<(Actor, Vec<PullRequest>)> {
        let mut prs = vec![];
        let mut cursor: Option<String> = None;
        let mut viewer = Actor::default();

        for _ in 0..MAX_PAGES {
            let response = self
                .http
                .post("https://api.github.com/graphql")
                .bearer_auth(&self.token)
                .json(&json!({ "query": QUERY, "variables": { "q": query, "cursor": cursor } }))
                .send()
                .await
                .context("could not reach GitHub")?;

            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                bail!("GitHub rejected the token. Run `gh auth login` or set GITHUB_TOKEN.");
            }
            let body: Response = response
                .json()
                .await
                .with_context(|| format!("unexpected response from GitHub ({status})"))?;

            let data = match (body.data, body.errors) {
                (Some(data), _) => data,
                (None, Some(errors)) => bail!(
                    "GitHub: {}",
                    errors
                        .into_iter()
                        .map(|e| e.message)
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
                (None, None) => bail!("GitHub returned an empty response ({status})"),
            };

            viewer = data.viewer;
            // Nodes we lack access to come back as empty objects.
            prs.extend(
                data.search
                    .nodes
                    .into_iter()
                    .filter_map(|node| serde_json::from_value::<PullRequest>(node).ok()),
            );

            if !data.search.page_info.has_next_page {
                break;
            }
            cursor = data.search.page_info.end_cursor;
        }

        Ok((viewer, prs))
    }
}

fn token() -> Result<String> {
    for var in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(token) = std::env::var(var) {
            if !token.trim().is_empty() {
                return Ok(token.trim().to_string());
            }
        }
    }

    let output = std::process::Command::new("gh")
        .args(["auth", "token"])
        .output()
        .context("no GITHUB_TOKEN set and the `gh` CLI was not found")?;
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || token.is_empty() {
        bail!("no GITHUB_TOKEN set and `gh auth token` failed. Run `gh auth login`.");
    }
    Ok(token)
}
