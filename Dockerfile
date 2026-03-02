FROM oven/bun:1.3.10-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["bun", "index.ts", "--production", "--no-env-file"]
