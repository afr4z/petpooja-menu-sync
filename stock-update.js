import { readFileSync, appendFileSync } from "node:fs";

const LOG_FILE = "stock-updates.log";

function log(line) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `[${ts}] ${line}`;
  console.log(msg);
  try { appendFileSync(LOG_FILE, msg + "\n"); } catch {}
}

const env = Object.fromEntries(
  readFileSync(".env", "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("="))
    .map(([k, ...v]) => [k.trim(), v.join("=").trim()]),
);

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

function supFetch(url, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${url}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
}

function parseItems(payload) {
  const items = [];

  if (payload?.items && Array.isArray(payload.items)) {
    for (const it of payload.items) {
      const itemid = it.itemid || it.item_id || it.id;
      if (!itemid) continue;
      items.push({
        itemid: String(itemid),
        available: normalizeActive(
          it.active ?? it.in_stock ?? it.status ?? it.available ?? it.is_available ?? "1"
        ),
      });
    }
  } else if (payload?.itemid || payload?.item_id || payload?.id) {
    items.push({
      itemid: String(payload.itemid || payload.item_id || payload.id),
      available: normalizeActive(
        payload.active ?? payload.in_stock ?? payload.status ?? payload.available ?? payload.is_available ?? "1"
      ),
    });
  }

  return items;
}

function normalizeActive(val) {
  if (val === true || val === "true" || val === "1" || val === "in_stock" || val === "instock") return true;
  if (val === false || val === "false" || val === "0" || val === "out_of_stock" || val === "outofstock" || val === "out") return false;
  return true;
}

export async function handleStockUpdate(payload) {
  log(`[START] Processing stock update (${JSON.stringify(payload)?.slice(0, 500)})`);
  const items = parseItems(payload);
  if (!items.length) {
    return { updated: 0, message: "No valid items in payload" };
  }

  const itemIds = items.map(i => i.itemid);
  const dishesRes = await supFetch(
    `dishes?select=id,petpooja_item_id,name,is_available&petpooja_item_id=in.(${itemIds.join(",")})`
  );
  const dishes = dishesRes.ok ? await dishesRes.json() : [];
  if (!dishes.length) {
    return { updated: 0, message: `No dishes matched item IDs: ${itemIds.join(", ")}` };
  }

  const dishByPetId = Object.fromEntries(dishes.map(d => [d.petpooja_item_id, d]));
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const dish = dishByPetId[item.itemid];
    if (!dish) {
      log(`[SKIP] No dish found for Petpooja item ${item.itemid}`);
      skipped++;
      continue;
    }
    if (dish.is_available === item.available) {
      log(`[SKIP] ${dish.name} (${item.itemid}): already ${item.available ? "available" : "unavailable"}`);
      skipped++;
      continue;
    }
    const res = await supFetch(`dishes?id=eq.${dish.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_available: item.available }),
    });
    if (res.ok) {
      log(`[OK] ${dish.name} (${item.itemid}): → ${item.available ? "available" : "unavailable"}`);
      updated++;
    } else {
      log(`[FAIL] ${dish.name} (${item.itemid}): ${res.status} ${await res.text()}`);
      skipped++;
    }
  }

  return { updated, skipped, total: items.length };
}

if (process.argv[1]?.endsWith("stock-update.js")) {
  const inputFile = process.argv[2];
  let payload;
  if (inputFile) {
    payload = JSON.parse(readFileSync(inputFile, "utf-8"));
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  }
  if (!payload) {
    log("[ERROR] Usage: node stock-update.js [payload.json]   (or pipe JSON via stdin)");
    process.exit(1);
  }
  const result = await handleStockUpdate(payload);
  log(`[DONE] Updated: ${result.updated}, Skipped: ${result.skipped}, Total: ${result.total}`);
  process.exit(result.updated ? 0 : 1);
}
