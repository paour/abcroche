# abcroche: a tiny ABC-notation score server.

# Build stage: third-party browser assets (abcjs, jQuery, xml2abc, a piano
# soundfont), fetched by the same script local development uses.
FROM node:24-alpine AS vendor
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts/ scripts/
RUN node scripts/vendor.mjs /app/.vendor

FROM node:24-alpine
# Liberation fonts are metric-compatible with the Times/Helvetica that abcjs
# asks for, so text in PNG images sets like it does in a browser.
RUN apk add --no-cache font-liberation \
 && mkdir /data && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/site \
    VENDOR_DIR=/app/.vendor
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=vendor /app/.vendor /app/.vendor
COPY site/ site/
COPY server.mjs render.mjs ./
USER node
# SQLite lives here; mount a volume to keep saved songs.
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --start-interval=2s --retries=2 \
  CMD wget -q --spider http://127.0.0.1:8000/healthz || exit 1
# node:sqlite still prints an ExperimentalWarning on start in Node 24.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
