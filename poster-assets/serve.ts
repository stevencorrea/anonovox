// Tiny Bun server for the poster-assets preview.
// Run from this folder:   bun serve.ts
// Then open:               http://localhost:4173
//
// Why this exists: opening index.html via file:// works fine now that the SVGs
// are inlined, but if you want hot-edit-and-refresh on individual icon files,
// run this server instead.

import { file } from "bun";
import { join, normalize } from "node:path";

const ROOT = import.meta.dir;
const PORT = Number(Bun.env.PORT ?? 4173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".md":   "text/markdown; charset=utf-8",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";

    // Reject any traversal outside ROOT
    const abs = normalize(join(ROOT, path));
    if (!abs.startsWith(ROOT)) return new Response("forbidden", { status: 403 });

    const f = file(abs);
    if (!(await f.exists())) return new Response("not found", { status: 404 });

    const ext = abs.slice(abs.lastIndexOf("."));
    return new Response(f, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  },
});

console.log(`anonovox poster-assets preview → http://localhost:${PORT}`);
