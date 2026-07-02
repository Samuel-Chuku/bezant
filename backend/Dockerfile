# syntax=docker/dockerfile:1

# ── deps ─────────────────────────────────────────────────────────────────────
# better-sqlite3 is a native addon; the build stage carries the toolchain so it
# compiles even when a prebuilt binary is unavailable for this platform.
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Install ALL deps (tsx is a devDependency but required to run the server).
RUN npm ci

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# node_modules (with the compiled better-sqlite3 addon) carries over unchanged;
# both stages share the same glibc base so the native binary stays valid.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# SQLite DB + deliverables live here; mounted as a named volume in compose.
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
