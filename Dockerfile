FROM node:22-slim
WORKDIR /app
RUN npm install -g pnpm@12
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY data ./data
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# Read-only demo: graphs live in FalkorDB Cloud (FALKORDB_URL is a Fly secret).
CMD ["node_modules/.bin/tsx", "src/cli.ts", "web"]
