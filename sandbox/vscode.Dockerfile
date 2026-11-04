FROM docker.io/library/golang:1.27-bookworm AS go-tools
RUN CGO_ENABLED=0 GOBIN=/opt/go-tools go install golang.org/x/tools/gopls@v0.24.0 \
    && CGO_ENABLED=0 GOBIN=/opt/go-tools go install github.com/go-delve/delve/cmd/dlv@v1.27.2

FROM docker.io/gitpod/openvscode-server:latest

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    g++ \
    clangd \
    openjdk-21-jdk-headless \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Keep toolchains and bundled extensions outside the persistent room volume.
COPY --from=go-tools /usr/local/go /usr/local/go
COPY --from=go-tools /opt/go-tools/ /usr/local/bin/
ENV CARGO_HOME=/opt/webcoder/cargo \
    RUSTUP_HOME=/opt/webcoder/rustup
ENV PATH="/opt/webcoder/cargo/bin:/usr/local/go/bin:${PATH}"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain 1.99.1 \
       --component rust-src --component rustfmt --component clippy \
    && rm /tmp/rustup-init.sh \
    && mkdir -p /opt/webcoder/extensions \
    && chown -R openvscode-server:openvscode-server /opt/webcoder

# Expose the bundled Node as `node` in the integrated terminal.
RUN ln -sf /home/.openvscode-server/node /usr/local/bin/node

USER openvscode-server
# Pin versions compatible with OpenVSCode Server; JavaScript/TypeScript support
# is built in. Install at build time so joining a room requires no downloads.
RUN ${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server \
    --extensions-dir /opt/webcoder/extensions \
    --user-data-dir /tmp/webcoder-extension-install \
    --install-extension ms-python.python@2026.4.0 \
    --install-extension ms-pyright.pyright@1.1.402 \
    --install-extension llvm-vs-code-extensions.vscode-clangd@0.6.0 \
    --install-extension redhat.java@1.57.0 \
    --install-extension golang.Go@0.56.1 \
    --install-extension rust-lang.rust-analyzer@0.4.3085 \
    --install-extension esbenp.prettier-vscode@12.4.0 \
    && rm -rf /tmp/webcoder-extension-install
