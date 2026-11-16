// Minimal static file server for local previews (no dependencies).
// Usage: node serve.js [port] [root]
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.argv[2] || 8123);
const root = path.resolve(process.argv[3] || __dirname);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let filePath = path.join(root, urlPath);
    if (urlPath === "/" || urlPath.endsWith("/")) filePath = path.join(filePath, "index.html");

    // Prevent path traversal outside the served root
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Serving ${root} at http://127.0.0.1:${port}`);
  });
