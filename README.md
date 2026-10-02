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

It opens http://localhost:4747 in your browser (pass `--no-open`, or set `open_browser = false`, to skip that). `--port <port>` overrides the configured port, and `--help` lists every flag. The binary embeds the frontend. It authenticates with `GITHUB_TOKEN` if set, otherwise with `gh auth token`.

`just install` copies the binary to `~/.local/bin`, so `prq` works from anywhere.

## Configure

Optional: `./config.toml` or `~/.config/prq/config.toml` (or `--config <path>`). If neither exists, prq creates the latter on launch with every setting commented out.

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
