import "./load-env.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

function supFetch(url, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${url}`, { ...opts, headers: { ...headers, ...opts.headers } });
}

function mapAttr(id) {
  return id === "1" ? true : id === "2" ? false : true;
}

export async function syncMenu(data) {
  const plans = await supFetch("meal_plans?select=id,name,tag&is_active=eq.true").then(r => r.json());
  if (!plans.length) return { upserted: 0, disabled: 0 };

  const planByTag = {};
  for (const p of plans) planByTag[p.tag.toLowerCase()] = p;

function parseCategoryName(categoryName) {
  const parts = categoryName.trim().toLowerCase().split("_");
  const slot = parts.pop();
  const tag = parts.join("_");
  if (!["breakfast", "lunch", "dinner"].includes(slot)) return null;
  return { tag, slot };
}

  const matchedCategories = [];
  for (const cat of data.categories || []) {
    const parsed = parseCategoryName(cat.categoryname);
    if (!parsed) continue;
    const plan = planByTag[parsed.tag];
    if (plan) matchedCategories.push({ ...cat, plan, slot: parsed.slot });
  }
  if (!matchedCategories.length) return { upserted: 0, disabled: 0, message: "No categories matched meal plans" };

  const catIds = new Set(matchedCategories.map(c => c.categoryid));
  const itemsByCat = {};
  for (const item of data.items || []) {
    if (catIds.has(item.item_categoryid)) {
      (itemsByCat[item.item_categoryid] ||= []).push(item);
    }
  }

  const existing = await supFetch("dishes?select=id,name,is_veg,price,is_available,meal_plan_id,slot").then(r => r.json()) || [];

  const byKey = {};
  for (const d of existing) byKey[`${d.name.toLowerCase()}|${d.meal_plan_id}|${d.slot}`] = d;

  const batch = [];
  const keys = new Set();

  for (const match of matchedCategories) {
    const items = itemsByCat[match.categoryid] || [];
    for (const item of items) {
      const name = item.itemname?.trim();
      if (!name) continue;
      const k = `${name.toLowerCase()}|${match.plan.id}|${match.slot}`;
      keys.add(k);
      const r = byKey[k];
      batch.push({
        id: r?.id || undefined,
        meal_plan_id: match.plan.id,
        name,
        description: match.categoryname,
        slot: match.slot,
        is_veg: mapAttr(item.item_attributeid),
        price: parseFloat(item.price) || 0,
        is_available: item.active === "1",
        petpooja_item_id: item.itemid,
      });
    }
  }

  for (let i = 0; i < batch.length; i += 100) {
    await supFetch("dishes", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch.slice(i, i + 100)),
    });
  }

  const disable = existing.filter(d => d.is_available && !keys.has(`${d.name.toLowerCase()}|${d.meal_plan_id}|${d.slot}`));
  if (disable.length) {
    const ids = disable.map(d => d.id);
    await supFetch(`dishes?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      body: JSON.stringify({ is_available: false }),
    });
  }

  return { upserted: batch.length, disabled: disable.length };
}

if (process.argv[1]?.endsWith("sync.js") || process.argv[1]?.endsWith("sync")) {
  const url = process.env.PETPOOJA_FETCH_MENU_URL;
  if (!url) { console.log("PETPOOJA_FETCH_MENU_URL not set"); process.exit(0); }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_key: process.env.PETPOOJA_APP_KEY,
      app_secret: process.env.PETPOOJA_APP_SECRET,
      access_token: process.env.PETPOOJA_ACCESS_TOKEN,
      restID: process.env.PETPOOJA_RESTAURANT_ID,
    }),
  });
  if (!res.ok) { console.error("Fetch failed", res.status, await res.text()); process.exit(1); }
  const result = await syncMenu(await res.json());
  console.log("Sync:", result);
}
