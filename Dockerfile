# vigil in a container: Node for the daemon, git and common tools for the workers, and a JRE so
# `vigil verify` can run the TLA+ checks.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep python3 openjdk-17-jre-headless \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/vigil
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY dist ./dist
COPY skills ./skills
COPY verification ./verification
COPY docs ./docs
RUN ln -s /opt/vigil/dist/cli.js /usr/local/bin/vigil && chmod +x /opt/vigil/dist/cli.js

ENV VIGIL_HOME=/data NODE_ENV=production VIGIL_HTTP_HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 7777
ENTRYPOINT ["vigil"]
CMD ["start"]
