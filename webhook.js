import "./load-env.js";
import http from "node:http";
import { appendFileSync } from "node:fs";
import { syncMenu } from "./sync.js";
import { handleStockUpdate } from "./stock-update.js";

const LOG_FILE = "menu-pushes.log";

function log(line) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `[${ts}] ${line}`;
  console.log(msg);
  try { appendFileSync(LOG_FILE, msg + "\n"); } catch {}
}

const PORT = process.env.PORT || 3000;
const SECRET = process.env.INTERNAL_SECRET || "fitfuel-secret";
const PP_API = process.env.PETPOOJA_API_URL || "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1";

function read(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on("data", d => c.push(d));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch { resolve(null); } });
    req.on("error", reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = await read(req);

  // ── Order relay ──────────────────────────────────────────────
  if (req.url === "/save-order") {
    if ((req.headers["authorization"] || "") !== `Bearer ${SECRET}`)
      return json(res, 401, { error: "Unauthorized" });
    if (!body?.customer || !body?.order || !body?.order_items)
      return json(res, 400, { error: "Invalid payload" });

    const { app_key, app_secret, access_token, restID, ...clean } = body;
    const pp = await fetch(`${PP_API}/save_order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_key: process.env.PETPOOJA_APP_KEY,
        app_secret: process.env.PETPOOJA_APP_SECRET,
        access_token: process.env.PETPOOJA_ACCESS_TOKEN,
        restID: process.env.PETPOOJA_RESTAURANT_ID,
        ...clean,
      }),
    });
    const txt = await pp.text();
    try { return json(res, pp.ok ? 200 : 502, JSON.parse(txt)); } catch { return json(res, 502, { error: txt }); }
  }

  // ── Stock update from Petpooja ──────────────────────────────
  if (req.url === "/stock-update") {
    const r = await handleStockUpdate(body);
    log(`[STOCK] ${JSON.stringify(r)}`);
    return json(res, 200, { success: "1", ...r });
  }

  // ── Menu push from Petpooja ─────────────────────────────────
  if (req.url === "/menu") {
    if (!body || body.success !== "1") return json(res, 400, { error: "Invalid push" });

    try {
      const r = await syncMenu(body);
      log(`[MENU] ${JSON.stringify(r)}`);
      json(res, 200, { success: "1", ...r });
    } catch (e) {
      log(`[MENU] ERROR: ${e.message}`);
      json(res, 500, { success: "0", error: e.message });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
}).listen(PORT, () => console.log(`listening on ${PORT}`));
