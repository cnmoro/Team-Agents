# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile the shared contracts, the server, and the web app.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# The Playwright browser download is only needed to *run* the e2e suite, not to
# build the app, and it would add hundreds of megabytes to this stage.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN npm run build

# Reduce to production dependencies only; the runtime stage copies this tree.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# bubblewrap sandboxes the agents; git and openssh-client are what those agents
# use to reach repositories; ca-certificates lets everything speak TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap \
      ca-certificates \
      git \
      openssh-client \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Agent harnesses. Each is optional: the app detects what is present at startup
# and greys out the rest, so an image built with `--build-arg INSTALL_HARNESSES=false`
# still runs as a chat app.
ARG INSTALL_HARNESSES=true
ARG CLAUDE_CODE_VERSION=2.1.226
ARG CODEX_VERSION=0.146.0
ARG OPENCODE_VERSION=1.18.15
RUN if [ "$INSTALL_HARNESSES" = "true" ]; then \
      npm install -g \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}" \
      && npm cache clean --force; \
    fi

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# The app runs as a non-root user. bubblewrap needs unprivileged user
# namespaces, which is why compose relaxes the default seccomp profile rather
# than granting root.
#
# /app/data is world-writable on purpose: a named volume inherits these
# permissions on first use, so the container still works when compose overrides
# the user to match the host's uid — which is what makes read-only mounts of the
# operator's harness logins readable.
RUN useradd --create-home --uid 10001 agent \
 && mkdir -p /app/data/home \
 && chmod -R 0777 /app/data

USER agent

# HOME points inside the data volume so a `claude`/`codex`/`opencode` login done
# in the container survives a restart.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    HOME=/app/data/home \
    DATA_DIR=/app/data \
    WEB_DIST=/app/apps/web/dist

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
