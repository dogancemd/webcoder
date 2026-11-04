FROM docker.io/library/debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    g++ \
    default-jdk-headless \
    nodejs \
    golang-go \
    rustc \
    libstd-rust-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Debian ships the Node binary as `nodejs`; provide the conventional `node` name
RUN command -v node >/dev/null 2>&1 || ln -s /usr/bin/nodejs /usr/local/bin/node

RUN useradd -m -u 10001 -s /bin/bash runner
WORKDIR /workspace
USER runner
