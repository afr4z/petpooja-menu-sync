import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("="))
    .map(([k, ...v]) => [k.trim(), v.join("=").trim()]),
);

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

function supFetch(url, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${url}`, { ...opts, headers: { ...headers, ...opts.headers } });
}

function mapAttr(id) {
  return id === "1" ? true : id === "2" ? false : true;
}

const menuFile = process.argv[2];
if (!menuFile) {
  console.error("Usage: node sync-plans.js <menu.json>");
  process.exit(1);
}

const data = JSON.parse(readFileSync(menuFile, "utf-8"));
if (data.success !== "1") {
  console.error("Invalid menu data (success != 1)");
  process.exit(1);
}

const plans = await supFetch("meal_plans?select=id,name,tag&is_active=eq.true").then(r => r.json());
if (!plans.length) {
  console.log("No active meal plans found");
  process.exit(0);
}
console.log(`Meal plans: ${plans.map(p => `${p.name} (${p.tag})`).join(", ")}`);

function parseCategoryName(categoryName) {
  const parts = categoryName.trim().toLowerCase().split("_");
  const slot = parts.pop();
  const tag = parts.join("_");
  if (!["breakfast", "lunch", "dinner"].includes(slot)) return null;
  return { tag, slot };
}

const planByTag = {};
for (const p of plans) planByTag[p.tag.toLowerCase()] = p;

const matchedCategories = [];
for (const cat of data.categories || []) {
  const parsed = parseCategoryName(cat.categoryname);
  if (!parsed) continue;
  const plan = planByTag[parsed.tag];
  if (plan) matchedCategories.push({ ...cat, plan, slot: parsed.slot });
}
if (!matchedCategories.length) {
  console.log("No Petpooja categories match any meal plan tag");
  console.log("Available tags:", plans.map(p => p.tag).join(", "));
  console.log("Petpooja categories:", data.categories.map(c => c.categoryname).join(", "));
  process.exit(0);
}
console.log(`Matched categories:\n${matchedCategories.map(m => `  ${m.categoryname} → ${m.plan.name} (${m.slot})`).join("\n")}`);

const catIds = new Set(matchedCategories.map(c => c.categoryid));
const itemsByCat = {};
for (const item of data.items || []) {
  if (catIds.has(item.item_categoryid)) {
    (itemsByCat[item.item_categoryid] ||= []).push(item);
  }
}

const allSlotsToSync = [...new Set(matchedCategories.map(m => `${m.plan.id}|${m.slot}`))];
const existingMap = {};
for (const key of allSlotsToSync) {
  const [planId, slot] = key.split("|");
  const rows = await supFetch(`dishes?select=id,name,is_veg,price,is_available,meal_plan_id,slot&meal_plan_id=eq.${planId}&slot=eq.${slot}`).then(r => r.json()) || [];
  console.log(`Existing dishes for plan ${planId} / ${slot}: ${rows.length}`);
  for (const d of rows) {
    existingMap[`${d.name}|${d.meal_plan_id}|${d.slot}`] = d;
    console.log(`  ${d.name} | id=${d.id} | price=${d.price} | available=${d.is_available}`);
  }
}

const batch = [];
const allKeys = new Set();

for (const match of matchedCategories) {
  const items = itemsByCat[match.categoryid] || [];
  for (const item of items) {
    const name = item.itemname?.trim();
    if (!name) continue;
    const k = `${name}|${match.plan.id}|${match.slot}`;
    allKeys.add(k);
    const r = existingMap[k];
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
  const chunk = batch.slice(i, i + 100);
  console.log(`\n--- Upsert batch ${i / 100 + 1} (${chunk.length} rows) ---`);
  for (const row of chunk) {
    console.log(`  ${row.id ? "UPDATE" : "INSERT"} ${row.name} | plan=${row.meal_plan_id} | price=${row.price} | veg=${row.is_veg} | available=${row.is_available}`);
  }
  const res = await supFetch("dishes", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(chunk),
  });
  if (!res.ok) console.error("  ERROR:", res.status, await res.text());
  else console.log(`  OK (${res.status})`);
}

const toDisable = [];
for (const key of allSlotsToSync) {
  const [planId, slot] = key.split("|");
  const rows = await supFetch(`dishes?select=id,name,is_available,meal_plan_id,slot&meal_plan_id=eq.${planId}&slot=eq.${slot}`).then(r => r.json()) || [];
  for (const d of rows) {
    if (d.is_available && !allKeys.has(`${d.name}|${d.meal_plan_id}|${d.slot}`)) {
      toDisable.push(d.id);
    }
  }
}
if (toDisable.length) {
  console.log(`\n--- Disabling ${toDisable.length} stale items ---`);
  for (const id of toDisable) console.log(`  DISABLE id=${id}`);
  for (let i = 0; i < toDisable.length; i += 100) {
    const chunk = toDisable.slice(i, i + 100);
    const res = await supFetch(`dishes?id=in.(${chunk.join(",")})`, {
      method: "PATCH",
      body: JSON.stringify({ is_available: false }),
    });
    if (!res.ok) console.error("  ERROR:", res.status, await res.text());
    else console.log(`  OK`);
  }
}

console.log(`Upserted: ${batch.length}, Disabled: ${toDisable.length}`);
