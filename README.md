# prq

[![CI](https://github.com/juanedi/prq/actions/workflows/ci.yml/badge.svg)](https://github.com/juanedi/prq/actions/workflows/ci.yml)

A local dashboard for the GitHub pull requests waiting on your review.

- **Needs you**: your review is requested and nobody else has reviewed yet (bots don't count), or you were re-requested.
- **Not blocked on you**: someone else reviewed, you already reviewed, or it is a draft.

Stacked pull requests are grouped and joined by a rail.

## Run

```sh
direnv allow   # or: nix develop
just build
./target/release/prq
```

It opens http://localhost:4747 in your browser (pass `--no-open`, or set `open_browser = false`, to skip that). `--port <port>` overrides the configured port, and `--help` lists every flag. The binary embeds the frontend.

`just install` copies the binary to `~/.local/bin`, so `prq` works from anywhere.

## Authenticate

prq looks for a GitHub token once, at startup, and uses the first one it finds:

1. The `GITHUB_TOKEN` environment variable.
2. The `GH_TOKEN` environment variable.
3. The output of `gh auth token`, i.e. the account the [GitHub CLI](https://cli.github.com) is logged into.

If you already use `gh`, there is nothing to set up. Otherwise run `gh auth login`, or export a token that can read the pull requests you want to see (private repositories need the `repo` scope on a classic token).

The token is held in memory and only sent to `api.github.com`.

## Configure

Optional: `~/.config/prq/config.toml` (or `--config <path>`). If it doesn't exist, prq creates it on launch with every setting commented out.

```toml
orgs = ["acme"]             # default: every org you can see
repos = ["acme/web", "api"] # default: every repo; bare names match in any org
port = 4747
refresh_seconds = 300
open_browser = true
```

## Develop

`just setup` once, then `just dev` (backend on :4747, Vite with hot reload on :5173, or on the port in `VITE_DEV`) and `just check`.

Press `?` in the app for keyboard shortcuts.
