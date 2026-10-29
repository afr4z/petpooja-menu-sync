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

const PLAN_TYPE_TO_DAYS = {
  "3day": 3,
  weekly: 7,
  biweekly: 14,
  "21day": 21,
  monthly: 28,
};

// ─── Distance-based delivery ──────────────────────────────────────────────────
// Keep these defaults in sync with lib/deliveryPricing.js in the FitFuel repo.
const DELIVERY = {
  freeKm: Number(env.DELIVERY_FREE_KM || 3),
  standardPerMeal: Number(env.DELIVERY_STANDARD_PER_MEAL || 20),
  longPlanPerMeal: Number(env.DELIVERY_LONG_PLAN_PER_MEAL || 15),
  longPlanMinDays: Number(env.DELIVERY_LONG_PLAN_MIN_DAYS || 20),
  unknownPolicy: env.DELIVERY_UNKNOWN_POLICY || "charge",
  // Existing subscriptions created before this instant are never charged
  // delivery. New subscriptions are created after it.
  launchAt: env.DELIVERY_LAUNCH_AT || "2026-10-28T00:00:00+05:30",
};

const KITCHEN = {
  latitude: Number(env.KITCHEN_LAT || 17.2478673),
  longitude: Number(env.KITCHEN_LNG || 80.1496404),
};

function normalizeCoords(location) {
  if (!location) return null;
  if (typeof location === "string") {
    const match = location.match(
      /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/,
    );
    if (!match) return null;
    return {
      latitude: Number(match[1]),
      longitude: Number(match[2]),
    };
  }
  if (typeof location !== "object") return null;

  const latitude = Number(location.latitude ?? location.lat);
  const longitude = Number(
    location.longitude ?? location.lng ?? location.lon,
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function haversineKm(origin, destination) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(destination.latitude - origin.latitude);
  const dLng = toRad(destination.longitude - origin.longitude);
  const lat1 = toRad(origin.latitude);
  const lat2 = toRad(destination.latitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function deliveryChargeForOrder(sub, addr) {
  if (!sub) return 0;

  const created = new Date(sub.created_at).getTime();
  const launch = new Date(DELIVERY.launchAt).getTime();
  if (!Number.isFinite(created) || created < launch) return 0;

  const days = PLAN_TYPE_TO_DAYS[sub.plan_type] || 28;
  const rate =
    days >= DELIVERY.longPlanMinDays
      ? DELIVERY.longPlanPerMeal
      : DELIVERY.standardPerMeal;

  const coords = normalizeCoords(addr?.location);
  if (!coords) {
    return DELIVERY.unknownPolicy === "free" ? 0 : rate;
  }

  const distanceKm = haversineKm(KITCHEN, coords);
  return distanceKm <= DELIVERY.freeKm ? 0 : rate;
}

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
        `customers?select=phone,name,id&phone=in.(${phones.join(",")})`,
      ).then((r) => (r.ok ? r.json() : []))
    : [],
  subIds.length
    ? supFetch(
        `meal_plan_subscriptions?select=id,plan_type,meal_plan_id,address_id,created_at&id=in.(${subIds.join(",")})`,
      ).then((r) => (r.ok ? r.json() : []))
    : [],
]);

const dishMap = Object.fromEntries(dishes.map((d) => [d.id, d]));
const custMap = Object.fromEntries(customers.map((c) => [c.phone, c]));
const subMap = Object.fromEntries(subs.map((s) => [s.id, s]));

// ─── Delivery addresses (new model) ───────────────────────────────────────────
// Delivery address lives in customer_addresses, referenced by
// meal_plan_subscriptions.address_id (per-subscription). Subscriptions created
// before that column existed have address_id = NULL — for those we fall back to
// the customer's default address book entry.
const customerIds = [
  ...new Set(customers.map((c) => c.id).filter(Boolean)),
];
const addrRows = customerIds.length
  ? await supFetch(
      `customer_addresses?select=id,customer_id,address,location,is_default&customer_id=in.(${customerIds.join(",")})&order=created_at.asc`,
    ).then((r) => (r.ok ? r.json() : []))
  : [];

const addrById = Object.fromEntries(addrRows.map((a) => [a.id, a]));
const defaultAddrByCustomer = {};
const anyAddrByCustomer = {};
for (const a of addrRows) {
  if (a.is_default && !defaultAddrByCustomer[a.customer_id]) {
    defaultAddrByCustomer[a.customer_id] = a;
  }
  if (!anyAddrByCustomer[a.customer_id]) {
    anyAddrByCustomer[a.customer_id] = a;
  }
}

// Resolve the delivery address for an order: the subscription's own address
// first, then the customer's default address (covers pre-migration subs).
function resolveOrderAddress(order, cust, sub) {
  if (sub?.address_id && addrById[sub.address_id]) {
    return addrById[sub.address_id];
  }
  if (cust) {
    return defaultAddrByCustomer[cust.id] || anyAddrByCustomer[cust.id] || null;
  }
  return null;
}

const planPricingMap = {};
for (const sub of subs) {
  const days = PLAN_TYPE_TO_DAYS[sub.plan_type] || 28;
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
    console.error(`[SKIP] Order ${order.id}: customer ${order.phone} not found`);
    failed++;
    continue;
  }

  const addr = resolveOrderAddress(order, cust, sub);
  if (!addr) {
    console.error(`[SKIP] Order ${order.id}: no delivery address for ${order.phone} — add one via the dashboard before dispatch`);
    failed++;
    continue;
  }

  const delivery = deliveryChargeForOrder(sub, addr);
  const orderTotal = perMealCost + delivery;
  if (delivery > 0) {
    console.log(
      `[DELIVERY] Order ${order.id}: ₹${delivery.toFixed(2)} delivery`,
    );
  }

  const addressText = addr.address || "";
  let lat = "",
    lng = "";
  const addrCoords = normalizeCoords(addr.location);
  if (addrCoords) {
    lat = addrCoords.latitude.toString();
    lng = addrCoords.longitude.toString();
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
            address: addressText,
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
            delivery_charges: delivery.toFixed(2),
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
            total: orderTotal.toFixed(2),
            advanced_order: "Y",
            callback_url: env.ORDER_STATUS_CALLBACK_URL || "https://217.160.147.131.sslip.io/order-status",
            created_on: createdOn,
          },
        },
        OrderItem: {
          details: [
            {
              id: dish.petpooja_item_id,
              name: dish.name,
              // Use plan pricing (what the customer actually paid) as the item
              // price so that item price + delivery = total. dish.price is
              // synced from Petpooja and can diverge from plan_pricing.
              price: (perMealCost || Number(dish.price) || 0).toFixed(2),
              final_price: (perMealCost || Number(dish.price) || 0).toFixed(2),
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
