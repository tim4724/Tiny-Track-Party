# The server has NO runtime dependencies — only node builtins — so there is no
# install step and no node_modules in the image. Keep it that way: a new prod
# dependency means reinstating a builder stage here.
FROM node:20-alpine
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
WORKDIR /app
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
# partyplug (the transport kit) lives OUTSIDE public/ and is served via the
# /partyplug/ route remap in server/index.js. It must be copied into the image
# or that route 404s.
COPY partyplug/ ./partyplug/
USER nodejs
EXPOSE 4000
ENV NODE_ENV=production PORT=4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "server/index.js"]
