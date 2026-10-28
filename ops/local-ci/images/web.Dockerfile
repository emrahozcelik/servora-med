# Multiarch Node 22 Bookworm index; CI explicitly preserves linux/amd64.
FROM node:22.23.4-bookworm@sha256:78bc820a7a6148e8c48731eca18dbb9b6b2c05ac4a52138479be565f2831682d
ARG LOCAL_CI_IMAGE_DIGEST
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/servora-playwright/bootstrap
COPY web/package.json web/package-lock.json ./
COPY ops/local-ci/browser-availability.mjs /opt/servora-playwright/browser-availability.mjs
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && node node_modules/playwright/cli.js install --with-deps chromium webkit \
    && node /opt/servora-playwright/browser-availability.mjs --record \
    && LOCAL_CI_WEB_IMAGE_KEY="$LOCAL_CI_IMAGE_DIGEST" LOCAL_CI_WEB_ARCH="$(node -p process.arch)" node /opt/servora-playwright/browser-availability.mjs \
    && rm -rf node_modules /root/.npm /var/lib/apt/lists/*
WORKDIR /
