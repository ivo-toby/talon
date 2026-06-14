# =============================================================================
# Dockerfile — talond container image
# =============================================================================
# Multi-stage build:
#   builder  — installs all deps and compiles TypeScript to dist/
#   production — minimal runtime image with only what is needed
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder

WORKDIR /build

# Copy package files first so the layer is cached as long as deps don't change
COPY package.json package-lock.json ./

# Install ALL dependencies (including devDependencies) for the build step
RUN npm ci

# Copy source files
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: production
# ---------------------------------------------------------------------------
FROM node:24-slim AS production

LABEL org.opencontainers.image.title="talond" \
      org.opencontainers.image.description="Talon autonomous agent daemon" \
      org.opencontainers.image.source="https://github.com/user/talon" \
      org.opencontainers.image.licenses="MIT"

# Always run in production mode
ENV NODE_ENV=production

# Install runtime essentials:
#   tini             — minimal init: forwards signals and reaps zombies
#   git, curl, jq    — used by agents that need to shell out (clone repos,
#                      fetch URLs, parse JSON output of tools). These are
#                      tiny universal building blocks; specialized tools
#                      (gh, atlassian-cli, …) are added via MCP servers
#                      instead — see starter/docs/troubleshooting.md.
#   ca-certificates  — TLS root store, required for HTTPS calls by the
#                      provider runtime and any tool the agent runs.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        tini \
        git \
        curl \
        jq \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user/group with a fixed UID so host bind-mount
# permissions are predictable. node:slim ships with a `node` user at
# UID/GID 1000 already, so remove it first to free the slot.
#
# The user gets a real home directory (/home/talond): the codex and
# gemini CLIs write config/auth under ~/.codex and ~/.gemini and crash
# without a writable home. OAuth state stored there does NOT survive
# container recreation — use API-key auth, or bind-mount /home/talond,
# if you need it to persist.
RUN userdel node && \
    (getent group node >/dev/null && groupdel node || true) && \
    groupadd --gid 1000 talond && \
    useradd --uid 1000 --gid talond --create-home --shell /usr/sbin/nologin talond

# Application directory
WORKDIR /opt/talond

# Copy compiled output from the builder stage
COPY --from=builder /build/dist ./dist/

# Copy only production node_modules from the builder stage.
# We reinstall with --omit=dev so we don't carry devDependencies.
COPY --from=builder /build/package.json /build/package-lock.json ./
RUN npm ci --omit=dev

# Install the CLI-based agent providers globally so the `codex-cli` and
# `gemini-cli` provider strategies work out of the box (their config
# `command:` resolves `codex` / `gemini` from PATH). The `claude-code`
# provider needs nothing here — the Claude Code CLI ships bundled inside
# the `@anthropic-ai/claude-agent-sdk` npm dependency.
RUN npm install -g @openai/codex @google/gemini-cli && \
    npm cache clean --force

# Copy the example config so the image is self-documenting
COPY config/talond.example.yaml ./config/

# Volume mount points:
#   /data    — SQLite database file, PID file, IPC sockets
#   /config  — talond.yaml (bind-mount your config here at runtime)
# Optional bind mounts (not declared as VOLUME to avoid anonymous volume surprises):
#   /personas — persona directories
#   /skills   — custom skills
#   /subagents — custom sub-agents
VOLUME ["/data", "/config"]

# Ensure the daemon user can write to the volumes at runtime.
RUN mkdir -p /data /config /personas /skills /subagents && \
    chown talond:talond /data /config /personas /skills /subagents

# Create symlinks from /opt/talond/<dir> to /<dir> so that relative paths
# in the config (e.g. personas/assistant) resolve to the volume mounts.
RUN ln -s /data /opt/talond/data && \
    ln -s /personas /opt/talond/personas && \
    ln -s /skills /opt/talond/skills && \
    ln -s /subagents /opt/talond/subagents

# Switch to the non-root user for all subsequent commands
USER talond

# Health check: verify the process is alive by checking the PID file.
# Exits non-zero if the PID file is missing (daemon not started) or the process is dead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "const fs=require('fs'); \
        const pid=process.env.TALON_PID_FILE||'/data/talond.pid'; \
        if(!fs.existsSync(pid)){process.exit(1);} \
        const p=parseInt(fs.readFileSync(pid,'utf8').trim()); \
        try{process.kill(p,0);process.exit(0);}catch{process.exit(1);}"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/talond/dist/index.js", "--config", "/config/talond.yaml"]
