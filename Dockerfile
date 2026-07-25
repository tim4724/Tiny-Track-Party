# Build stage — install production deps only (qrcode).
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Production stage
FROM node:20-alpine
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
# Assets (~170 MB, nearly all race soundtrack) get their OWN layer, ABOVE the
# code copies. Folded into COPY public/ they shared one layer, so a one-line .js
# edit changed its digest and every preview deploy re-pulled the soundtrack.
# Split out, the digest is stable and the node reuses it across commits and
# namespaces. COPY public/ below re-copies these paths, but byte-identical files
# diff to nothing, so that layer stays ~2.4 MB. Don't merge these two back.
COPY public/assets/ ./public/assets/
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/
# partyplug (transport kit) and vendor (Three.js) live OUTSIDE public/ and are
# served via the /partyplug/ and /vendor/ route remaps in server/index.js. They
# must be copied into the image or those routes 404.
COPY partyplug/ ./partyplug/
COPY vendor/ ./vendor/
USER nodejs
EXPOSE 4000
ENV NODE_ENV=production PORT=4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "server/index.js"]
