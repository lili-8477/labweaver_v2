# labweaver per-user devcontainer image.
#
# Base: pantheon-agents-sc:latest — an existing, stable image that already
# carries Python 3.12 + scanpy + R 4.5.3 + IRkernel + Seurat/SoupX/scDblFinder
# via rpy2. We do NOT use any Pantheon framework code from the base; the
# adapter is the entrypoint, not Pantheon's startup wrapper.
#
# If you want to decouple fully, extract the bio stack into its own
# labweaver-base image. See image/README.md.

FROM pantheon-agents-sc:latest

# 1. Node 22 for the adapter + DeepSeek Harness (dsh requires >= 22.19).
#    Use NodeSource for a clean apt install (Debian bookworm).
#    `jq` is required by the memory SessionStart hook
#    (hub/skeleton/harness/hooks/memory_session_start.sh) which parses the
#    /memory/context JSON response.
#    `openssh-client` + `rsync` power the CHPC bridge (chpc_bridge_* RPCs in
#    the adapter; pill in the frontend). `build-essential` is required by
#    node-pty's node-gyp fallback when no prebuilt binary is available for
#    this Node/glibc/arch combination — kept lean by removing apt lists.
USER root
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
        jq \
        tini \
        openssh-client \
        rsync \
        build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    # pnpm: `dsh plugin --profile acp add <pkg>` installs plugins with it.
    && npm install -g pnpm@10

# 1b. Non-root runtime user. Base image ships only root, and NodeSource's
#     apt nodejs package doesn't create a user (unlike the official node:* images).
#     Match the host user's UID so bind-mounted workspace writes stay on the host
#     user. Default 1001 = the `lili` account on this host; override with
#     --build-arg UID=... GID=... for other hosts.
ARG UID=1001
ARG GID=1001
RUN groupadd --gid "${GID}" node \
    && useradd  --uid "${UID}" --gid node --create-home --shell /bin/bash node

# 2. The agent runtime (DeepSeek Harness, `@deepseek-ai/dsh`) is a pinned
#    adapter dependency installed with the adapter bundle in step 3; the
#    adapter spawns `dsh --profile acp` from /opt/adapter/node_modules.

# 2b. Pre-install torch + CUDA-13 wheel stack (~2.5 GB) so agents don't
#     have to pull it on every container recreate. `--no-cache-dir` saves
#     ~1 GB of pip cache from landing in the image. Downstream packages
#     (scSurvival, scvi-tools, scArches, …) install in seconds once torch
#     is already present.
#
#     Placed BEFORE adapter COPY steps so the pip layer is cached across
#     adapter code edits — only torch version bumps invalidate it.
#
#     The same layer hands /venv (root-owned in the base) to node, so agents
#     can pip install at runtime. Chowning copies the base's files into this
#     layer once — shared by every container, instead of a per-container
#     copy-up (~6.5 GB and minutes each) at provisioning.
RUN pip install --no-cache-dir torch \
    && chown -R node:node /venv

# 2c. QuPath — headless IHC / whole-slide image analysis.
#     The Linux tarball is a jpackage bundle that carries its own JRE, so
#     no openjdk-* install is needed. libopenslide0 is the system library
#     QuPath's OpenSlide JNI binding dlopens at runtime to read .svs/.ndpi/
#     .scn / .mrxs slides; without it Bio-Formats handles the rest but the
#     fast WSI path goes dark.
#
#     Bump QUPATH_VERSION to upgrade. The /opt/QuPath* glob keeps us
#     forward-compatible with both `QuPath-v0.7.0` and `QuPath` tarball
#     roots without hardcoding.
#
#     Use the bundled launcher headless via:
#         QuPath script /path/to/script.groovy --image=...
ARG QUPATH_VERSION=0.7.0
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
        libopenslide0 \
        xz-utils \
    && curl -fsSL "https://github.com/qupath/qupath/releases/download/v${QUPATH_VERSION}/QuPath-v${QUPATH_VERSION}-Linux.tar.xz" \
        | tar -xJ -C /opt \
    && mv /opt/QuPath* /opt/qupath \
    && ln -sf /opt/qupath/bin/QuPath /usr/local/bin/QuPath \
    && rm -rf /var/lib/apt/lists/*

# 3. Adapter bundle + Python kernel bridge.
#    jupyter_client is already in the base image (pantheon-agents-sc's Python env).
WORKDIR /opt/adapter
COPY adapter/package.json adapter/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY adapter/dist/ ./dist/
# dsh plugins load from ../dsh-plugins relative to dist/index.js.
COPY adapter/dsh-plugins/ ./dsh-plugins/
COPY image/kernel-bridge.py ./kernel-bridge.py

# 3b. labweaver-memory MCP server. Pre-built dist/ is copied in (same convention
#     as adapter/). A direct symlink to dist/index.js puts the
#     `labweaver-memory-mcp` binary on PATH so per-user `.mcp.json` files can
#     `command: labweaver-memory-mcp` without per-user installs. We symlink
#     instead of `npm install -g .` to avoid duplicating node_modules into
#     /usr/lib — the runtime resolves @modelcontextprotocol/sdk from the
#     sibling node_modules of the symlink target.
WORKDIR /opt/mcp-memory
COPY mcp-memory/package.json mcp-memory/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY mcp-memory/dist/ ./dist/
RUN chmod +x /opt/mcp-memory/dist/index.js \
    && ln -s /opt/mcp-memory/dist/index.js /usr/local/bin/labweaver-memory-mcp

# 4. Entrypoint script launches the adapter under tini (PID 1 signal handling).
COPY image/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 5. Runtime dirs owned by the node user (created in step 1b).
RUN mkdir -p /home/node/.dsh /home/node/.ssh \
    && chown -R node:node /home/node/.dsh /home/node/.ssh /opt/adapter /opt/mcp-memory \
    && chmod 700 /home/node/.ssh \
    && chmod +x /opt/adapter/kernel-bridge.py

# Pre-create /workspace as node — otherwise `WORKDIR /workspace` below
# auto-creates it as root, and scanpy's `sc.pl.*(save=...)` (which does
# `makedirs('figures')` in the CWD) fails with EACCES.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV HOME=/home/node \
    WORKSPACE_ROOT=/workspace \
    DEFAULT_PROJECT=/workspace \
    DSH_HOME=/home/node/.dsh \
    DSH_PERMISSION_MODE=danger-full-access

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
