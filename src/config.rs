use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::PathBuf;

const TEMPLATE: &str = include_str!("../config.example.toml");

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub orgs: Vec<String>,
    pub repos: Vec<String>,
    pub port: u16,
    pub refresh_seconds: u64,
    pub open_browser: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            orgs: vec![],
            repos: vec![],
            port: 4747,
            refresh_seconds: 300,
            open_browser: true,
        }
    }
}

impl Config {
    /// `--config <path>` wins, then ./config.toml, then ~/.config/docket/config.toml.
    pub fn load() -> Result<Config> {
        let mut args = std::env::args().skip(1);
        let mut explicit = None;
        let mut no_open = false;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--config" | "-c" => {
                    explicit = Some(PathBuf::from(args.next().context("--config needs a path")?))
                }
                "--no-open" => no_open = true,
                other => {
                    anyhow::bail!(
                        "unknown argument: {other}\nusage: docket [--config <path>] [--no-open]"
                    )
                }
            }
        }

        let mut config = Config::read(explicit)?;
        if no_open {
            config.open_browser = false;
        }
        Ok(config)
    }

    fn read(explicit: Option<PathBuf>) -> Result<Config> {
        let candidates = default_paths();
        let path = match explicit {
            Some(path) => Some(path),
            None => candidates.iter().find(|p| p.exists()).cloned(),
        };
        let Some(path) = path else {
            init_user_config();
            return Ok(Config::default());
        };

        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let config =
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        eprintln!("config: {}", path.display());
        Ok(config)
    }

    /// Search qualifiers narrowing results to the configured orgs. Repos are
    /// filtered afterwards with `allows`, since bare names can't be expressed in a search.
    pub fn search_scope(&self) -> String {
        self.orgs.iter().map(|org| format!(" org:{org}")).collect()
    }

    pub fn allows(&self, name_with_owner: &str) -> bool {
        let (owner, name) = name_with_owner
            .split_once('/')
            .unwrap_or(("", name_with_owner));
        let org_ok =
            self.orgs.is_empty() || self.orgs.iter().any(|o| o.eq_ignore_ascii_case(owner));
        let repo_ok = self.repos.is_empty()
            || self
                .repos
                .iter()
                .any(|r| r.eq_ignore_ascii_case(name_with_owner) || r.eq_ignore_ascii_case(name));
        org_ok && repo_ok
    }
}

fn default_paths() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("config.toml")];
    paths.extend(user_path());
    paths
}

fn user_path() -> Option<PathBuf> {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(config_home.join("docket/config.toml"))
}

/// Writes the template, with every setting commented out, so new users discover the file.
fn init_user_config() {
    let Some(path) = user_path() else {
        eprintln!("config: none found, using defaults");
        return;
    };
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, TEMPLATE));
    match written {
        Ok(()) => eprintln!(
            "config: none found, created {} with every setting commented out; edit it to customize",
            path.display()
        ),
        Err(error) => eprintln!(
            "config: none found, using defaults (could not create {}: {error})",
            path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_by_org_and_repo() {
        let config = Config {
            orgs: vec!["acme".into()],
            repos: vec!["web".into(), "acme/api".into()],
            ..Config::default()
        };
        assert!(config.allows("acme/web"));
        assert!(config.allows("Acme/API"));
        assert!(!config.allows("acme/docs"));
        assert!(!config.allows("other/web"));
        assert!(Config::default().allows("anyone/anything"));
    }

    #[test]
    fn template_keeps_the_defaults() {
        let config: Config = toml::from_str(TEMPLATE).unwrap();
        assert_eq!(format!("{config:?}"), format!("{:?}", Config::default()));
    }
}
