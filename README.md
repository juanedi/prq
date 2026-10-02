# Docket

A local dashboard for the GitHub pull requests waiting on your review.

- **Needs you**: your review is requested and nobody else has reviewed yet (bots don't count), or you were re-requested.
- **Not blocked on you**: someone else reviewed, you already reviewed, or it is a draft.

Stacked pull requests are grouped and joined by a rail.

## Run

```sh
direnv allow   # or: nix develop
just build
./target/release/docket
```

Open http://localhost:4747. The binary embeds the frontend. It authenticates with `GITHUB_TOKEN` if set, otherwise with `gh auth token`.

`just install` copies the binary to `~/.local/bin`, so `docket` works from anywhere.

## Configure

Optional: `./config.toml` or `~/.config/docket/config.toml` (or `--config <path>`).

```toml
orgs = ["acme"]             # default: every org you can see
repos = ["acme/web", "api"] # default: every repo; bare names match in any org
port = 4747
refresh_seconds = 60
```

## Develop

`just setup` once, then `just dev` (backend on :4747, Vite with hot reload on :5173) and `just check`.

Press `?` in the app for keyboard shortcuts.
