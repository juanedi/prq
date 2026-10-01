default: build

# Install frontend dependencies
setup:
    cd web && npm install

# Backend on :4747 and Vite dev server on :5173 (proxying /api)
dev:
    #!/usr/bin/env bash
    trap 'kill 0' EXIT
    cargo run &
    cd web && npm run dev

# Single binary with the frontend embedded, at target/release/docket
build:
    cd web && npm install && npm run build
    cargo build --release

check:
    cargo fmt --check
    cargo clippy -- -D warnings
    cd web && npx tsc --noEmit
