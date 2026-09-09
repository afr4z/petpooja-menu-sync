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
const PP_API =
  env.PETPOOJA_API_URL ||
  "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1";

const RES_NAME = env.RES_NAME || "FitFuel";
const RES_ADDRESS = env.RES_ADDRESS || "";
const RES_CONTACT = env.RES_CONTACT || "";

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

const PLAN_TYPE_TO_DAYS = { "3day": 3, weekly: 7, biweekly: 14, monthly: 30 };

function toIST(d) {
  return new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
}

function dateStr(d) {
  return d.toISOString().split("T")[0];
}

function todayIST() {
  return dateStr(toIST(new Date()));
}

function tomorrowIST() {
  const d = toIST(new Date());
  d.setUTCDate(d.getUTCDate() + 1);
  return dateStr(d);
}

function currentISTHour() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours();
}

let slot = process.argv[2];
if (!slot) {
  const h = currentISTHour();
  if (h >= 22 || h < 4) slot = "breakfast";
  else if (h >= 4 && h < 11) slot = "lunch";
  else slot = "dinner";
  console.log(`[AUTO] IST hour ${h} → slot: ${slot}`);
}
if (!["breakfast", "lunch", "dinner"].includes(slot)) {
  console.error("Usage: node dispatch-orders.js [breakfast|lunch|dinner]");
  process.exit(1);
}

const deliveryDate = slot === "breakfast" ? tomorrowIST() : todayIST();

console.log(`[DISPATCH] Slot: ${slot}, Delivery date: ${deliveryDate}`);

const orderRes = await supFetch(
  `orders?select=id,phone,delivery_date,slot,delivery_time,status,subscription_id,item_id,item_name` +
    `&delivery_date=eq.${deliveryDate}&slot=eq.${slot}` +
    `&status=in.(pending,confirmed)&order=created_at.asc`,
);

const orders = orderRes.ok ? await orderRes.json() : [];
if (!orders.length) {
  console.log("No orders to dispatch");
  process.exit(0);
}
console.log(`Found ${orders.length} orders`);

const dishIds = [...new Set(orders.map((o) => o.item_id).filter(Boolean))];
const phones = [...new Set(orders.map((o) => o.phone))];
const subIds = [
  ...new Set(orders.map((o) => o.subscription_id).filter(Boolean)),
];

const [dishes, customers, subs] = await Promise.all([
  dishIds.length
    ? supFetch(
        `dishes?select=id,name,price,petpooja_item_id&id=in.(${dishIds.join(",")})`,
      ).then((r) => (r.ok ? r.json() : []))
    : [],
  phones.length
    ? supFetch(
        `customers?select=phone,name,address,location&phone=in.(${phones.join(",")})`,
      ).then((r) => (r.ok ? r.json() : []))
    : [],
  subIds.length
    ? supFetch(
        `meal_plan_subscriptions?select=id,plan_type,meal_plan_id&id=in.(${subIds.join(",")})`,
      ).then((r) => (r.ok ? r.json() : []))
    : [],
]);

const dishMap = Object.fromEntries(dishes.map((d) => [d.id, d]));
const custMap = Object.fromEntries(customers.map((c) => [c.phone, c]));
const subMap = Object.fromEntries(subs.map((s) => [s.id, s]));

const planPricingMap = {};
for (const sub of subs) {
  const days = PLAN_TYPE_TO_DAYS[sub.plan_type] || 30;
  const res = await supFetch(
    `plan_pricing?select=price_per_meal_per_day&plan_id=eq.${sub.meal_plan_id}&days=eq.${days}`,
  );
  const data = res.ok ? await res.json() : [];
  planPricingMap[sub.id] = data?.[0]?.price_per_meal_per_day || 0;
}

let dispatched = 0;
let failed = 0;

for (const order of orders) {
  const dish = dishMap[order.item_id];
  const cust = custMap[order.phone];
  const sub = subMap[order.subscription_id];
  const perMealCost = planPricingMap[order.subscription_id];
  const clientId = `FF-${order.delivery_date.replace(/-/g, "")}-${order.id.split("-")[0]}`;

  if (!dish?.petpooja_item_id) {
    console.error(`[SKIP] Order ${order.id}: dish missing petpooja_item_id`);
    failed++;
    continue;
  }
  if (!cust) {
    console.error(
      `[SKIP] Order ${order.id}: customer ${order.phone} not found`,
    );
    failed++;
    continue;
  }

  let lat = "",
    lng = "";
  if (cust.location) {
    const loc =
      typeof cust.location === "string"
        ? JSON.parse(cust.location)
        : cust.location;
    lat = loc?.lat?.toString() || "";
    lng = loc?.lng?.toString() || "";
  }

  const now = new Date();
  const createdOn = now.toISOString().replace("T", " ").slice(0, 19);

  const payload = {
    app_key: env.PETPOOJA_APP_KEY,
    app_secret: env.PETPOOJA_APP_SECRET,
    access_token: env.PETPOOJA_ACCESS_TOKEN,
    device_type: "Web",
    orderinfo: {
      OrderInfo: {
        Restaurant: {
          details: {
            restID: env.PETPOOJA_RESTAURANT_ID,
            res_name: RES_NAME,
            address: RES_ADDRESS,
            contact_information: RES_CONTACT,
          },
        },
        Customer: {
          details: {
            name: cust.name || "",
            phone: cust.phone,
            address: cust.address || "",
            email: "",
            latitude: lat,
            longitude: lng,
          },
        },
        Order: {
          details: {
            orderID: clientId,
            preorder_date: order.delivery_date,
            preorder_time: (order.delivery_time?.slice(0, 5) || "00:00") + ":00",
            service_charge: "0",
            sc_tax_amount: "0",
            delivery_charges: "0",
            dc_tax_percentage: "0",
            dc_tax_amount: "0",
            packing_charges: "0",
            pc_tax_amount: "0",
            pc_tax_percentage: "0",
            order_type: "H",
            payment_type: "ONLINE",
            discount_type: "F",
            discount_total: "0",
            tax_total: "0",
            total: perMealCost.toFixed(2) || "0",
            advanced_order: "Y",
            callback_url: "http://217.160.147.131/order-status",
            created_on: createdOn,
          },
        },
        OrderItem: {
          details: [
            {
              id: dish.petpooja_item_id,
              name: dish.name,
              price: Number(dish.price).toFixed(2),
              final_price: Number(dish.price).toFixed(2),
              quantity: "1",
              tax_inclusive: true,
              gst_liability: "restaurant",
              item_tax: [],
              item_discount: "0",
              variation_name: "",
              variation_id: "",
              AddonItem: { details: [] },
            },
          ],
        },
        Tax: { details: [] },
      },
    },
  };

  const res = await fetch(`${PP_API}/save_order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (res.ok) {
    console.log(`[OK] Order ${clientId} (${dish.name}) → Petpooja`);
    await supFetch(`orders?id=eq.${order.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "sent_to_kitchen", petpooja_client_id: clientId }),
    }).catch((e) =>
      console.error(`[WARN] Failed to update order ${order.id}: ${e.message}`),
    );
    dispatched++;
  } else {
    console.error(`[FAIL] Order ${order.id}: ${res.status} ${text}`);
    failed++;
  }
}

console.log(`\n[DONE] Dispatched: ${dispatched}, Failed: ${failed}`);
process.exit(failed ? 1 : 0);
