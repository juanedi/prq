use crate::config::Config;
use crate::github::{Actor, PullRequest};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Person {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Reviewer {
    pub login: String,
    pub avatar_url: Option<String>,
    /// pending | approved | changes | commented
    pub state: &'static str,
    pub me: bool,
}

#[derive(Debug, Serialize)]
pub struct Chain {
    /// Shared by every pull request in the same chain.
    pub id: String,
    pub position: usize,
    pub total: usize,
    pub parent: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct Item {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: Person,
    pub draft: bool,
    pub requested_at: String,
    pub updated_at: String,
    pub additions: u64,
    pub deletions: u64,
    /// pass | fail | running
    pub ci: Option<&'static str>,
    pub reason: String,
    pub urgent: bool,
    pub reviewers: Vec<Reviewer>,
    pub chain: Option<Chain>,
    /// Base branch, when it isn't the default one and its pull request isn't in the queue.
    pub stacked_on: Option<String>,
    #[serde(skip)]
    needs_you: bool,
    #[serde(skip)]
    base: String,
    #[serde(skip)]
    head: String,
}

#[derive(Debug, Serialize, Default)]
pub struct Queue {
    pub needs_you: Vec<Item>,
    pub not_blocked: Vec<Item>,
}

fn person(actor: &Option<Actor>) -> Person {
    let actor = actor.clone().unwrap_or_default();
    Person {
        login: actor.login.unwrap_or_else(|| "ghost".into()),
        avatar_url: actor.avatar_url,
    }
}

fn review_state(state: &str) -> Option<&'static str> {
    match state {
        "APPROVED" => Some("approved"),
        "CHANGES_REQUESTED" => Some("changes"),
        "COMMENTED" => Some("commented"),
        _ => None,
    }
}

fn verb(state: &str) -> &'static str {
    match state {
        "approved" => "approved",
        "changes" => "requested changes",
        _ => "commented",
    }
}

/// `requested`: open pull requests currently awaiting the viewer's review.
/// `reviewed`: open pull requests the viewer has already reviewed.
pub fn build(
    me: &str,
    requested: Vec<PullRequest>,
    reviewed: Vec<PullRequest>,
    config: &Config,
) -> Queue {
    let mut seen = HashSet::new();
    let mut items: Vec<Item> = requested
        .into_iter()
        .map(|pr| (pr, true))
        .chain(reviewed.into_iter().map(|pr| (pr, false)))
        .filter(|(pr, _)| config.allows(&pr.repository.name_with_owner))
        .filter(|(pr, _)| pr.author.as_ref().and_then(|a| a.login.as_deref()) != Some(me))
        .filter(|(pr, _)| seen.insert(pr.url.clone()))
        .map(|(pr, is_requested)| classify(me, pr, is_requested))
        .collect();

    link_chains(&mut items);

    let (mut needs_you, mut not_blocked): (Vec<Item>, Vec<Item>) =
        items.into_iter().partition(|item| item.needs_you);
    needs_you.sort_by(|a, b| a.requested_at.cmp(&b.requested_at));
    not_blocked.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Queue {
        needs_you: group_chains(needs_you),
        not_blocked: group_chains(not_blocked),
    }
}

fn classify(me: &str, pr: PullRequest, is_requested: bool) -> Item {
    let author = person(&pr.author);

    let reviews: Vec<(Person, &'static str)> = pr
        .latest_reviews
        .nodes
        .iter()
        // Automated reviews (Copilot and the like) don't unblock anyone.
        .filter(|review| review.author.as_ref().and_then(|a| a.typename.as_deref()) != Some("Bot"))
        .filter_map(|review| Some((person(&review.author), review_state(&review.state)?)))
        .collect();
    let my_review = reviews
        .iter()
        .find(|(p, _)| p.login == me)
        .map(|(_, state)| *state);
    let mut others: Vec<&(Person, &'static str)> = reviews
        .iter()
        .filter(|(p, _)| p.login != me && p.login != author.login)
        .collect();
    others.sort_by_key(|(_, state)| match *state {
        "changes" => 0,
        "approved" => 1,
        _ => 2,
    });

    let requests: Vec<&Actor> = pr
        .review_requests
        .nodes
        .iter()
        .filter_map(|r| r.requested_reviewer.as_ref())
        .collect();
    let requested_directly = requests.iter().any(|r| r.login.as_deref() == Some(me));
    let team = requests.iter().find_map(|r| r.slug.clone());

    let needs_you = is_requested && !pr.is_draft && others.is_empty();

    let (reason, urgent) = if needs_you {
        if my_review.is_some() {
            ("Re-requested after your review".to_string(), true)
        } else if requested_directly && requests.len() == 1 {
            ("You are the only reviewer".to_string(), false)
        } else if let (false, Some(team)) = (requested_directly, team) {
            (format!("Requested from {team}, no reviews yet"), false)
        } else {
            ("No reviews yet".to_string(), false)
        }
    } else if pr.is_draft {
        ("Draft".to_string(), false)
    } else if let (false, Some(state)) = (is_requested, my_review) {
        let reason = match state {
            "approved" => "You approved",
            "changes" => "You requested changes, waiting on author",
            _ => "You commented",
        };
        (reason.to_string(), false)
    } else {
        let reason = match others.as_slice() {
            [] => "Reviewed".to_string(),
            [(who, state)] => format!("{} {}", who.login, verb(state)),
            [(who, state), rest @ ..] => {
                let n = rest.len();
                let noun = if n == 1 { "other" } else { "others" };
                format!("{} {}, {n} {noun} reviewed", who.login, verb(state))
            }
        };
        (reason, false)
    };

    let mut reviewers = vec![Reviewer {
        login: me.to_string(),
        avatar_url: None,
        state: if is_requested {
            "pending"
        } else {
            my_review.unwrap_or("pending")
        },
        me: true,
    }];
    for request in &requests {
        if let Some(login) = request.login.clone().or_else(|| request.slug.clone()) {
            reviewers.push(Reviewer {
                login,
                avatar_url: request.avatar_url.clone(),
                state: "pending",
                me: false,
            });
        }
    }
    for (who, state) in &others {
        reviewers.push(Reviewer {
            login: who.login.clone(),
            avatar_url: who.avatar_url.clone(),
            state,
            me: false,
        });
    }
    // A re-requested reviewer shows up both as a request and a review: keep the request.
    let mut logins = HashSet::new();
    reviewers.retain(|r| logins.insert(r.login.clone()));

    let events = &pr.timeline_items.nodes;
    let requested_at = if is_requested {
        events
            .iter()
            .rev()
            .find(|e| {
                e.requested_reviewer
                    .as_ref()
                    .and_then(|r| r.login.as_deref())
                    == Some(me)
            })
            .or(events.last())
            .and_then(|e| e.created_at.clone())
            .unwrap_or_else(|| pr.created_at.clone())
    } else {
        pr.updated_at.clone()
    };

    let ci = pr
        .commits
        .nodes
        .last()
        .and_then(|node| node.commit.status_check_rollup.as_ref())
        .map(|rollup| match rollup.state.as_str() {
            "SUCCESS" => "pass",
            "FAILURE" | "ERROR" => "fail",
            _ => "running",
        });

    let default_branch = pr.repository.default_branch_ref.map(|r| r.name);
    let stacked_on =
        (default_branch.as_deref() != Some(&pr.base_ref_name)).then(|| pr.base_ref_name.clone());

    Item {
        repo: pr.repository.name_with_owner,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author,
        draft: pr.is_draft,
        requested_at,
        updated_at: pr.updated_at,
        additions: pr.additions,
        deletions: pr.deletions,
        ci,
        reason,
        urgent,
        reviewers,
        chain: None,
        stacked_on,
        needs_you,
        base: pr.base_ref_name,
        head: pr.head_ref_name,
    }
}

/// A pull request whose base branch is another queued pull request's head is stacked on it.
fn link_chains(items: &mut [Item]) {
    let by_head: HashMap<(String, String), usize> = items
        .iter()
        .enumerate()
        .map(|(i, item)| ((item.repo.clone(), item.head.clone()), i))
        .collect();
    let parents: Vec<Option<usize>> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            item.stacked_on.as_ref()?;
            by_head
                .get(&(item.repo.clone(), item.base.clone()))
                .copied()
                .filter(|&parent| parent != i)
        })
        .collect();

    // (root, depth) per item; the step limit guards against branch cycles.
    let roots: Vec<(usize, usize)> = (0..items.len())
        .map(|i| {
            let (mut at, mut depth) = (i, 0);
            while let Some(parent) = parents[at].filter(|_| depth < items.len()) {
                at = parent;
                depth += 1;
            }
            (at, depth)
        })
        .collect();

    let mut sizes: HashMap<usize, (usize, usize)> = HashMap::new();
    for &(root, depth) in &roots {
        let entry = sizes.entry(root).or_insert((0, 0));
        entry.0 += 1;
        entry.1 = entry.1.max(depth);
    }

    for i in 0..items.len() {
        let (root, depth) = roots[i];
        let (members, max_depth) = sizes[&root];
        if members < 2 {
            continue;
        }
        let id = format!("{}#{}", items[root].repo, items[root].number);
        let parent = parents[i].map(|p| items[p].number);
        items[i].stacked_on = None;
        items[i].chain = Some(Chain {
            id,
            position: depth + 1,
            total: max_depth + 1,
            parent,
        });
    }
}

/// Keeps the list order but pulls chain members next to the first of them, bottom of the stack first.
fn group_chains(items: Vec<Item>) -> Vec<Item> {
    let mut order: Vec<String> = vec![];
    let mut groups: HashMap<String, Vec<Item>> = HashMap::new();
    for item in items {
        let key = match &item.chain {
            Some(chain) => chain.id.clone(),
            None => item.url.clone(),
        };
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(item);
    }
    order
        .into_iter()
        .flat_map(|key| {
            let mut group = groups.remove(&key).unwrap_or_default();
            group.sort_by_key(|item| item.chain.as_ref().map_or(0, |c| c.position));
            group
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pr(
        number: u64,
        head: &str,
        base: &str,
        requests: &[&str],
        reviews: &[(&str, &str)],
    ) -> PullRequest {
        serde_json::from_value(json!({
            "number": number,
            "title": format!("PR {number}"),
            "url": format!("https://github.com/acme/web/pull/{number}"),
            "isDraft": false,
            "createdAt": format!("2026-09-0{number}T00:00:00Z"),
            "updatedAt": format!("2026-09-1{number}T00:00:00Z"),
            "additions": 1,
            "deletions": 1,
            "baseRefName": base,
            "headRefName": head,
            "repository": { "nameWithOwner": "acme/web", "defaultBranchRef": { "name": "main" } },
            "author": { "login": "author" },
            "reviewRequests": { "nodes": requests.iter().map(|r| json!({ "requestedReviewer": { "login": r } })).collect::<Vec<_>>() },
            "latestReviews": { "nodes": reviews.iter().map(|(who, state)| json!({ "state": state, "author": { "login": who, "__typename": if who.ends_with("[bot]") { "Bot" } else { "User" } } })).collect::<Vec<_>>() },
            "commits": { "nodes": [] },
            "timelineItems": { "nodes": [] },
        }))
        .unwrap()
    }

    fn numbers(items: &[Item]) -> Vec<u64> {
        items.iter().map(|i| i.number).collect()
    }

    #[test]
    fn splits_on_whether_someone_else_reviewed() {
        let queue = build(
            "me",
            vec![
                pr(1, "a", "main", &["me"], &[]),
                pr(2, "b", "main", &["me"], &[("omar", "APPROVED")]),
                pr(3, "c", "main", &["me"], &[("me", "CHANGES_REQUESTED")]),
                pr(4, "d", "main", &["me"], &[("author", "COMMENTED")]),
                pr(6, "f", "main", &["me"], &[("copilot[bot]", "COMMENTED")]),
            ],
            vec![pr(5, "e", "main", &[], &[("me", "CHANGES_REQUESTED")])],
            &Config::default(),
        );

        assert_eq!(numbers(&queue.needs_you), [1, 3, 4, 6]);
        assert_eq!(queue.needs_you[0].reason, "You are the only reviewer");
        assert!(queue.needs_you[1].urgent);
        assert_eq!(numbers(&queue.not_blocked), [5, 2]);
        assert_eq!(
            queue.not_blocked[0].reason,
            "You requested changes, waiting on author"
        );
        assert_eq!(queue.not_blocked[1].reason, "omar approved");
    }

    #[test]
    fn groups_chains_bottom_first() {
        let queue = build(
            "me",
            vec![
                pr(1, "top", "middle", &["me"], &[]),
                pr(2, "solo", "main", &["me"], &[]),
                pr(3, "bottom", "main", &["me"], &[]),
                pr(4, "middle", "bottom", &["me"], &[("omar", "COMMENTED")]),
                pr(5, "orphan", "release", &["me"], &[]),
            ],
            vec![],
            &Config::default(),
        );

        assert_eq!(numbers(&queue.needs_you), [3, 1, 2, 5]);
        let top = queue.needs_you[1].chain.as_ref().unwrap();
        assert_eq!((top.position, top.total, top.parent), (3, 3, Some(4)));
        assert_eq!(queue.not_blocked[0].chain.as_ref().unwrap().id, top.id);
        assert!(queue.needs_you[2].chain.is_none());
        assert_eq!(queue.needs_you[3].stacked_on.as_deref(), Some("release"));
    }
}
