FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts=false
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && mkdir -p /app/config /app/tmp && chown -R node:node /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openclaw.plugin.json ./openclaw.plugin.json
COPY --from=build /app/README.md ./README.md
USER node
ENV NODE_ENV=production
ENV OPENWEBUI_MOSS_CONFIG_PATH=/app/config/plugin.config.json
ENV OPENCLAW_API_URL=http://host.docker.internal:3000/api/chat
CMD ["node", "dist/standalone.js"]
