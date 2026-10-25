# OrderQR — QR Ordering SaaS (Vite + Firebase)

Multi-tenant SaaS: isang codebase, maraming business (café, restaurant, salon, clinic, laundry).
Bawat client ay may sariling account, store, 14-day trial, at customer link na `/m/{slug}`.

**Status ng build:** ✅ Step 1 (skeleton) · ✅ Step 2 (signup/login + createStore + claims) · ✅ Step 3 (menu editor, tables + QR, settings, publicStores sync) · ✅ Step 4 (customer ordering, placeOrder, Orders page) · ✅ Step 5 (kitchen screen, staff accounts) · ✅ Step 6 (table reservations) · ✅ Step 7 (subscription, billing, admin panel) — **v1 complete**

```
qr-saas/
├─ index.html            ← Login / Create account
├─ app/index.html        ← Owner dashboard (setup wizard sa unang login)
├─ m/index.html          ← Customer menu  (/m/{slug}?t={tableToken})   ← Step 4
├─ kitchen/index.html    ← Kitchen board                                 ← Step 5
├─ src/
│  ├─ firebase.js        ← Firebase init (binabasa ang .env)
│  ├─ presets.js         ← Business type presets (frontend copy)
│  ├─ auth.js            ← Login / signup / Google / reset password
│  ├─ app.js             ← Wizard + dashboard
│  ├─ menu.js            ← Customer page (placeholder muna)
│  └─ styles.css
├─ functions/
│  ├─ index.js           ← Cloud Functions: createStore, whoAmI
│  └─ presets.js         ← SOURCE OF TRUTH ng presets
├─ firestore.rules       ← Security rules (custom claims: storeId, role)
├─ firebase.json         ← Hosting rewrites, functions, emulators
└─ DATA-MODEL.md         ← Firestore data model (basahin ito)
```

---

## STEP 1 — I-setup ang Firebase project (≈15 min, isang beses lang)

### 1.1 Mga kailangan sa computer mo
- **Node.js 20 LTS** → https://nodejs.org (i-check: `node -v`)
- **Firebase CLI** → `npm install -g firebase-tools` (i-check: `firebase --version`)

### 1.2 Gumawa ng Firebase project
1. Pumunta sa https://console.firebase.google.com → **Add project** → pangalanan (hal. `orderqr-prod`).
2. Puwedeng i-off ang Google Analytics (hindi kailangan).

### 1.3 I-enable ang services
Sa left menu ng Firebase Console:

| Service | Gawin |
|---|---|
| **Authentication** → Get started → Sign-in method | I-enable ang **Email/Password**, **Google**, at **Anonymous** (kailangan ng customer page para makapag-order nang walang account) |
| **Firestore Database** → Create database | Location: **asia-southeast1 (Singapore)** · Start in **production mode** (papalitan natin ang rules) |
| **Storage** → Get started | Production mode → Done (para sa logo/cover/item photos; papalitan ng `storage.rules`) |
| **Hosting** → Get started | Click lang hanggang matapos |
| ⚙️ Project settings → **Usage and billing** → **Blaze (pay as you go)** | Kailangan ito para sa Cloud Functions. May **libreng quota** (2M function calls/buwan, 50k Firestore reads/araw). Sa simula, ₱0 ang bill mo pero kailangan ng card. |

> **Walang card?** Puwede mong simulan ang Steps 1–3 gamit ang **Firebase Emulator** (tingnan sa ibaba). Kailangan lang ng Blaze kapag ide-deploy mo na online.

### 1.4 Kunin ang web config
1. ⚙️ Project settings → **General** → scroll down sa **Your apps** → click **</>** (Web).
2. Nickname: `web` → **Register app** (hindi kailangan i-check ang Hosting dito).
3. Makikita mo ang `firebaseConfig = { apiKey: "...", ... }`. Kopyahin ang values.

### 1.5 I-setup ang project folder
```bash
cd qr-saas
npm install                 # frontend deps (vite, firebase)
cd functions && npm install && cd ..   # Cloud Functions deps

cp .env.example .env
# Buksan ang .env at ilagay ang values mula sa 1.4
```

```bash
firebase login
firebase use --add         # piliin ang project mo, alias: default
```
(Ina-update nito ang `.firebaserc`. Puwede mo ring palitan nang manu-mano ang `PALITAN-NG-PROJECT-ID-MO`.)

### 1.6 I-deploy ang rules at functions
```bash
firebase deploy --only firestore:rules,storage
firebase deploy --only functions
```
Unang deploy ng functions ay 3–5 minuto. Kapag nag-error na "Blaze plan required", balikan ang 1.3.

---

## STEP 2 — Subukan ang signup → createStore → dashboard

```bash
npm run dev
```
Buksan http://localhost:5173

1. **Create account** → email + password (o Google).
2. Lalabas ang **setup wizard**: piliin ang business type → business name → Create my store.
3. Sa likod, tinawag ang Cloud Function `createStore`. Ginawa niya:
   - `stores/{storeId}` na may `mode`, `labels`, `theme`, settings mula sa preset
   - default `categories` (hal. Drinks, Food, Desserts)
   - `subscription/current` → `status: trial`, `trialEndsAt: +14 days`
   - `users/{uid}` → `{ storeId, role: "owner" }`
   - **custom claims** `{ storeId, role }` sa Auth user → ito ang binabasa ng security rules
   - `publicStores/{slug}` → public read-only copy para sa customer link
4. Makikita mo ang dashboard: trial days left, business type, customer link.
5. I-click ang customer link (`/m/kapehan-ni-juan`) → dapat lumabas "✅ Link works".

**I-verify sa Firebase Console → Firestore:** dapat may `stores`, `users`, `publicStores` collections.

### Kung may problema
| Error | Ayusin |
|---|---|
| `Walang Firebase config` sa console | Walang `.env` o mali ang laman. I-restart ang `npm run dev` pagkatapos mag-edit ng `.env`. |
| `functions/not-found` o CORS error | Hindi pa na-deploy ang functions, o mali ang region. Dapat `asia-southeast1` sa `.env` AT `functions/index.js`. |
| `auth/unauthorized-domain` sa Google login | Authentication → Settings → Authorized domains → idagdag ang `localhost` at ang hosting domain mo. |
| Pagkatapos ng wizard, hindi lumalabas ang dashboard | I-refresh ang page. Ang claims ay nakukuha sa bagong ID token (`getIdToken(true)`). |
| `permission-denied` sa Firestore | Hindi pa na-deploy ang `firestore.rules`, o wala pang claims ang user (mag-log out → log in). |

---

## I-deploy online (Firebase Hosting, libre)
```bash
npm run deploy        # vite build + deploy hosting + rules
```
Makakakuha ka ng `https://<project-id>.web.app`. Idagdag ang domain na ito sa **Authentication → Authorized domains**.
Mamaya puwede kang magkabit ng sariling domain (hal. `orderqr.ph`) sa Hosting → Add custom domain.

---

## Local testing gamit ang Emulator (optional, walang Blaze)
```bash
firebase emulators:start
```
Pagkatapos, sa `src/firebase.js` idagdag (dev lang):
```js
import { connectAuthEmulator } from "firebase/auth";
import { connectFirestoreEmulator } from "firebase/firestore";
import { connectFunctionsEmulator } from "firebase/functions";
if (location.hostname === "localhost") {
  connectAuthEmulator(auth, "http://localhost:9099");
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(functions, "localhost", 5001);
}
```

---

## Roadmap (Café/Restaurant edition muna)
| Step | Ano | Files |
|---|---|---|
| 1 ✅ | Project skeleton, Firebase config, rules, hosting | lahat |
| 2 ✅ | Signup/login, setup wizard, `createStore`, custom claims, trial | `auth.js`, `app.js`, `functions/index.js` |
| 3 | Dashboard: menu editor (categories, items, options/add-ons, photos), tables + QR generator, settings | `app/`, `src/` |
| 4 | Customer menu + cart + `placeOrder` + `syncPublicStore` + real-time order status | `m/`, `functions/` |
| 5 | Kitchen board: accept, prep time, ready, done, sold-out, shift summary, sound | `kitchen/` |
| 6 | Table reservation (customer form + owner list + status) | `m/`, `app/`, `functions/` |
| 7 | Subscription lock (`checkSubscriptions` daily), manual GCash activation, Billing page | `functions/`, `app/` |
| 8+ | Vouchers/promos, feedback, Telegram alerts, laundry mode, booking mode, PayMongo | |

## Branding & themes (Part 1 ng v1.1)
- **Logo / cover / item photos:** Firebase Storage (`storage.rules`). Client-side resize bago i-upload (logo 512px, cover 1600px, items 1000px).
- **Themes:** `src/themes.js` — Classic, Midnight, Sunset, Forest, Rosé, Coffee, Ocean, Mono + seasonal (Halloween, Christmas, Valentine, Fiesta, Summer). Bawat isa: gradient, decorations, default banner. Magdagdag ng entry para sa bagong theme.
- Pinipili sa **Settings → Theme**; puwedeng i-override ang brand color at banner text.

## Features (Part 2 ng v1.1) — Settings → Features (table mode)
- **Table reservations** — max pax, lead time.
- **Event booking** — packages (per head o flat, min pax, inclusions), lead days, max pax, deposit %, note. May estimate at deposit ang customer.
- **VIP rooms / KTV** — rooms (name, capacity, ₱/hour, min hours), lead time, note. Chine-check ng server ang **conflict** (hindi puwedeng mag-overlap sa parehong room).
- Lahat ay nasa iisang `reservations` collection na may `kind: table | event | vip`; iisang Reservations page sa dashboard (may filter).

## Billing & admin (Step 7)
- **Plans at presyo:** `functions/plans.js` (source of truth) at `src/plans.js` (kopya para sa Billing page). Pati GCash number/contact mo ay nasa `src/plans.js` → `PAYMENT`.
- **Super admin:** ilagay ang email mo sa `functions/admins.js` → `ADMIN_EMAILS`. Mag-login sa `/admin/` gamit ang email na iyon.
- **Flow ng bayad:** client → Billing → magbayad sa GCash → "I have paid" (ref no.) → lalabas sa `/admin/` bilang pending → **Confirm & activate** → active agad ang store.
- **Daily check** (`checkSubscriptions`, 12:10 AM PH): expired trial → `locked`; expired paid → `past_due` (3-day grace) → `locked`. Sa emulator, hindi tumatakbo ang schedule — gamitin ang **Run subscription check** button sa admin.
- Kapag `locked`: hindi makakapag-order/reserve ang customers, may banner sa dashboard, pero puwede pa ring mag-login ang owner para magbayad.

## Mahalagang rules ng codebase
- **Customer ay hindi direktang nagsusulat sa Firestore.** Lahat ng order/reservation ay dumadaan sa Cloud Function para hindi ma-fake ang presyo.
- **Subscription doc ay Cloud Functions lang ang nagbabago.**
- **Presets ay nasa code** (`functions/presets.js`). Para magdagdag ng bagong business type (barbershop, bakery), magdagdag lang ng entry doon at sa `src/presets.js`.
