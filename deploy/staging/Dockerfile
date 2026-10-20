FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir /state && chown 10001:10001 /state
USER 10001:10001
EXPOSE 8443
ENTRYPOINT ["node", "dist/bin/crot-cloud-relay.js", "--config", "/config/relay.json"]
