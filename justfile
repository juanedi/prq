default: build

# Install frontend dependencies
setup:
    cd web && npm install

# Backend on :4747 and Vite dev server on :5173 (proxying /api)
dev:
    #!/usr/bin/env bash
    trap 'kill 0' EXIT
    mkdir -p web/dist
    cargo run -- --no-open &
    cd web && npm run dev

# Single binary with the frontend embedded, at target/release/prq
build:
    cd web && npm install && npm run build
    cargo build --release

# Copy the binary to ~/.local/bin
install: build
    cargo install --path . --root ~/.local --locked

check:
    mkdir -p web/dist
    cargo fmt --check
    cargo clippy -- -D warnings
    cd web && npx tsc --noEmit
