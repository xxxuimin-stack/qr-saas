# QR Ordering SaaS — Firestore Data Model (Multi-tenant)

Business types sa unang launch:

| businessType | mode | Ano ang ino-order | Pagkakaiba |
|---|---|---|---|
| `cafe`, `restaurant` | `table` | menu items | QR per table, kitchen screen |
| `salon`, `clinic` | `booking` | services | date, time slot, staff, duration |
| `laundry` | `pickup` | services per kilo/piece | drop-off → ready → pickup, may contact info |

Isang codebase lang. Ang `mode` ang nagde-decide ng flow; ang `businessType` ang nagde-decide ng labels, default categories, at theme.

---

## 1. Collections

```
users/{uid}
stores/{storeId}
stores/{storeId}/categories/{categoryId}
stores/{storeId}/items/{itemId}
stores/{storeId}/tables/{tableId}        ← table mode lang
stores/{storeId}/staff/{staffId}         ← booking mode (sino ang available)
stores/{storeId}/orders/{orderId}        ← orders, bookings, laundry jobs (iisang collection)
stores/{storeId}/subscription/current    ← billing status
publicStores/{slug}                      ← read-only copy para sa customer menu
```

### users/{uid}
```json
{
  "email": "owner@kapehan.ph",
  "name": "Juan",
  "storeId": "st_abc123",
  "role": "owner",          // owner | staff | kitchen
  "createdAt": <timestamp>
}
```

### stores/{storeId}
```json
{
  "name": "Kapehan ni Juan",
  "slug": "kapehan-ni-juan",          // ginagamit sa link: yourapp.com/m/kapehan-ni-juan
  "businessType": "cafe",             // cafe | restaurant | salon | clinic | laundry
  "mode": "table",                    // table | booking | pickup
  "ownerUid": "uid_xxx",
  "logoUrl": "...",
  "theme": { "primary": "#6b4f3a" },
  "contact": { "phone": "0917...", "address": "..." },
  "hours": { "mon": ["08:00","20:00"], ... },
  "settings": {
    "currency": "PHP",
    "acceptOrders": true,
    "labels": {                       // auto-set mula sa businessType preset
      "items": "Menu",                // Menu | Services
      "unit": "Table",                // Table | Appointment | Job
      "order": "Order"                // Order | Booking | Laundry Order
    },
    "booking": {                      // booking mode lang
      "slotMinutes": 30,
      "requireStaff": true
    },
    "pickup": {                       // pickup mode lang
      "requirePhone": true,
      "turnaroundHours": 24
    }
  },
  "createdAt": <timestamp>
}
```

### stores/{storeId}/categories/{categoryId}
```json
{ "name": "Drinks", "sortOrder": 1, "active": true }
```
Presets per business type:
- cafe/restaurant: Drinks, Food, Desserts
- salon: Hair, Nails, Facial / clinic: Consultation, Treatment, Aesthetic
- laundry: Wash & Fold, Dry Clean, Press Only

### stores/{storeId}/items/{itemId}
```json
{
  "name": "Iced Latte",
  "categoryId": "cat_drinks",
  "price": 120,
  "unit": "piece",            // piece | kg | session
  "durationMinutes": null,    // booking mode: 45, 60, atbp.
  "imageUrl": "...",
  "description": "...",
  "options": [                // sizes, add-ons
    { "name": "Size", "choices": [{ "label": "16oz", "add": 0 }, { "label": "22oz", "add": 20 }] }
  ],
  "available": true,
  "sortOrder": 3
}
```

### stores/{storeId}/tables/{tableId}  (table mode)
```json
{ "label": "Table 5", "qrToken": "t5_x8k2", "active": true }
```
Ang QR URL: `yourapp.com/m/{slug}?t={qrToken}`

### stores/{storeId}/staff/{staffId}  (booking mode)
```json
{
  "name": "Ate Mae",
  "services": ["item_haircut", "item_color"],
  "schedule": { "mon": ["10:00","19:00"], "tue": [] },
  "active": true
}
```

### stores/{storeId}/orders/{orderId}
Iisang collection para sa lahat ng mode. Iba lang ang `type` at ang laman.
```json
{
  "type": "table",                  // table | booking | pickup
  "status": "pending",              // tingnan ang status flow sa ibaba
  "items": [
    { "itemId": "...", "name": "Iced Latte", "qty": 2, "price": 120, "options": ["22oz"], "subtotal": 280 }
  ],
  "total": 280,
  "note": "less ice",
  "customer": { "name": "Ana", "phone": "0917..." },   // required sa booking at pickup

  "tableId": "tbl_5",               // table mode
  "staffId": "staff_mae",           // booking mode
  "scheduledAt": <timestamp>,       // booking mode
  "durationMinutes": 60,            // booking mode
  "weightKg": 5.5,                  // laundry
  "readyAt": <timestamp>,           // pickup/laundry

  "createdAt": <timestamp>,
  "updatedAt": <timestamp>
}
```

Status flow per mode:
- **table:** pending → preparing → served → paid → (cancelled)
- **booking:** pending → confirmed → in_progress → done → (cancelled, no_show)
- **pickup/laundry:** received → processing → ready → picked_up → (cancelled)

### stores/{storeId}/subscription/current
```json
{
  "plan": "basic",                  // trial | basic | pro
  "status": "trial",                // trial | active | past_due | locked
  "trialEndsAt": <timestamp>,
  "paidUntil": <timestamp>,
  "paymentMethod": "manual",        // manual | paymongo
  "paymongoSubscriptionId": null,
  "limits": { "tables": 10, "staff": 3, "items": 100 }
}
```
Pinapalitan lang ito ng **Cloud Functions** (admin SDK), hindi ng client. Isang scheduled function araw-araw ang nagche-check kung lumagpas na ang `paidUntil` at nagse-set ng `locked`.

### publicStores/{slug}
Flattened copy ng store + items na **readable ng kahit sino** (customers na nag-scan ng QR). Ina-update ng Cloud Function tuwing may pagbabago sa `stores/{storeId}` o `items`. Hindi kasama ang sensitive data (orders, staff schedule, subscription).
```json
{
  "storeId": "st_abc123",
  "name": "Kapehan ni Juan",
  "mode": "table",
  "theme": {...},
  "labels": {...},
  "acceptOrders": true,
  "categories": [...],
  "items": [...],
  "staff": [{ "id": "staff_mae", "name": "Ate Mae", "services": [...] }],   // booking lang, walang schedule
  "updatedAt": <timestamp>
}
```

---

## 2. Paano nag-o-order ang customer (walang account)

1. Nag-scan ng QR → `yourapp.com/m/kapehan-ni-juan?t=t5_x8k2`
2. Binabasa ang `publicStores/kapehan-ni-juan` (public read)
3. Nag-submit ng order → tumatawag sa **Cloud Function `placeOrder`** (callable), hindi direktang sumusulat sa Firestore
4. Ang function ang nag-va-validate (tama ba ang presyo, active ba ang store, hindi ba locked ang subscription, available ba ang slot) at saka nagsusulat sa `stores/{storeId}/orders`
5. Customer makakakuha ng `orderId` + status page na real-time (gamit ang anonymous auth o isang signed token)

Dahil ang function ang nagsusulat, hindi makakapag-fake ng presyo ang customer at hindi nila kailangan ng write access sa Firestore.

---

## 3. Signup flow (bagong store)

1. Firebase Auth signup (email/password o Google)
2. Wizard: business name → pili ng business type (Café / Restaurant / Salon / Clinic / Laundry) → logo
3. Cloud Function `createStore`:
   - gumagawa ng `stores/{storeId}` na may `mode` at `labels` mula sa preset
   - gumagawa ng default categories
   - gumagawa ng `subscription/current` na `status: trial`, `trialEndsAt: +14 days`
   - nagse-set ng `users/{uid}` = `{ storeId, role: "owner" }`
   - nagse-set ng **custom claims** `{ storeId, role }` sa Auth user
4. Redirect sa dashboard

Mahalaga ang custom claims: mas mabilis at mas ligtas i-check sa security rules kaysa magbasa ng `users/{uid}` bawat request.

---

## 4. Presets (code, hindi database)

```js
const PRESETS = {
  cafe:       { mode: "table",   labels: { items: "Menu",     unit: "Table",       order: "Order" },   categories: ["Drinks", "Food", "Desserts"] },
  restaurant: { mode: "table",   labels: { items: "Menu",     unit: "Table",       order: "Order" },   categories: ["Appetizers", "Mains", "Drinks", "Desserts"] },
  salon:      { mode: "booking", labels: { items: "Services", unit: "Appointment", order: "Booking" }, categories: ["Hair", "Nails", "Facial"] },
  clinic:     { mode: "booking", labels: { items: "Services", unit: "Appointment", order: "Booking" }, categories: ["Consultation", "Treatment", "Aesthetic"] },
  laundry:    { mode: "pickup",  labels: { items: "Services", unit: "Job",         order: "Laundry Order" }, categories: ["Wash & Fold", "Dry Clean", "Press Only"] },
};
```

Para magdagdag ng bagong business (barbershop, bakery, car wash), magdagdag lang ng linya dito.

---

## 5. Cloud Functions na kailangan

| Function | Trigger | Gawain |
|---|---|---|
| `createStore` | callable | gumawa ng store, presets, trial, custom claims |
| `placeOrder` | callable | validate at isulat ang order/booking |
| `syncPublicStore` | Firestore trigger sa `stores/{id}` at `items` | i-update ang `publicStores/{slug}` |
| `checkSubscriptions` | scheduled, araw-araw | i-lock ang expired, mag-email ng reminder 3 araw bago |
| `activateSubscription` | callable (admin lang) | manual activation kapag nagbayad via GCash |
| `paymongoWebhook` | HTTP | kapag may PayMongo na: i-update ang subscription status |

---

## 6. Order ng pag-build

1. Auth + `createStore` + custom claims
2. Dashboard: categories, items, tables (table mode muna, gawa na 'to)
3. `publicStores` sync + customer menu page + `placeOrder`
4. Subscription doc + daily check + manual activate
5. Pickup/laundry mode (konting dagdag lang: customer info, status flow)
6. Booking mode (staff, calendar, time slots) — huli kasi pinakamahirap
