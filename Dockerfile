FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci
FROM dependencies AS init
COPY --chown=node:node config ./config
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src
COPY --chown=node:node .sequelizerc ./

USER node
ENV NODE_ENV=production
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config
USER node
ENV NODE_ENV=production
EXPOSE 7010
CMD ["node", "src/server.js"]
FROM runtime AS customer
RUN node -e "require('node:fs').writeFileSync('/app/src/customer-policy.json',JSON.stringify({subscriptionRequired:true}))"
ENV NEOLA_CUSTOMER_DEPLOYMENT=true
