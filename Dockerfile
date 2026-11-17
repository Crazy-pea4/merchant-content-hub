# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS builder
COPY . .
ENV NODE_ENV=production NEXT_STANDALONE=true SEED_DEMO=false
RUN npm run build

FROM ${NODE_IMAGE} AS api-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci --omit=dev --workspace=@fieldwork/api --include-workspace-root=false --no-audit --no-fund

FROM ${NODE_IMAGE} AS api-runner
WORKDIR /app
RUN node -e "const fs=require('node:fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('node:tls').rootCertificates.join('\n'))" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-noto-cjk python3 curl tesseract-ocr tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/.next/cache \
    && chown -R node:node /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ocr \
    && /opt/ocr/bin/pip install --no-cache-dir --disable-pip-version-check rapidocr==3.10.0 onnxruntime==1.24.4 \
    && /opt/ocr/bin/rapidocr download_models
ENV PATH="/opt/ocr/bin:$PATH"
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3101 PORT=3101 DATA_DIR=/app/data
COPY --from=api-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist/api ./dist/api
COPY --chown=node:node scripts/douyin-subtitles ./scripts/douyin-subtitles
COPY --chown=node:node docker/healthcheck.mjs ./docker/healthcheck.mjs
USER node
EXPOSE 3101
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
CMD ["node", "dist/api/api/main.js"]

FROM ${NODE_IMAGE} AS web-runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3100 API_INTERNAL_URL=http://api:3101
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --chown=node:node docker/healthcheck.mjs ./docker/healthcheck.mjs
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
CMD ["node", "server.js"]
