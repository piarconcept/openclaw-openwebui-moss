FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts=false
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && mkdir -p /app/moss-models && chown -R node:node /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openclaw.plugin.json ./openclaw.plugin.json
COPY --from=build /app/README.md ./README.md
USER node
ENV NODE_ENV=production
ENV MOSS_MODELS_DIR=/app/moss-models
ENV OPENCLAW_API_URL=http://host.docker.internal:18789/v1/chat/completions
ENV OPENCLAW_MODEL=openai-codex/gpt-5.4
ENV MOSS_PROVIDER_HOST=0.0.0.0
ENV MOSS_PROVIDER_PORT=4000
EXPOSE 4000
CMD ["node", "dist/provider-standalone.js"]
