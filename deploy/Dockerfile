# Build from this repository root:
#   docker build -f deploy/Dockerfile -t crewly-server .
#
# The app is downloaded from its release, not built in this repository.
# A prepared web/ takes precedence; otherwise pin CREWLY_APP_VERSION below.
# A missing app fails the build instead of producing an API-only deployment.
FROM node:24-bookworm-slim AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY release.json ./release.json
COPY web ./web
ARG CREWLY_APP_VERSION
RUN npm run build && \
    if [ ! -f web/index.html ]; then node scripts/fetch-app.mjs "$CREWLY_APP_VERSION"; fi && \
    npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CREWLY_HOST=0.0.0.0 \
    CREWLY_PORT=8787 \
    CREWLY_DATA_DIR=/data \
    CREWLY_WEB_DIR=/app/web \
    CREWLY_LOG_LEVEL=info \
    CREWLY_TRUST_PROXY=true
WORKDIR /app
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/dist ./dist
COPY --from=build /workspace/web ./web
RUN mkdir -p /data /app/web && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/index.js"]
