# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig*.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
COPY --from=build /app/dist ./dist
COPY config.yaml ./config.yaml
# data/ and secrets/ arrive as mounts, never baked into the image.
RUN useradd -r -u 10001 snowbot && mkdir -p /app/data && chown -R snowbot /app/data
USER snowbot
ENTRYPOINT ["node", "dist/index.js"]
CMD ["job=noop", "--dry-run"]
