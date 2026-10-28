# The web app as static files, served on 0.0.0.0:5173.
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t hardhub-web .
#   docker run --rm -p 5173:5173 hardhub-web
# VITE_API_URL is fixed at build time; the default suits `docker compose up`
# on one computer (the browser reaches the API at localhost:8787).
FROM node:22.22.0-slim AS build
ARG VITE_API_URL=http://localhost:8787
ARG VITE_MOCK=0
ENV VITE_API_URL=$VITE_API_URL VITE_MOCK=$VITE_MOCK
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @hardhub/web...
COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN pnpm --filter @hardhub/web build

FROM node:22.22.0-slim
WORKDIR /src
COPY --from=build /src /src
WORKDIR /src/apps/web
USER node
EXPOSE 5173
# vite preview serves dist/ with the SPA fallback, bound to 0.0.0.0:5173 (vite.config.ts)
CMD ["node", "node_modules/vite/bin/vite.js", "preview"]
