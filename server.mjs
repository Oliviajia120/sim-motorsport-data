import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const port = Number(process.env.PORT) || 8080;
const html = await readFile(new URL("./index.html", import.meta.url));

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (path !== "/" && path !== "/index.html") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(html);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Sim Motorsport Data listening on ${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
