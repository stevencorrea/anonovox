# anonovox

## Docker quickstart
A `Dockerfile` is provided to build a minimal container image that runs the app with Bun.

Build the Docker image from the project root:

```anonovox/README.md#L16-20
docker build -t anonovox:latest .
```

Run the container and publish the app's port to your host (the image exposes port `3000`):

```anonovox/README.md#L21-25
docker run --rm -p 3000:3000 anonovox:latest
```

After the container starts, the app should be reachable at:

```anonovox/README.md#L26-28
http://localhost:3000
```

Quick test with curl:

```anonovox/README.md#L29-31
curl http://localhost:3000
```

To install dependencies:

```anonovox/README.md#L1-6
bun install
```

To run in dev mode with live reloads:

```anonovox/README.md#L7-11
bun --hot index.ts
```

To run in production mode locally (without Docker):

```anonovox/README.md#L12-15
bun run index.ts
```

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

Notes:
- The provided `Dockerfile` sets the `ENTRYPOINT` to run `bun index.ts --production --no-env-file` and exposes port `3000`. If you need to supply environment variables from a `.env` file or via `--env-file`, you must override the image's entrypoint so Bun will load the environment variables. Example (override entrypoint to allow `--env-file`):

```anonovox/README.md#L32-38
# Use an env file and override the entrypoint so bun can read the env values:
docker run --rm -p 3000:3000 --env-file .env \
  --entrypoint bun anonovox:latest index.ts --production
```

- To run the container in development mode (mount your source and run `bun --hot`), you can mount the project directory and override the entrypoint:

```anonovox/README.md#L39-45
# Development container (hot reload). Requires host Bun/tooling if you expect file watchers to behave as on host.
docker run --rm -it -p 3000:3000 \
  -v "$(pwd)":/app --workdir /app \
  --entrypoint bun anonovox:latest --hot index.ts
```

- If you prefer Docker Compose, define a service that builds the image and maps port `3000` to the host.

## Troubleshooting

- If the container exits immediately, inspect the logs:

```anonovox/README.md#L46-48
docker logs <container-id-or-name>
```

- If you change the `Dockerfile` or dependencies, rebuild the image:

```anonovox/README.md#L49-50
docker build --no-cache -t anonovox:latest .
```

- On macOS, if file mounts behave unexpectedly with file watchers, prefer running Bun directly on the host for development (`bun --hot index.ts`) and use Docker for production testing.
