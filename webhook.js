import "./load-env.js";
import http from "node:http";
import { appendFileSync } from "node:fs";
import { syncMenu } from "./sync.js";
import { handleStockUpdate } from "./stock-update.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sf = (url, o = {}) => fetch(SUPABASE_URL + "/rest/v1/" + url, {
  ...o, headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...o.headers }
});

const STATUS_MAP = {
  "-1": "cancelled",
  "1": "accepted",
  "2": "accepted",
  "3": "accepted",
  "4": "ready",
  "5": "ready",
  "10": "delivered",
};

const LOG_FILE = "menu-pushes.log";

function log(line) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `[${ts}] ${line}`;
  console.log(msg);
  try { appendFileSync(LOG_FILE, msg + "\n"); } catch {}
}

const NOTIFY_URL = (process.env.APP_URL || "").replace(/\/+$/, "") + "/api/notify";
const CRON_SECRET = process.env.CRON_SECRET;

function slotLabel(slot) {
  const m = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
  return m[slot] || slot || "Meal";
}

async function notifyDelivery(clientId) {
  if (!NOTIFY_URL || !CRON_SECRET) {
    log(`[NOTIFY] Skipped ${clientId}: APP_URL/CRON_SECRET not configured`);
    return;
  }
  const sel = await sf(`orders?petpooja_client_id=eq.${encodeURIComponent(clientId)}&select=phone,item_name,slot`);
  if (!sel.ok) {
    throw new Error(`select failed: ${sel.status}`);
  }
  const [order] = await sel.json();
  if (!order || !order.phone) {
    log(`[NOTIFY] No order/phone for ${clientId}`);
    return;
  }
  const emoji = order.slot === "breakfast" ? "☀️" : order.slot === "dinner" ? "🌙" : "🍽️";
  const message =
    `🚚 *Meal Dispatched*\n\n` +
    `${emoji} *${slotLabel(order.slot)}*: ${order.item_name || "Your meal"}\n\n` +
    `Your meal is on its way and will be with you shortly! 🍽️\n\n` +
    `— FitFuel Nutrition`;

  const nr = await fetch(NOTIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify({ to: order.phone, body: message }),
  });
  if (!nr.ok) throw new Error(`notify ${nr.status}: ${await nr.text()}`);
  log(`[NOTIFY] Sent dispatch confirmation to ${order.phone} for ${clientId}`);
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
      // Dump raw menu payload for debugging
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      import("node:fs").then(fs => {
        const { mkdirSync, writeFileSync } = fs.default || fs;
        try { mkdirSync("menu-dumps", { recursive: true }); } catch {}
        writeFileSync(`menu-dumps/raw-${ts}.json`, JSON.stringify(body, null, 2));
      }).catch(() => {});

      const r = await syncMenu(body);
      log(`[MENU] ${JSON.stringify(r)}`);
      json(res, 200, { success: "1", ...r });
    } catch (e) {
      log(`[MENU] ERROR: ${e.message}`);
      json(res, 500, { success: "0", error: e.message });
    }
    return;
  }

  if (req.url === "/order-status") {
    log(`[CALLBACK] ${JSON.stringify(body)}`);
    const { orderID: clientId, status, cancel_reason, ...rest } = body || {};
    if (clientId && status) {
      const ourStatus = STATUS_MAP[String(status)];
      if (ourStatus) {
        const update = { status: ourStatus };
        if (ourStatus === "cancelled" && cancel_reason) update.cancel_reason = cancel_reason;
        const r = await sf(`orders?petpooja_client_id=eq.${encodeURIComponent(clientId)}`, {
          method: "PATCH",
          body: JSON.stringify(update),
        });
        if (r.ok) log(`[CALLBACK] Updated ${clientId} → ${ourStatus}`);
        else log(`[CALLBACK] Failed to update ${clientId}: ${r.status} ${await r.text()}`);

        if (ourStatus === "delivered") {
          try {
            await notifyDelivery(clientId);
          } catch (e) {
            log(`[NOTIFY] Failed for ${clientId}: ${e.message}`);
          }
        }
      } else {
        log(`[CALLBACK] Unknown status ${status} for ${clientId}`);
      }
    }
    return json(res, 200, { success: "1" });
  }

  json(res, 404, { error: "Not found" });
}).listen(PORT, () => console.log(`listening on ${PORT}`));
