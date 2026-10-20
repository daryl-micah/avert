FROM node:22-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.11.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

# Runtime: compiled JS and production dependencies only, run as the unprivileged node user.
FROM node:22-slim
WORKDIR /app
RUN npm install -g pnpm@12.11.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY data ./data
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
EXPOSE 8080
USER node
# Read-only demo: graphs live in FalkorDB Cloud (FALKORDB_URL is a Container Apps secret).
CMD ["node", "dist/cli.js", "web"]
