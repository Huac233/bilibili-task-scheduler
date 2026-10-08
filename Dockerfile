# syntax=docker/dockerfile:1
#
# Single-image deployment: the backend serves the built frontend, so the whole
# application is one container plus one volume for the SQLite file.
#
# The build stage compiles both packages from the workspace; the runtime stage
# reinstalls only the server's production dependencies. That split keeps the
# final image free of TypeScript, Vite, Vue and the rest of the build toolchain,
# at the cost of resolving the server's few dependencies twice.

# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
FROM node:24-alpine AS build

RUN npm install -g pnpm@12.9.1
WORKDIR /app

# Manifests first so editing source does not invalidate the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @bts/web build \
 && pnpm --filter @bts/server build

# --------------------------------------------------------------------------
# Runtime
# --------------------------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app/server

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/app.sqlite \
    WEB_DIST=/app/web

# Only the server's own dependencies; the frontend is already static.
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/server/dist ./dist
COPY --from=build /app/web/dist /app/web

# The SQLite file and its WAL sidecars live here. Mount a volume at /app/data
# or every redeploy starts from an empty database.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Application logs go to stdout as JSON lines. Two things keep them bounded:
#
#   - Per-request logging is off unless LOG_REQUESTS=1, so a running scheduler
#     does not emit two lines per API call.
#   - The runtime caps stdout itself. docker-compose.yml sets 10 MB x 3 files;
#     a bare `docker run` needs the same flags explicitly:
#
#         --log-opt max-size=10m --log-opt max-file=3
#
# Sending history is stored separately in SQLite and pruned per task inside the
# application, so `docker logs` is only for operational messages.
EXPOSE 8787

# The scheduler runs in-process, so a healthcheck that only proves the HTTP
# server is up is enough to catch a wedged container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
