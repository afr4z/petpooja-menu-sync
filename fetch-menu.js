import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = process.env.PORT || 3001;

function read(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on("data", d => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c).toString()));
    req.on("error", reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const raw = await read(req);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  try {
    const parsed = JSON.parse(raw);
    mkdirSync("menu-dumps", { recursive: true });
    const file = `menu-dumps/menu-${ts}.json`;
    writeFileSync(file, JSON.stringify(parsed, null, 2));
    console.log(`[${ts}] Saved to ${file} (${raw.length} bytes)`);
    json(res, 200, { success: "1", saved: file });
  } catch {
    const file = `menu-dumps/raw-${ts}.txt`;
    mkdirSync("menu-dumps", { recursive: true });
    writeFileSync(file, raw);
    console.log(`[${ts}] Saved raw to ${file} (${raw.length} bytes)`);
    json(res, 200, { success: "1", saved: file });
  }
}).listen(PORT, () => console.log(`fetch-menu listening on ${PORT}`));
