# The branch previews' image (preview.yml): Apache serving site/, the same
# static tree main serves from Hetzner (hetzner-deploy.yml).

# Build stage: scripts/build-site.mjs, which bundles with esbuild.
# The Node major is .nvmrc's; a Dockerfile cannot read it.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server/site.js ./server/
COPY scripts/build-site.mjs ./scripts/
COPY scripts/trailer/shots.js ./scripts/trailer/
COPY partyplug/ ./partyplug/
COPY public/ ./public/
# The commit the pages name (preview.yml passes it).
ARG GIT_SHA=
# assets/ comes straight from the context below; build-site copies it verbatim,
# so all that stays of it here is the models' brotli copies build-site made.
RUN node scripts/build-site.mjs && find site/assets -type f ! -name '*.br' -delete

# Runtime: Apache with public/.htaccess (httpd.conf sets up what Hetzner
# Webhosting provides around it).
FROM httpd:2.4-alpine@sha256:32bd0639bcc4917ef1fd9363a1d9dd2dd9c498565118b062a10d51e43a5c3a24
COPY httpd.conf /usr/local/apache2/conf/httpd.conf
# Assets get their OWN layers, below the rest. Folded into one copy, a one-line
# .js edit changed its digest and every preview deploy re-pulled the soundtrack.
# Split out, the digest is stable and the node reuses it across commits and
# namespaces. The soundtrack and the trailer are apart from the models: those
# change on every push of a world branch, and the media never do. The copies
# must not OVERLAP: a file copied twice lands in both layers whenever the two
# were built from different checkouts, because its mtime differs.
COPY public/assets/audio/ /usr/local/apache2/htdocs/assets/audio/
COPY public/assets/trailer/ /usr/local/apache2/htdocs/assets/trailer/
COPY --exclude=audio --exclude=trailer public/assets/ /usr/local/apache2/htdocs/assets/
COPY --from=builder /app/site/ /usr/local/apache2/htdocs/
USER 1001:1001
EXPOSE 4000
