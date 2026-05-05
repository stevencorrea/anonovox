FROM oven/bun:1.3.10-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

# Cloud SQL Auth Proxy — tunnels to Cloud SQL on GCE VM via ADC
RUN apk add --no-cache curl netcat-openbsd && \
    curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
      https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.21.3/cloud-sql-proxy.linux.amd64 && \
    chmod +x /usr/local/bin/cloud-sql-proxy

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV CLOUD_SQL_INSTANCE=anonovox:us-west1:instance-20260505-212049
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
