# Docket

A local dashboard for the GitHub pull requests waiting on your review.

- **Needs you**: your review is requested and no other person has reviewed yet, or the author re-requested you.
- **Not blocked on you**: someone else already reviewed, you already reviewed, or it is a draft.

Reviews by bots don't count as someone else having reviewed. Stacked pull requests are grouped and joined by a rail; long chains collapse to their first three.

## Run

```sh
direnv allow   # or: nix develop
just build
./target/release/docket
```

Then open http://localhost:4747. The binary embeds the frontend, so it can be copied anywhere.

Authentication uses `GITHUB_TOKEN` (or `GH_TOKEN`) if set, otherwise the token from `gh auth token`.

## Configure

Optional. Docket reads the first of `--config <path>`, `./config.toml`, `~/.config/docket/config.toml`. See [config.example.toml](config.example.toml).

```toml
orgs = ["acme"]            # omit for every org you can see
repos = ["acme/web", "api"] # omit for every repo; bare names match in any org
port = 4747
refresh_seconds = 60
```

## Shortcuts

| Key | Action |
| --- | --- |
| `j` / `k` (or arrows) | Move |
| `g` / `G` | Top / bottom |
| `Enter` / `o` | Open on GitHub |
| `c` | Copy link |
| `e` | Expand or collapse a long chain |
| `r` | Refresh now |
| `/` | Filter, `Esc` to clear |
| `?` | Show shortcuts |

## Develop

```sh
just setup
just dev     # backend on :4747, Vite with hot reload on :5173
just check
```
