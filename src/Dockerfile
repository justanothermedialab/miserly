# Miserly — self-host image (M12). Wraps the ONE SvelteKit adapter-node server.
# Build context is the pnpm-workspace ROOT (src/), because the build needs the
# whole workspace (packages/core + apps/web) to resolve @miserly/core:
#   docker build -f src/Dockerfile -t miserly src/
# ---------------------------------------------------------------------------

# ---- Stage 1: builder (compiles native deps + builds the SvelteKit server) ----
FROM node:24-bookworm-slim AS builder

# node-gyp toolchain for better-sqlite3's native build. @node-rs/argon2 ships a
# prebuilt N-API binary and needs no compiler.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /app

# Copy the workspace manifests first (better layer caching), then the sources.
# tsconfig.base.json is the root config that apps/web AND packages/core extend —
# vite/svelte-kit build fails ("Tsconfig not found /app/tsconfig.base.json") without it.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# Install ONLY the web subgraph (web + @miserly/core) — never the desktop
# package's Electron toolchain (apps/desktop isn't even copied into this image).
# onlyBuiltDependencies (pnpm-workspace.yaml) approves better-sqlite3 + argon2
# native builds during install.
RUN pnpm install --frozen-lockfile --filter=@miserly/web...

# Build the adapter-node server (emits apps/web/build/), then produce a
# self-contained production tree (flattened node_modules, no pnpm store
# symlinks). `pnpm deploy` honours .gitignore, which ignores /build — so we
# copy the freshly-built build/ into the deployed tree explicitly.
#
# PRUNE: `pnpm deploy --legacy` does NOT honour --prod pruning for this
# (non-injected) workspace, so the entire build toolchain — esbuild's +
# rolldown's + lightningcss's per-PLATFORM native binary matrices (~670 MB) —
# rides into /app/out even though the bundled adapter-node runtime never
# requires it. The inlined node prune mirrors apps/desktop/scripts/
# prepare-server.mjs exactly; runtime deps (better-sqlite3, @node-rs/argon2)
# don't match and survive (measured: the image went from about 1 GB to about 520 MB).
# The engine (@miserly/core) is bundled into build/, so its copy in node_modules (with its
# tests) is never loaded; nothing runs the server with --enable-source-maps, so the server's
# .map files (about 7 MB) go too.
RUN pnpm --filter @miserly/web build \
  && pnpm deploy --filter=@miserly/web --prod --legacy /app/out \
  && cp -r /app/apps/web/build /app/out/build \
  && cp -r /app/apps/web/drizzle /app/out/drizzle \
  && node -e "const fs=require('fs'),p=require('path'),d='/app/out/node_modules/.pnpm';const RE=[/^@esbuild\+/,/^esbuild@/,/^@rolldown\+/,/^rolldown@/,/^@rollup\+/,/^rollup@/,/^lightningcss-/,/^lightningcss@/,/^vite@/,/^vitefu@/,/^typescript@/,/^tailwindcss@/,/^@tailwindcss\+/,/^drizzle-kit@/];let n=0;for(const f of fs.readdirSync(d)){if(RE.some(r=>r.test(f))){fs.rmSync(p.join(d,f),{recursive:true,force:true});n++;}}console.log('pruned '+n+' build-time store entries');" \
  && rm -rf /app/out/node_modules/@miserly /app/out/node_modules/.pnpm/@miserly+core* \
  && find /app/out/build -name '*.map' -delete

# ---- Stage 2: runner (slim, non-root, data on a volume) ----
FROM node:24-bookworm-slim AS runner

# tini as PID 1. Linux drops a signal sent to PID 1 that has no handler, and
# Node sets its SIGTERM handler only once the server has loaded (about 3 s on a slow box), so
# a `docker stop` or `podman stop` in the first seconds after a start was ignored, then a kill
# at 10 s. Under tini, Node is an ordinary process: a stop before the handler ends it at once,
# a stop after it is the server's graceful shutdown.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

# The env-var contract (see PACKAGING.md). ORIGIN defaults to localhost so a
# bare `docker run -p 3000:3000` works out of the box; it MUST be overridden to
# the externally-visible origin behind a reverse proxy, or form POSTs 403.
#
# NODE_OPTIONS — the RAM cap for small hosts (measured).
# Node 24 auto-sizes V8's young-generation (semi-space) to a large fraction of
# HOST RAM; that reserved young-gen — not live JS (heapUsed is only ~11 MB) —
# dominates RSS, ballooning the idle server to ~180 MB on a big-RAM box. Capping
# semi-space to 4 MB collapses idle RSS to ~74 MB (−59%) with NO throughput cost
# (2000 reqs / 1.24 s, no GC thrash); --max-old-space-size=256 is a generous
# ceiling (23× the live heap) that bounds reserved memory while leaving ML/report
# headroom. Deterministic across hosts — the guarantee holds on a 2–4 GB potato too.
#
# MISERLY_SETUP_CODE=on — a fresh instance prints a one-time setup code to its log
# (`docker logs miserly`, `podman logs miserly`) and /setup asks for it, so whoever
# reaches the port first can't take the instance over (H1 RD13). The desktop app
# leaves it off. On a trusted network, run with -e MISERLY_SETUP_CODE=off (
# PACKAGING.md lists the env file, Compose and Quadlet ways).
#
# SHUTDOWN_TIMEOUT=5 — on a stop, adapter-node closes idle connections at once and gives
# requests in progress this many seconds before closing them (its default, 30, outlasted
# Docker's and Podman's 10 s, so a stop with a slow page, an import or a half-sent request
# open became a kill). Then the database is closed (hooks.server.ts), which folds the
# write-ahead file in.
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-semi-space-size=4 --max-old-space-size=256" \
    SHUTDOWN_TIMEOUT=5 \
    MISERLY_DB_PATH=/data/miserly.db \
    MISERLY_MIGRATIONS_DIR=/app/drizzle \
    BODY_SIZE_LIMIT=64M \
    HOST=0.0.0.0 \
    PORT=3000 \
    ORIGIN=http://localhost:3000 \
    MISERLY_SETUP_CODE=on

WORKDIR /app
# Only what the server runs: package.json (its "type": "module"), the built server, the
# migrations and the runtime node_modules. The deployed tree also holds the app's source, test
# output and dev configs, which stay behind. The files stay root's (readable, not writable by
# `node`), so the server process can't rewrite its own code.
COPY --from=builder /app/out/package.json ./
COPY --from=builder /app/out/node_modules ./node_modules
COPY --from=builder /app/out/drizzle ./drizzle
COPY --from=builder /app/out/build ./build

# /data holds the SQLite system-of-record; owned by the unprivileged node user and closed to
# everyone else, and the server runs under umask 077 (CMD), so the database, its -wal and -shm
# and its backups are created 600: on a host folder mount other users can't read them.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data
EXPOSE 3000

# Healthy when the sign-in page answers without a server error. /signin needs no login and
# asks the database whether an admin exists, so a broken data file shows as unhealthy (a fresh
# instance answers with a redirect to /setup, which counts as healthy). The slim image has no
# curl, so node's own fetch asks.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/signin',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "umask 077 && exec node build/index.js"]
