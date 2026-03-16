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

# Install tini as a minimal init process so signals are forwarded correctly
# and zombie processes are reaped.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user/group with a fixed UID so host bind-mount
# permissions are predictable.
RUN groupadd --gid 1000 talond && \
    useradd --uid 1000 --gid talond --no-create-home --shell /usr/sbin/nologin talond

# Application directory
WORKDIR /opt/talond

# Copy compiled output from the builder stage
COPY --from=builder /build/dist ./dist/

# Copy only production node_modules from the builder stage.
# We reinstall with --omit=dev so we don't carry devDependencies.
COPY --from=builder /build/package.json /build/package-lock.json ./
RUN npm ci --omit=dev

# Copy the example config so the image is self-documenting
COPY config/talond.example.yaml ./config/

# Volume mount points:
#   /data    — SQLite database file, PID file, IPC sockets
#   /config  — talond.yaml (bind-mount your config here at runtime)
#   /personas — persona directories (optional)
VOLUME ["/data", "/config", "/personas"]

# Ensure the daemon user can write to the data directory at runtime.
# The directory is created here so Docker creates it as root; at startup
# the container can chown it if needed, or the host pre-creates it.
RUN mkdir -p /data /config /personas && chown talond:talond /data /config /personas

# Create a symlink from /opt/talond/data to /data so that if dataDir
# is set to "data" (the default), it resolves to the volume mount.
RUN ln -s /data /opt/talond/data

# Switch to the non-root user for all subsequent commands
USER talond

# Health check: verify the process is alive by checking the PID file.
# Falls back to a simple node sanity check when no PID file is present yet.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const fs=require('fs'); \
        const pid=process.env.TALON_PID_FILE||'/data/talond.pid'; \
        if(fs.existsSync(pid)){const p=parseInt(fs.readFileSync(pid,'utf8').trim()); \
        try{process.kill(p,0);process.exit(0);}catch{process.exit(1);}} \
        process.exit(0);"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/talond/dist/index.js", "--config", "/config/talond.yaml"]
