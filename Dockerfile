# 1) Rust core → WebAssembly
FROM rust:1-slim AS wasm
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
COPY wasm/ .
RUN cargo build --release --target wasm32-unknown-unknown

# 2) static site; everything else runs in the visitor's browser
FROM nginx:alpine-slim
COPY index.html /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/
COPY --from=wasm /src/target/wasm32-unknown-unknown/release/ressam_core.wasm /usr/share/nginx/html/js/ressam.wasm
