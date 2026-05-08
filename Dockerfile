FROM oven/bun:1.3.10-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD ["bun", "src/index.ts"]
