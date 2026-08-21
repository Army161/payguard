# syntax=docker/dockerfile:1

# Build stage. Kept separate so the runtime image carries no compiler, no dev dependencies, and
# no source, which is most of the way to the sub-200 MB target in kit/spec.md NFR-6.
FROM node:20-bookworm-slim AS build

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Copy only what the install needs first, so a source-only change does not invalidate the
# dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/store/package.json packages/store/
COPY packages/rails/package.json packages/rails/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY apps/cli/package.json apps/cli/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps

RUN pnpm run build

# Drop everything the runtime does not need.
#
# --prod removes dev dependencies. auto-install-peers=false additionally keeps the optional peers
# out: express, hono, and fastify are peers of @payguard/server, and better-sqlite3 and ioredis are
# peers of @payguard/store. The image ships the CLI, which uses none of them, and an operator who
# wants the SQLite store or the Express adapter installs it in a derived image.
#
# TypeScript is then removed explicitly. viem, zod, and abitype declare it as an optional peer for
# type-level features only; it has no runtime role and is 23 MB.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --config.auto-install-peers=false \
 && rm -rf node_modules/.pnpm/typescript@* node_modules/typescript \
 && rm -rf node_modules/.pnpm/*/node_modules/typescript

# Runtime stage.
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
# Mainnet stays refused until the third party audit completes. An operator who overrides this is
# doing so deliberately, which is the point.
ENV PAYGUARD_ALLOW_MAINNET=false

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/package.json ./package.json

# Runs unprivileged. node:20-slim ships a `node` user for exactly this.
USER node

ENTRYPOINT ["node", "apps/cli/dist/bin.js"]
CMD ["--help"]
