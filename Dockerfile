# scrape-service as a Cloudflare Container.
#
# The Playwright base image pins Chromium to the npm package version, so this
# tag must match the playwright version in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY config ./config

# Scratch space only: the instance disk vanishes when it sleeps. Durable job
# records and artefacts go to R2 (src/jobs/remote.mjs), configured by the
# fronting Worker through R2_* environment variables.
RUN mkdir -p /data && chown pwuser:pwuser /data

# 0.0.0.0 inside the container: it is reachable only through the fronting
# Worker, which authenticates every request, so this keeps the property the
# loopback bind protected on EC2.
ENV HOST=0.0.0.0 \
    PORT=8081 \
    JOB_ROOT=/data/jobs \
    ARTEFACT_ROOT=/data/artefacts \
    CHROMIUM_EXTRA_ARGS=--disable-dev-shm-usage

USER pwuser
EXPOSE 8081
CMD ["node", "src/server.mjs"]
