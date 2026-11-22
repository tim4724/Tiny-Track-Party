# The branch previews' image (preview.yml): Apache serving site/, the same
# static tree main serves from Hetzner (hetzner-deploy.yml).

# Build stage: scripts/build-site.mjs, Node builtins only, so no npm install.
# The Node major is .nvmrc's; a Dockerfile cannot read it.
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY server/site.js ./server/
COPY scripts/build-site.mjs ./scripts/
COPY scripts/trailer/shots.js ./scripts/trailer/
COPY partyplug/ ./partyplug/
COPY public/ ./public/
# The commit the pages name (docker-publish.yml passes it).
ARG GIT_SHA=
# assets/ comes straight from the context below; build-site copies it verbatim.
RUN node scripts/build-site.mjs && rm -rf site/assets

# Runtime: Apache with public/.htaccess (httpd.conf sets up what Hetzner
# Webhosting provides around it).
FROM httpd:2.4-alpine
COPY httpd.conf /usr/local/apache2/conf/httpd.conf
# Assets (~110 MB, nearly all race soundtrack and trailer) get their OWN layer,
# below the rest. Folded into one copy, a one-line .js edit changed its digest
# and every preview deploy re-pulled the soundtrack. Split out, the digest is
# stable and the node reuses it across commits and namespaces.
COPY public/assets/ /usr/local/apache2/htdocs/assets/
COPY --from=builder /app/site/ /usr/local/apache2/htdocs/
USER 1001:1001
EXPOSE 4000
