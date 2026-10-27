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

function parseCategoryName(categoryName) {
  // Petpooja's online display categories are prefixed with "Online "
  // (e.g. "Online Healthy_nonveg_breakfast"); the integration key is the
  // same name without that prefix.
  const cleaned = categoryName.trim().replace(/^online[\s_]+/i, "");
  const parts = cleaned.toLowerCase().split("_");
  const slot = parts.pop();
  const tag = parts.join("_");
  if (!["breakfast", "lunch", "dinner"].includes(slot)) return null;
  return { tag, slot, cleanName: cleaned };
}

export async function syncMenu(data) {
  const plans = await supFetch("meal_plans?select=id,name,tag&is_active=eq.true").then(r => r.json());
  if (!plans.length) return { upserted: 0, disabled: 0 };

  const planByTag = {};
  for (const p of plans) planByTag[p.tag.toLowerCase()] = p;

  const matchedCategories = [];
  for (const cat of data.categories || []) {
    const parsed = parseCategoryName(cat.categoryname);
    if (!parsed) continue;
    const plan = planByTag[parsed.tag];
    if (plan) matchedCategories.push({ ...cat, plan, slot: parsed.slot, cleanName: parsed.cleanName });
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
        categoryname: match.cleanName,
        slot: match.slot,
        is_veg: mapAttr(item.item_attributeid),
        price: parseFloat(item.price) || 0,
        is_available: item.active === "1",
        petpooja_item_id: item.itemid,
      });
    }
  }

  // PostgREST requires every object in a bulk insert to have the same keys.
  // Existing dishes carry an `id`; new dishes do not, so send them separately.
  for (const group of [batch.filter(r => r.id), batch.filter(r => !r.id)]) {
    for (let i = 0; i < group.length; i += 100) {
      const res = await supFetch("dishes", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(group.slice(i, i + 100)),
      });
      if (!res.ok) {
        throw new Error(`dishes upsert failed ${res.status}: ${await res.text()}`);
      }
    }
  }

  // A push may cover only some meal plans. Only disable dishes in the
  // plan/slot combinations this push actually touched; otherwise a single
  // meal-plan push would deactivate every other plan's dishes.
  const touched = new Set(matchedCategories.map(m => `${m.plan.id}|${m.slot}`));
  const disable = existing.filter(d =>
    d.is_available &&
    touched.has(`${d.meal_plan_id}|${d.slot}`) &&
    !keys.has(`${d.name.toLowerCase()}|${d.meal_plan_id}|${d.slot}`)
  );
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
