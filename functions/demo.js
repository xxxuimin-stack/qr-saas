// DEMO STORES — taptayo.com/m/taptayo-cafe · taptayo-salon · taptayo-spa · taptayo-studio · taptayo-laundry · taptayo-airbnb
// Created / refreshed by the admin (Admin → Demo stores). Real customer pages with photos and sample data.
// Orders customers place here are pretend (test: true, numbered T1, T2…) and are cleared every few hours.
const PHOTO = (p) => `https://taptayo.com/demo/${p}`;
const OPEN = (o, c) => Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [o, c]]));
const CASH = [{ id: "cash", type: "cash", name: "Cash", enabled: true }];
const DEMO_NOTE = "This is a TapTayo demo store — orders and bookings here are pretend and nothing is charged.";

const DEMOS = [
  {
    slug: "taptayo-cafe", name: "TapTayo Café", businessType: "cafe", mode: "table",
    cover: PHOTO("cafe/bright.jpg"), theme: { preset: "taptayo" }, hours: OPEN("07:00", "22:00"),
    address: "Demo address · Metro Manila", tagline: "Coffee, silog and merienda — order from your table", city: "Makati",
    collabs: [
      { title: "3 food UGC videos for our new merienda menu", details: "Spanish latte + ube cheese pandesal. Clean, bright, 30–45 s. We post them on our page (UGC — no need to post on yours).", niche: "Food", budgetEach: 1200, freebies: "Free food for 2", deliverables: "1 vertical video each + 3 photos", slots: 3, ugc: true, onSite: true, days: 14 },
      { title: "Food vlogger for our 3rd anniversary", details: "Visit, try the bestsellers, post on your TikTok + FB. Bring a friend!", niche: "Food", budgetEach: 3000, freebies: "Free food up to 4 pax", deliverables: "1 TikTok + 3 IG stories", slots: 1, ugc: false, onSite: true, days: 20 },
    ],
    settings: {
      setup: { kind: "shop" }, service: { dineIn: true, takeOut: true, pickup: true, delivery: true, deliveryFee: 49 },
      loyalty: { enabled: true, stamps: 8, minTotal: 100, rewardText: "Free iced latte", rewardValue: 120 }, collab: { swap: true },
    },
    tables: 8,
    cats: [
      ["Coffee", "barista", [
        ["Iced Spanish Latte", 140, "drink/iced-spanish-latte.jpg", "Espresso, milk and sweet condensed milk", true],
        ["Iced Latte", 120, "drink/iced-latte.jpg", "Double shot, fresh milk, ice", true],
        ["Iced Americano", 100, "drink/iced-americano.jpg", "Bold and clean", true],
        ["Iced Mocha", 150, "drink/iced-mocha.jpg", "Espresso, chocolate, milk", true],
        ["Caramel Macchiato", 155, "drink/caramel-macchiato.jpg", "Vanilla, milk, espresso, caramel drizzle", true],
        ["Hot Café Latte", 120, "drink/latte-pour.jpg", "Silky latte art in a mug", false],
      ]],
      ["Silog & rice meals", "kitchen", [
        ["Longsilog", 165, "food/longsilog.jpg", "Sweet longganisa, garlic rice, egg"],
        ["Pork Adobo", 185, "food/adobo.jpg", "Soy-vinegar braised pork, rice"],
        ["Sizzling Sisig", 210, "food/sisig.jpg", "Crispy pork sisig on a hot plate, egg on top"],
        ["Crispy Liempo", 220, "food/crispy-liempo.jpg", "Crunchy pork belly, atchara, rice"],
        ["Lechon Kawali", 230, "food/lechon-kawali.jpg", "Deep-fried pork, liver sauce"],
        ["Pork BBQ (3 sticks)", 150, "food/pork-bbq.jpg", "Sweet grilled skewers, java rice"],
      ]],
      ["Sabaw & ulam", "kitchen", [
        ["Sinigang na Baboy", 260, "food/sinigang.jpg", "Sour tamarind soup, good for 2"],
        ["Bulalo", 380, "food/bulalo.jpg", "Beef shank and bone marrow soup, good for 2–3"],
        ["Kare-Kare", 340, "food/kare-kare.jpg", "Peanut stew, bagoong on the side"],
        ["Pancit Canton", 220, "food/pancit.jpg", "Stir-fried noodles, good for sharing"],
      ]],
      ["Merienda", "kitchen", [
        ["Kwek-kwek", 80, "food/kwek-kwek.jpg", "Orange battered quail eggs, vinegar dip"],
        ["Grilled Eggplant Salad", 120, "food/grilled-eggplant.jpg", "Smoky eggplant, tomato, onion"],
      ]],
      ["Barkada trays", "kitchen", [
        ["Boodle Fight (good for 4)", 1299, "food/boodle-fight.jpg", "Rice, liempo, BBQ, eggplant, salted egg, on banana leaves"],
        ["Party Tray Pancit (good for 10)", 899, "food/party-tray.jpg", "Order 1 day ahead for big groups"],
      ]],
    ],
    feedback: [[5, "Ordered from the table, food came out fast. Iced Spanish latte is a must!", "Mika"], [5, "No more waving at the waiter. Love the QR menu.", "Paolo"], [4, "Sisig was great. Busy on weekends but they handled it.", "Jen"]],
    rating: [96, 452],
  },
  {
    slug: "taptayo-salon", name: "TapTayo Salon", businessType: "salon", mode: "salon",
    cover: PHOTO("salon/interior-pink.jpg"), theme: { preset: "pink", primary: "#FF3D7F" }, hours: OPEN("10:00", "20:00"),
    address: "Demo address · Metro Manila", tagline: "Hair, nails and lashes — book your slot in 30 seconds",
    settings: {
      setup: { kind: "team", ownerWorks: false, place: "both" },
      salon: { slotMinutes: 30, leadTimeHours: 1, cancelHours: 2, graceMin: 15, allowAnyone: true, maxDaysAhead: 14, tips: true, requireConfirm: false, deposit: { enabled: false, amount: 100 },
        homeService: { enabled: true, fee: 150, note: "Please prepare a chair near an outlet.", travelMin: 30, exclusive: false, areas: [{ name: "Makati", fee: 150 }, { name: "Taguig", fee: 200 }, { name: "Pasig", fee: 200 }] } },
    },
    staff: [["Ana", "Senior stylist · color & rebond", "salon/styling.jpg"], ["Bea", "Nail artist", "salon/nail-art.jpg"], ["Carla", "Stylist · cuts & blowouts", "salon/blowout.jpg"]],
    cats: [
      ["Hair", null, [
        ["Haircut & blow-dry", 350, "salon/styling.jpg", "Includes wash and styling", 45],
        ["Blowout & waves", 450, "salon/waves.jpg", "Bouncy waves for events", 45],
        ["Hair color (full)", 1500, "salon/hair-care.jpg", "Price may change for long hair", 120],
        ["Scalp treatment", 700, "salon/scalp-treatment.jpg", "Deep cleanse and massage", 60],
      ]],
      ["Nails", null, [
        ["Gel manicure", 450, "salon/nails-white.jpg", "Classic gel, lasts 2–3 weeks", 60],
        ["Nail art (per set)", 650, "salon/nails-love.jpg", "Hearts, chrome, French — bring a peg", 75],
        ["Press-on set", 550, "salon/press-on.jpg", "Custom fit, reusable", 45],
        ["Tortoise / cat-eye design", 700, "salon/nails-tortoise.jpg", "Trendy designs", 75],
      ]],
    ],
    feedback: [[5, "Booked at 11pm, got a slot the next morning. Ana is amazing!", "Trish"], [5, "Home service was on time and so neat.", "Liza"], [5, "My nails came out exactly like my peg.", "Kim"]],
    rating: [143, 667],
  },
  {
    slug: "taptayo-spa", name: "TapTayo Spa", businessType: "spa", mode: "salon",
    cover: PHOTO("spa/hammam.jpg"), theme: { preset: "spa", primary: "#7B2D8E" }, hours: OPEN("11:00", "23:00"),
    address: "Demo address · Metro Manila", tagline: "Massage, foot spa and facials — book a room or join the line",
    settings: {
      setup: { kind: "team", ownerWorks: false, place: "both" },
      salon: { slotMinutes: 30, leadTimeHours: 0, cancelHours: 2, graceMin: 15, allowAnyone: true, maxDaysAhead: 14, tips: true, requireConfirm: false, deposit: { enabled: false, amount: 100 },
        rooms: [{ id: "r1", name: "Room 1", beds: 1, active: true }, { id: "r2", name: "Room 2", beds: 1, active: true }, { id: "r3", name: "Couple room", beds: 2, active: true }], roomBufferMin: 10, allowPax2: true, genderPick: true,
        intake: { enabled: true }, queue: { enabled: true, maxPeople: 10, maxWaitMin: 120, remote: true, cutoffMin: 30, graceMin: 10 },
        homeService: { enabled: true, fee: 200, note: "Please prepare a quiet space and a clean towel.", travelMin: 30, exclusive: false, areas: [{ name: "Makati", fee: 200 }, { name: "Taguig", fee: 250 }, { name: "Pasig", fee: 250 }] } },
    },
    staff: [["Ana", "Swedish & hilot · 6 yrs", "spa/back-massage.jpg", "female"], ["Ben", "Deep tissue & sports", "spa/leg-massage.jpg", "male"], ["Cara", "Foot spa & facials", "spa/foot-massage.jpg", "female"], ["Dino", "Hot stone & shiatsu", "spa/hot-stone.jpg", "male"]],
    cats: [
      ["Massage", null, [
        ["Swedish massage (60 min)", 500, "spa/back-massage.jpg", "Relaxing full-body oil massage", 60],
        ["Hilot (90 min)", 750, "spa/leg-massage.jpg", "Traditional Filipino healing massage", 90],
        ["Deep tissue (90 min)", 850, "spa/hand-massage.jpg", "Firm pressure for tight muscles", 90],
        ["Hot stone (90 min)", 950, "spa/hot-stone-flowers.jpg", "Warm stones, slow and deep", 90],
      ]],
      ["Foot spa", null, [
        ["Foot spa & reflexology (45 min)", 350, "spa/foot-massage.jpg", "Soak, scrub and pressure points", 45],
      ]],
      ["Facial", null, [
        ["Deep-cleansing facial (60 min)", 650, "spa/facial.jpg", "Cleanse, mask and gentle massage", 60],
      ]],
      ["Add-ons", null, [
        ["Aromatherapy oil", 100, "spa/oil.jpg", "Lavender, eucalyptus or unscented", 5],
        ["Hot stones add-on (15 min)", 200, "spa/hot-stone.jpg", "Add warm stones to any massage", 15],
      ]],
    ],
    promos: [
      { name: "Relax Weekdays", type: "percent", value: 20, cats: ["Massage"], schedule: { days: ["mon", "tue", "wed", "thu"], start: "13:00", end: "17:00" } },
      { name: "Massage + Foot spa", type: "bundle", value: 699, items: ["Swedish massage (60 min)", "Foot spa & reflexology (45 min)"] },
      { name: "Couple Treat", type: "amount", value: 100, allItems: true, audience: "couple", stack: true },
      { name: "Free ride", type: "free_home_fee", value: 1000 },
    ],
    city: "Quezon City", collabs: [{ title: "Beauty creators: try our hot stone massage", details: "Honest review of our hot stone massage. Weekday afternoons.", niche: "Beauty", budgetEach: 1500, freebies: "Free 90-min massage", deliverables: "1 Reel or TikTok", slots: 2, ugc: false, onSite: true, days: 21 }],
    feedback: [[5, "Ana's hilot is the best — booked at 10pm for the same night.", "Rica"], [5, "Joined the line from home and came back right on time.", "Paolo"], [5, "Couple room was clean and quiet. Will be back!", "Jen"]],
    rating: [128, 610],
  },
  {
    slug: "taptayo-studio", name: "TapTayo Studio", businessType: "freelance", mode: "salon",
    cover: PHOTO("studio/cover.jpg"), theme: { preset: "freelance", primary: "#16A34A" }, hours: OPEN("08:00", "20:00"),
    address: "Demo · Metro Manila (on location)", tagline: "Photo, video & content for your brand — book a date or request a quote",
    settings: {
      setup: { kind: "solo", ownerWorks: true, place: "both" }, solo: { enabled: true, rider: "none" },
      salon: { slotMinutes: 60, leadTimeHours: 2, cancelHours: 48, graceMin: 15, allowAnyone: false, maxDaysAhead: 60, tips: false, requireConfirm: false, deposit: { enabled: true, amount: 500, minTotal: 0 },
        homeService: { enabled: true, fee: 500, note: "Transport fee for on-location shoots.", travelMin: 60, exclusive: false, areas: [{ name: "Metro Manila", fee: 500 }, { name: "Rizal / Cavite / Laguna", fee: 1500 }] },
        freelance: { quotes: true, dpPercent: 50, revisions: 2, terms: "• The downpayment locks the date and is non-refundable.\n• 2 revisions included; extra revisions are charged.\n• Balance is due on delivery of the final files.\n• We may post the work in our portfolio unless you ask us not to.",
          platforms: [{ platform: "TikTok", handle: "@taptayostudio", followers: "128K", url: "https://taptayo.com" }, { platform: "Instagram", handle: "@taptayostudio", followers: "46K", url: "https://taptayo.com" }, { platform: "YouTube", handle: "TapTayo Studio", followers: "22K", url: "https://taptayo.com" }],
          niches: ["Photography", "Events", "Beauty"], city: "Quezon City", pitch: "7 years shooting weddings, debuts and brands. Raw copies in 3 days, final edits in a week — you'll see the countdown on your page.", brands: ["Kape Co.", "Glow PH"], directory: true, offers: true, minFee: 2000,
          rush: { enabled: true, hours: 48, fee: 1500 }, rushMiss: "both", rushMissPct: 10, release: { mode: "both", rawDays: 3, finalDays: 7 }, requireIdOnSite: true, adult: true } },
    },
    stats: { delTotal: 31, delOnTime: 30, projectsDone: 44 }, storeExtra: { creatorVerified: true },
    portfolio: [["studio/wedding.jpg", "photo", "Santos–Reyes wedding", false, ""], ["studio/event.jpg", "photo", "Corporate launch", false, "Glow PH"], ["studio/makeup.jpg", "photo", "Makeup + portrait", false, ""], ["studio/shooting.jpg", "photo", "Product shoot", true, "Kape Co."]],
    staff: [["Migs", "Photographer & content creator · 7 yrs", "studio/dslr.jpg", "male"]],
    cats: [
      ["Shoots & sessions", null, [
        ["Portrait / product shoot (2 hours)", 3500, "studio/shooting.jpg", "Includes 20 edited photos", 120],
        ["Makeup + photo session", 4500, "studio/makeup.jpg", "Makeup, styling and 15 edited photos", 150],
      ]],
      ["Whole-day events", null, [
        ["Wedding / debut coverage (whole day)", 25000, "studio/wedding.jpg", "Photo + same-day edit video · blocks the whole day", 600],
        ["Corporate event (whole day)", 18000, "studio/event.jpg", "Photos delivered in 3 days", 600],
      ]],
      ["Content & collabs", null, [
        ["1 TikTok / Reel for your brand", 6000, "studio/creator.jpg", "Concept, shoot, edit · 2 revisions", 90],
        ["Food vlog feature", 8000, "studio/setup.jpg", "Visit, shoot and post on our channels", 120],
      ]],
      ["Add-ons", null, [
        ["Extra 10 edited photos", 1000, "studio/camera.jpg", "", 15],
      ]],
      ["Prints & products", null, [
        ["Hard copies · 10 pcs 4R prints", 500, "studio/camera.jpg", "Glossy, delivered with your final photos", 0, { retail: true, sellOnline: true, stock: 40 }],
        ["Wooden frame 8×10 with print", 650, "studio/wedding.jpg", "Your favorite shot, framed", 0, { retail: true, sellOnline: true, stock: 12 }],
        ["Printed menu layout (A4, laminated)", 350, "studio/setup.jpg", "For cafés — we lay out your product photos", 0, { retail: true, sellOnline: true }],
        ["False lashes · natural", 250, "studio/makeup.jpg", "From our makeup artist", 0, { retail: true, sellOnline: true, stock: 20 }],
        ["Colored contact lenses (1 pair)", 650, "studio/makeup.jpg", "Brown or gray · with case", 0, { retail: true, sellOnline: true, stock: 8 }],
      ]],
    ],
    feedback: [[5, "Booked a date in 2 minutes and paid the DP right there. Photos were 🔥", "Bea"], [5, "Our brand collab had a clear quote, 2 revisions, done on time.", "Kape Co."], [5, "Wedding coverage was perfect — loved tracking the deliverables.", "Paolo & Jen"]],
    rating: [41, 203],
  },
  {
    slug: "taptayo-creator", name: "Kain Tayo with Bea", businessType: "freelance", mode: "salon", logo: PHOTO("asia/creator-avatar.jpg"),
    cover: PHOTO("creator/cover.jpg"), theme: { preset: "freelance", primary: "#16A34A" }, hours: OPEN("09:00", "21:00"),
    address: "Demo · Makati (on location)", tagline: "TapTayo Creator · food & café vlogs that people actually watch",
    settings: {
      setup: { kind: "solo", ownerWorks: true, place: "both" }, solo: { enabled: true, rider: "none" },
      bookingPolicy: { refundable: false, reschedule: { allowed: true, max: 1, cutoffHours: 48, fee: 500, feeType: "fixed" } },
      salon: { slotMinutes: 60, leadTimeHours: 24, cancelHours: 48, graceMin: 15, allowAnyone: false, maxDaysAhead: 45, tips: false, requireConfirm: false, deposit: { enabled: true, amount: 1000, minTotal: 0 },
        homeService: { enabled: true, fee: 0, note: "Shoots at your café or restaurant.", travelMin: 45, exclusive: false, radiusKm: 25, base: { lat: 14.5547, lng: 121.0244 }, areas: [{ name: "Makati / BGC / Pasay", fee: 0 }, { name: "Rest of Metro Manila", fee: 500 }] },
        freelance: { quotes: true, dpPercent: 50, revisions: 1, terms: "• The downpayment locks the date and is non-refundable.\n• 1 revision on the edit before posting.\n• You approve the draft before it goes live.\n• Posting proof + views after 7 days are added here.\n• Paid ads use of the video needs the usage add-on.",
          platforms: [{ platform: "TikTok", handle: "@kaintayowithbea", followers: "120K", url: "https://taptayo.com" }, { platform: "Instagram", handle: "@kaintayowithbea", followers: "48K", url: "https://taptayo.com" }, { platform: "Facebook", handle: "Kain Tayo with Bea", followers: "30K", url: "https://taptayo.com" }, { platform: "YouTube", handle: "Kain Tayo with Bea", followers: "15K", url: "https://taptayo.com" }],
          niches: ["Food", "Lifestyle", "Family"], city: "Makati", pitch: "Honest food reviews for 120K Manila foodies. Most of my café videos pass 50K views in a week — and I'll show you the numbers after 7 days.", brands: ["Kape Tayo Café", "Lola's Lugaw", "Ube Haus"], directory: true, offers: true, minFee: 1000,
          rush: { enabled: true, hours: 24, fee: 1000 }, rushMiss: "both", rushMissPct: 15, release: { mode: "final", rawDays: 0, finalDays: 5 }, requireIdOnSite: true, adult: true, ugc: true, availability: { sideJob: "evenings & weekends", maxPerWeek: 4 }, xdeal: { on: true, minTip: 300, types: ["food", "staycation"], releaseDays: 4 } } },
    },
    stats: { delTotal: 24, delOnTime: 23, projectsDone: 31, xDone: 12, xRateSum: 59, xRateN: 12 }, storeExtra: { creatorVerified: true, kycAt: Date.now() },
    portfolio: [["asia/coffee-shot.jpg", "video", "Ube latte launch · 52K views", false, "Ube Haus"], ["asia/cafe-selfie.jpg", "video", "Café hopping vlog", false, "Lola's Lugaw"], ["creator/cover.jpg", "photo", "Café flat lay set", true, "Kape Tayo Café"], ["cafe/bright.jpg", "photo", "Interior shots", true, ""]],
    staff: [["Bea", "Food & lifestyle creator · 120K on TikTok", "asia/creator-avatar.jpg", "female"]],
    cats: [
      ["Rate card · by video length", null, [
        ["1-minute TikTok / Reel", 3500, "creator/food-phone.jpg", "Shoot at your place, edit, post on TikTok", 90],
        ["3-minute video (TikTok + FB)", 6000, "creator/vlogger.jpg", "Longer story: menu, owner, best sellers", 120],
        ["Full vlog (8–12 min, YouTube)", 12000, "creator/cover.jpg", "Sit-down review, posted on YouTube + a teaser", 180],
      ]],
      ["Add-ons", null, [
        ["Cross-post to IG + FB", 1000, "creator/food-phone.jpg", "Same video on all my pages", 0],
        ["Usage rights · 30 days for your ads", 2000, "creator/vlogger.jpg", "Run my video as your paid ad", 0],
        ["Exclusivity · no competitor posts for 2 weeks", 1500, "creator/cover.jpg", "", 0],
        ["Extra 3 IG stories", 800, "creator/food-phone.jpg", "", 0],
      ]],
    ],
    promos: [
      { name: "Monday Collab Deal", type: "percent", value: 15, allItems: true, schedule: { days: ["mon"] } },
    ],
    feedback: [[5, "📈 Our ube latte sold out 3 days straight after Bea's video. — 52K views in a week", "Ube Haus"], [5, "📈 New customers every weekend since the vlog — Lugaw sales up 40%", "Lola's Lugaw"], [5, "Clear rates, on time, and she showed the insights after 7 days.", "Kape Tayo Café"]],
    rating: [36, 178],
  },
  {
    slug: "taptayo-ugc", name: "Mika Makes UGC", businessType: "freelance", mode: "salon", logo: PHOTO("asia/ugc-avatar.jpg"),
    cover: PHOTO("asia/phone-selfie.jpg"), theme: { preset: "freelance", primary: "#16A34A" }, hours: OPEN("18:00", "22:00"),
    address: "Demo · Pasig (side job)", tagline: "TapTayo Creator · UGC videos for small brands — 1.2K followers, big results",
    settings: {
      setup: { kind: "solo", ownerWorks: true, place: "both" }, solo: { enabled: true, rider: "none" },
      bookingPolicy: { refundable: true, reschedule: { allowed: true, max: 2, cutoffHours: 24, fee: 200, feeType: "fixed" } },
      salon: { slotMinutes: 60, leadTimeHours: 24, cancelHours: 24, graceMin: 15, allowAnyone: false, maxDaysAhead: 30, tips: false, requireConfirm: false, deposit: { enabled: true, amount: 300, minTotal: 0 },
        homeService: { enabled: true, fee: 0, note: "Most UGC is shot at home — send the product.", travelMin: 30, exclusive: false, radiusKm: 15, base: { lat: 14.5764, lng: 121.0851 }, areas: [{ name: "Pasig / Mandaluyong / QC", fee: 0 }] },
        freelance: { quotes: true, dpPercent: 50, revisions: 2, terms: "• 50% downpayment, balance on delivery.\n• 2 revisions included.\n• UGC: you own the video for your page and ads for 6 months.", ugc: true, adult: true, directory: true, offers: true, minFee: 500,
          platforms: [{ platform: "TikTok", handle: "@mikamakesugc", followers: "1.2K", url: "https://taptayo.com" }, { platform: "Instagram", handle: "@mikamakesugc", followers: "860", url: "https://taptayo.com" }],
          niches: ["UGC", "Beauty", "Food"], city: "Pasig", pitch: "Small following, but my UGC videos convert: hooks in the first 2 seconds, clean product shots, captions included. You post them on your page or run them as ads.", brands: ["Glow PH", "Ube Haus"],
          rush: { enabled: true, hours: 48, fee: 400 }, rushMiss: "refund", rushMissPct: 10, availability: { sideJob: "evenings & weekends", maxPerWeek: 3 }, xdeal: { on: true, minTip: 0, types: ["food", "product", "staycation"], releaseDays: 5 } } },
    },
    stats: { delTotal: 9, delOnTime: 9, projectsDone: 9, xDone: 4, xRateSum: 20, xRateN: 4 }, storeExtra: { kycAt: Date.now() },
    portfolio: [["asia/phone-selfie.jpg", "video", "Skincare UGC · 3 hooks", true, "Glow PH"], ["asia/rooftop.jpg", "video", "Staycation rooftop reel", true, "TapTayo Airbnb"], ["creator/food-phone.jpg", "video", "Ube latte unboxing", true, "Ube Haus"], ["ugc/ringlight.jpg", "photo", "Product photos (10)", true, ""], ["ugc/phone-tripod.jpg", "video", "Talking-head review", true, ""]],
    staff: [["Mika", "UGC creator · side job (evenings & weekends)", "asia/ugc-avatar.jpg", "female"]],
    cats: [
      ["UGC rate card", null, [
        ["1 UGC video (you post it)", 800, "ugc/floor-film.jpg", "30–45 s vertical video, 2 hooks, captions", 60],
        ["3 UGC videos bundle", 2000, "ugc/phone-tripod.jpg", "Best for ads testing", 120],
        ["10 product photos", 1200, "ugc/ringlight.jpg", "Clean backgrounds, edited", 60],
      ]],
      ["Add-ons", null, [
        ["Raw footage", 300, "ugc/phone-cam.jpg", "All clips, unedited", 0],
        ["Ads usage · 3 more months", 500, "ugc/phone-cam.jpg", "", 0],
      ]],
    ],
    feedback: [[5, "📈 Her UGC ad got us 38 orders in the first week — for ₱800!", "Glow PH"], [5, "Fast, clean, and easy to work with.", "Ube Haus"]],
    rating: [9, 45],
  },
  {
    slug: "taptayo-laundry", name: "TapTayo Laundry", businessType: "laundry", mode: "laundry",
    cover: PHOTO("laundry/laundromat.jpg"), theme: { preset: "sky", primary: "#1E8BFF" }, hours: OPEN("07:00", "21:00"),
    address: "Demo address · Metro Manila", tagline: "Wash · dry · fold — book a rider pickup or drop off",
    settings: {
      service: { pickup: true, delivery: true, deliveryFee: 50, deliveryFeeMode: "fixed" },
      laundry: { minKg: 5, maxLoadKg: 8, rushMode: "percent", rushValue: 50, etaHours: 24, rushEtaHours: 6, paymentFirst: false, foldFree: true, foldFee: 0, clothesCount: false, separateWhites: true,
        storageFreeDays: 7, storageFeePerDay: 0, complaintHours: 24, loyalty: { enabled: true, everyKg: 10, freeKg: 1 },
        modes: { dropoff_pickup: true, rider_rider: true, dropoff_delivery: true, rider_pickup: true }, steps: { drying: true, folding: true } },
    },
    cats: [
      ["Wash · Dry · Fold", null, [["Wash · Dry · Fold", 45, "laundry/folded-shirts.jpg", "Detergent and fabcon included", "kg"]]],
      ["Wash only", null, [["Wash only", 30, "laundry/machines.jpg", "", "kg"]]],
      ["Dry only", null, [["Dry only", 25, "laundry/laundromat-carts.jpg", "", "kg"]]],
      ["Dry clean", null, [["Barong / suit / gown", 0, "laundry/shirts-hanging.jpg", "Quoted after inspection", "estimate"]]],
      ["Add-ons", null, [["Comforter (queen)", 180, "laundry/basket.jpg", "Per piece", "piece"], ["Pressing (per piece)", 25, "laundry/folded-jeans.jpg", "", "piece"], ["Extra fabcon", 15, "laundry/basket-woman.jpg", "", "piece"]]],
    ],
    feedback: [[5, "Rider picked up at 9, got it back folded the next day.", "Rose"], [5, "I can see if my laundry is washing or ready. Super convenient.", "Mark"], [4, "Clean and smells good.", "Joy"]],
    rating: [88, 410],
  },
  {
    slug: "taptayo-airbnb", name: "TapTayo Airbnb", businessType: "stay", mode: "stay",
    cover: PHOTO("stay/pool-tropical.jpg"), theme: { preset: "teal", primary: "#0D9488" }, hours: OPEN("00:00", "23:59"),
    address: "Demo address · Batangas", tagline: "Private pool stays — check dates and book direct",
    settings: { collab: { swap: true }, stay: { addons: [{ id: "foam", name: "Single bed foam", price: 300, per: "night", approval: true, kind: "extra", max: 2 }, { id: "blanket", name: "Extra blanket", price: 100, per: "stay", approval: true, kind: "extra", max: 3 }, { id: "pillow", name: "Extra pillows", price: 80, per: "stay", approval: true, kind: "extra", max: 4 }, { id: "towel", name: "Extra towels", price: 80, per: "stay", kind: "extra", max: 4 }, { id: "kit", name: "Toiletry kit (toothbrush, toothpaste, soap)", price: 80, per: "stay", kind: "kit", max: 6 }, { id: "slippers", name: "Slippers", price: 50, per: "stay", kind: "kit", max: 6 }],
      amenities: [{ id: "pool", name: "Swimming pool", unit: "head", price: 100 }, { id: "ktv", name: "Videoke", unit: "hour", price: 200 }, { id: "grill", name: "Grill area", unit: "stay", price: 300 }, { id: "wifi", name: "Wi-Fi", unit: "free", price: 0 }],
      nearby: [{ kind: "🏥", name: "Batangas Medical Center", mins: 12 }, { kind: "🛍️", name: "SM City Batangas", mins: 15 }, { kind: "🍔", name: "Jollibee", mins: 5 }, { kind: "🏖️", name: "Laiya Beach", mins: 25 }],
      cancel: { fullDays: 7, partialDays: 3, partialPct: 50 }, lastMinute: { enabled: true, percent: 20, after: "18:00" }, visitorLog: true, noIdOk: true, kids: { freeUnder: 7, countInPax: false },
      houseRules: "• Quiet time from 10 PM.\n• No parties. Max 2 visitors until 9 PM — log them on your booking page.\n• No smoking inside the rooms.",
      deposit: { amount: 1000, checkMinutes: 60 }, guestIds: true, selfCheck: { enabled: true, codeHoursBefore: 2 }, overstay: { enabled: true, graceMin: 15 }, loyalty: { enabled: true, every: 5, percent: 20 },
      promos: [{ id: "wk", name: "Weekday Escape", percent: 20, days: ["mon", "tue", "wed", "thu"], applies: "night" }, { id: "am", name: "Morning short stay", percent: 15, days: [], applies: "short", from: "08:00", until: "11:00" }],
      short: { enabled: true, packages: [{ hours: 1, price: 399 }, { hours: 3, price: 999 }, { hours: 6, price: 1599 }, { hours: 12, price: 2299 }], from: "08:00", until: "20:00", bufferMin: 60 } } },
    rooms: [
      ["Garden Room", "Cozy · garden view", 2, "1 queen bed", 2200, 2700, ["Aircon", "WiFi", "Hot shower", "Smart TV", "Pool access"], ["stay/garden-room.jpg", "stay/pool-palms.jpg", "stay/white-room.jpg"]],
      ["Ocean Villa", "Private deck · sea view", 4, "1 king + 1 sofa bed", 4800, 5600, ["Aircon", "WiFi", "Kitchen", "Hot shower", "Balcony", "Pool access", "Parking"], ["stay/villa-deck.jpg", "stay/ocean-pool.jpg", "stay/infinity-deck.jpg"]],
      ["Family Suite", "Spacious · good for groups", 8, "2 queen beds + 2 sofa beds", 6500, 7500, ["Aircon", "WiFi", "Kitchen", "Hot shower", "Pool access", "Parking", "Videoke"], ["stay/hotel-room.jpg", "stay/pool-tropical.jpg"]],
    ],
    feedback: [[5, "Booking was so easy, no need to message back and forth.", "Carlo"], [5, "The pool is even better in person!", "Andrea"]],
    rating: [49, 241],
  },
];

const NAMES = ["Mika R.", "Paolo S.", "Jen D.", "Carlo M.", "Trish A.", "Liza P.", "Kim T.", "Rose V.", "Mark G.", "Joy B.", "Andrea L.", "Ben C."];
const phoneOf = (i) => `0917 000 ${String(100 + i).padStart(4, "0")}`;

module.exports = function demoKit({ db, FieldValue, Timestamp, dayKey, rebuildPublicStore, MODE_DEFAULTS, PRESETS }) {
  const T = (ms) => Timestamp.fromMillis(ms);
  async function wipe(storeId) {
    for (const c of ["categories", "items", "tables", "staff", "rooms", "orders", "appointments", "stays", "feedback", "promos", "customers", "portfolio"]) {
      const snap = await db.collection(`stores/${storeId}/${c}`).get();
      for (let i = 0; i < snap.docs.length; i += 400) { const b = db.batch(); snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); }
    }
  }

  async function seedOne(D, adminUid) {
    const pub = await db.doc(`publicStores/${D.slug}`).get();
    let storeId = pub.exists ? pub.data().storeId : null;
    if (storeId && !(await db.doc(`stores/${storeId}`).get()).data()?.settings?.demo) throw new Error(`The link /m/${D.slug} is used by a real store — rename it first.`);
    const storeRef = storeId ? db.doc(`stores/${storeId}`) : db.collection("stores").doc();
    storeId = storeRef.id;
    if (pub.exists) await wipe(storeId);
    const preset = PRESETS[D.businessType];
    const now = Date.now();
    const orgId = `demo-${D.slug}`;
    await db.doc(`orgs/${orgId}`).set({ name: D.name, ownerUid: adminUid, mainStoreId: storeId, demo: true, branches: [{ storeId, name: D.name, slug: D.slug, createdAt: now }], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const base = MODE_DEFAULTS[D.mode] || {};
    await storeRef.set({
      name: D.name, slug: D.slug, businessType: D.businessType, mode: D.mode, ownerUid: adminUid, orgId, demo: true,
      logoUrl: D.logo || "https://taptayo.com/icons/icon-512.png", coverUrl: D.cover, theme: D.theme, tagline: D.tagline,
      contact: { phone: "", address: D.address, ...(D.city ? { city: D.city } : {}) }, hours: D.hours,
      settings: { currency: "PHP", labels: preset.labels, ...base, ...D.settings, tagline: D.tagline, demo: true, live: true, acceptOrders: true,
        payments: { methods: CASH }, feedback: { enabled: true, display: "all" }, onboarding: { done: {}, later: {}, tourDone: true, startedAt: now },
        ...(D.mode === "salon" ? { salon: { ...(base.salon || {}), ...(D.settings.salon || {}) } } : {}), ...(D.mode === "laundry" ? { laundry: { ...(base.laundry || {}), ...(D.settings.laundry || {}) } } : {}), ...(D.mode === "stay" ? { stay: { ...(base.stay || {}), ...(D.settings.stay || {}) } } : {}) },
      stats: { ratingSum: D.rating[1], ratingCount: D.rating[0], ...(D.stats || {}) }, ...(D.storeExtra || {}),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: false });
    await db.doc(`stores/${storeId}/subscription/current`).set({ plan: "business", status: "active", comp: true, compNote: "TapTayo demo store", paidUntil: T(now + 3650 * 86400000), addons: {}, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

    const b = db.batch();
    const items = []; const catByName = {};
    (D.cats || []).forEach(([cname, station, rows], ci) => {
      const cref = storeRef.collection("categories").doc(); catByName[cname] = cref.id;
      b.set(cref, { name: cname, sortOrder: ci + 1, active: true, ...(station ? { station } : {}), createdAt: T(now) });
      rows.forEach((r, i) => {
        const iref = storeRef.collection("items").doc();
        const it = { categoryId: cref.id, name: r[0], price: r[1], imageUrl: PHOTO(r[2]), description: r[3] || "", available: true, options: [], sortOrder: i + 1, createdAt: T(now - 30 * 86400000) };
        if (D.mode === "table" && r[4]) it.options = [{ name: "Size", required: true, multi: false, choices: [{ label: "Regular", add: 0 }, { label: "Large", add: 25 }] }, { name: "Sugar", required: false, multi: false, choices: [{ label: "Regular", add: 0 }, { label: "Less sweet", add: 0 }] }];
        if (D.mode === "salon") Object.assign(it, { durationMinutes: r[4], staffPay: { type: "percent", value: 30 }, ...(r[4] >= 480 ? { wholeDay: true } : {}) });
        if (D.mode === "laundry") it.unit = r[4];
        if (r[5] && typeof r[5] === "object") Object.assign(it, r[5], r[5].retail ? { durationMinutes: 0, wholeDay: false } : {});
        b.set(iref, it); items.push({ id: iref.id, station: station || "kitchen", ...it });
      });
    });
    for (let i = 1; i <= (D.tables || 0); i++) b.set(storeRef.collection("tables").doc(), { label: `Table ${i}`, qrToken: `demo${D.slug.slice(8, 11)}${i}`.padEnd(8, "x"), active: true, sortOrder: i, createdAt: T(now) });
    const staff = [];
    (D.staff || []).forEach(([n, bio, photo, gender], i) => { const r = storeRef.collection("staff").doc(); b.set(r, { name: n, bio, photoUrl: PHOTO(photo), ...(gender ? { gender } : {}), roles: ["stylist"], active: true, skills: [], showToCustomers: true, salary: { basicPerDay: 0, commission: true }, sortOrder: i + 1, createdAt: T(now - 90 * 86400000) }); staff.push({ id: r.id, name: n }); });
    const rooms = [];
    (D.rooms || []).forEach(([n, theme, cap, beds, price, wk, am, photos], i) => { const r = storeRef.collection("rooms").doc(); b.set(r, { name: n, theme, capacity: cap, beds, price, weekendPrice: wk, amenities: am, inventory: [{ name: "Bath towel", qty: cap, price: 350 }, { name: "Pillow", qty: cap, price: 400 }, { name: "Blanket", qty: Math.ceil(cap / 2), price: 800 }, { name: "TV / aircon remote", qty: 2, price: 500 }], passcode: "4821#", doorType: i === 1 ? "lockbox" : "smartlock", notices: i === 2 ? [{ label: "Aircon under repair — electric fan for now", percent: 25 }] : [], doorNote: "Smart lock: enter the code on the keypad, then turn the handle down.", description: `${theme}. ${beds}, up to ${cap} guests.`, photos: photos.map((p, k) => ({ url: PHOTO(p), area: k ? "Area" : "Room" })), posters: [], rules: "", active: true, sortOrder: i + 1, housekeeping: { status: "clean" }, createdAt: T(now) }); rooms.push({ id: r.id, name: n, price }); });
    (D.promos || []).forEach((p) => { const catIds = (p.cats || []).map((c) => catByName[c]).filter(Boolean); const itemIds = (p.items || []).map((nm) => items.find((x) => x.name === nm)?.id).filter(Boolean);
      b.set(storeRef.collection("promos").doc(), { name: p.name, type: p.type, value: p.value, audience: p.audience || "all", place: p.place || "any", stack: !!p.stack, allItems: !!p.allItems, categoryIds: catIds, itemIds, staffIds: [], schedule: { days: [], start: null, end: null, dateFrom: null, dateTo: null, ...(p.schedule || {}) }, active: true, validFor: "all", usedCount: 0, discountTotal: 0, createdAt: T(now) }); });
    (D.portfolio || []).forEach(([img, kind, label, ugc, brand], i) => b.set(storeRef.collection("portfolio").doc(), { creator: true, url: kind === "video" ? "https://taptayo.com/collab/" : PHOTO(img), thumb: PHOTO(img), kind, label, ugc: !!ugc, brand: brand || "", at: now - i * 86400000, by: "demo" }));
    (D.feedback || []).forEach(([rating, comment, nm], i) => b.set(storeRef.collection("feedback").doc(), { rating, comment, customerName: nm, sample: true, createdAt: T(now - (i + 1) * 2 * 86400000) }));
    await b.commit();

    // sample activity so the shop looks alive (not counted as pretend orders)
    const S = db.batch();
    const dk = (ms) => dayKey(new Date(ms));
    if (D.mode === "table") {
      const pick = (k) => items[k % items.length];
      const line = (it, q) => ({ itemId: it.id, name: it.name, price: it.price, qty: q, subtotal: it.price * q, station: it.station, options: [] });
      const live = [["pending", "dine_in", "Table 3", [0, 7]], ["preparing", "dine_in", "Table 5", [1, 8, 13]], ["preparing", "take_out", null, [2]], ["ready", "pickup", null, [4, 10]], ["completed", "dine_in", "Table 1", [0, 6]]];
      let no = 1;
      for (let d = 6; d >= 0; d--) for (let k = 0; k < (d ? 14 : 9); k++) {
        const at = now - d * 86400000 - (k + 1) * 47 * 60000; const ls = [line(pick(k + d), 1 + ((k + d) % 2)), line(pick(k * 3 + 6), 1)]; const tot = ls.reduce((a, l) => a + l.subtotal, 0);
        S.set(storeRef.collection("orders").doc(), { orderNo: no++, dayKey: dk(at), type: "table", serviceType: k % 3 ? "dine_in" : "take_out", status: "completed", tableLabel: k % 3 ? `Table ${1 + (k % 8)}` : null, items: ls, stations: Object.fromEntries(ls.map((l) => [l.station, "served"])), subtotal: tot, deliveryFee: 0, total: tot, customer: { name: NAMES[k % NAMES.length] }, source: "customer", paid: true, paymentMethod: "cash", paymentMethodName: "Cash", sample: true, createdAt: T(at), updatedAt: T(at), completedAt: T(at + 25 * 60000) });
      }
      live.forEach(([st, svc, table, idx], i) => { const ls = idx.map((x) => line(items[x % items.length], 1)); const tot = ls.reduce((a, l) => a + l.subtotal, 0); const at = now - (i + 1) * 6 * 60000;
        S.set(storeRef.collection("orders").doc(), { orderNo: no++, dayKey: dk(at), type: "table", serviceType: svc, status: st, tableLabel: table, items: ls, stations: Object.fromEntries(ls.map((l) => [l.station, st === "pending" ? "pending" : st === "completed" ? "served" : "ready"])), subtotal: tot, deliveryFee: 0, total: tot, customer: { name: NAMES[i] }, source: "customer", paid: st === "completed", paymentMethod: st === "completed" ? "cash" : null, sample: true, createdAt: T(at), updatedAt: T(at) }); });
    }
    if (D.mode === "salon") {
      const svc = (k) => items[k % items.length];
      const at = (dayOff, h, m = 0) => { const d = new Date(now + 8 * 3600e3); d.setUTCHours(h - 8, m, 0, 0); return d.getTime() + dayOff * 86400000; };
      const rows = [[0, 10, 0, "done"], [0, 11, 3, "done"], [0, 13, 1, "in_progress"], [0, 15, 4, "confirmed"], [0, 17, 5, "confirmed"], [1, 10, 2, "confirmed"], [1, 14, 6, "pending"], [2, 11, 0, "confirmed"]];
      rows.forEach(([d, h, k, st], i) => { const it = svc(k); const p = staff[i % staff.length]; const t = at(d, h);
        S.set(storeRef.collection("appointments").doc(), { code: `A-DEMO${i + 1}`, status: st, customer: { name: NAMES[i], phone: phoneOf(i) }, customerKey: phoneOf(i).replace(/\D/g, ""), items: [{ itemId: it.id, name: it.name, price: it.price, duration: it.durationMinutes, category: "" }], total: it.price, durationEst: it.durationMinutes, categories: [], providerId: p?.id || null, providerName: p?.name || null, startAt: T(t), dayKey: dk(t), notes: "", homeService: i === 4 ? { address: "Sample St., Makati", area: "Makati", fee: 150, feeConfirmed: true } : null, homeFee: i === 4 ? 150 : 0, source: "online", paid: st === "done", paymentMethod: st === "done" ? "cash" : null, tip: 0, sample: true, createdAt: T(now - 86400000), updatedAt: T(now) }); });
    }
    if (D.mode === "laundry") {
      const wdf = items[0];
      [["received", 0, 0], ["washing", 6.5, 1], ["drying", 8, 2], ["folding", 5.2, 3], ["ready", 7, 4], ["ready", 12, 5], ["claimed", 6, 6]].forEach(([st, kg, i]) => { const at = now - (i + 1) * 95 * 60000; const tot = Math.round(Math.max(5, kg) * wdf.price);
        S.set(storeRef.collection("orders").doc(), { orderNo: i + 1, dayKey: dk(at), type: "laundry", serviceType: i % 3 === 1 ? "delivery" : "pickup", status: st, items: kg ? [{ itemId: wdf.id, name: wdf.name, price: wdf.price, qty: kg, unit: "kg", subtotal: tot }] : [], stations: {}, subtotal: kg ? tot : 0, deliveryFee: 0, total: kg ? tot : 0, customer: { name: NAMES[i], phone: phoneOf(i) }, customerKey: phoneOf(i).replace(/\D/g, ""), source: "counter", paid: st === "claimed" || i % 2 === 0, paymentMethod: "cash", sample: true,
          laundry: { mode: i % 3 === 1 ? "rider_rider" : "dropoff_pickup", ticketNo: String(101 + i), claimCode: `DEMO${i}`, container: "bag", kg, loads: Math.ceil(kg / 8), pcs: null, rush: i === 2, rushFee: 0, fold: true, separateWhites: true, handWash: "", estimateOnly: !kg, etaHours: 24 }, ...(st === "ready" ? { readyAt: T(at + 3600e3) } : {}), createdAt: T(at), updatedAt: T(at) }); });
    }
    if (D.slug === "taptayo-creator") {
      const day = (n) => new Date(now + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
      const iq = storeRef.collection("inquiries");
      for (const d of (await iq.get()).docs) await d.ref.delete();
      await iq.add({ status: "negotiating", code: "Q-CAFE4", fromStoreName: "Kape Tayo Café", brief: { kind: "Brand collab / content", brand: "Kape Tayo Café", platform: "TikTok", date: day(5), deadline: day(9), location: "Kape Tayo Café, Legaspi Village, Makati", pin: "https://maps.google.com/?q=14.5566,121.0170", details: "We'd love you to feature our new Spanish latte + ube cheese pandesal.", deliverables: "1 TikTok + 3 IG stories" }, customer: { name: "Carlo (owner)", phone: "0918 111 2222", email: "" }, customerUid: "demo",
        offers: [{ from: "client", fee: 0, transpo: 1000, freebies: "Free food up to 4 pax", deliverables: "1 TikTok + 3 IG stories", notes: "Bring your crew, everything on the house!", at: now - 5 * 3600e3 }], deliverables: [], revisionsUsed: 0, createdAt: T(now - 5 * 3600e3), createdAtMs: now - 5 * 3600e3, updatedAt: T(now) });
      await iq.add({ status: "negotiating", code: "Q-LUG9", fromStoreName: "Lola's Lugaw", brief: { kind: "Brand collab / content", brand: "Lola's Lugaw", platform: "TikTok + FB", date: day(8), location: "Lola's Lugaw, Pasay", details: "Lugaw + tokwa't baboy feature for our 2nd branch opening.", deliverables: "3-minute video" }, customer: { name: "Mila", phone: "0917 333 4444", email: "" }, customerUid: "demo",
        offers: [{ from: "client", fee: 3000, transpo: 500, freebies: "Free food up to 4 pax", deliverables: "3-minute video", notes: "", at: now - 30 * 3600e3 }, { from: "creator", fee: 5000, transpo: 500, freebies: "Free food up to 4 pax", deliverables: "3-minute video + 3 IG stories", notes: "Adding stories for free 🙂", at: now - 20 * 3600e3 }], deliverables: [], revisionsUsed: 0, createdAt: T(now - 30 * 3600e3), createdAtMs: now - 30 * 3600e3, updatedAt: T(now) });
      await iq.add({ status: "in_progress", code: "Q-RUSH2", brief: { kind: "Brand collab / content", brand: "Ube Haus", platform: "TikTok", date: day(-1), location: "Ube Haus, BGC", rush: true, details: "Weekend promo video — need it up by tomorrow!", deliverables: "1-minute TikTok" }, customer: { name: "Jo of Ube Haus", phone: "0917 555 6666", email: "" }, customerUid: "demo",
        quote: { lines: [{ name: "1-minute TikTok / Reel", price: 3500 }, { name: "Rush · within 24 h", price: 1000 }], total: 4500, dpPercent: 50, revisions: 1, terms: "", note: "", date: day(-1), usage: "Organic only", rush: { hours: 24, fee: 1000, dueAt: now + 9 * 3600e3 }, validUntil: now + 7 * 86400e3, at: now - 2 * 86400e3 },
        contract: { client: "Ube Haus", lines: [{ name: "1-minute TikTok / Reel", price: 3500 }, { name: "Rush · within 24 h", price: 1000 }], total: 4500, dpPercent: 50, revisions: 1, terms: "", rush: { hours: 24, fee: 1000 }, usage: "Organic only", date: day(-1), acceptedAt: now - 40 * 3600e3 },
        dp: { amount: 2250, refNo: "7731 220 918", method: "GCash", status: "verified" }, paidAmount: 2250, revisionsUsed: 0, checkins: [{ kind: "arrived", at: now - 20 * 3600e3, pin: "", by: "Bea" }, { kind: "left", at: now - 17 * 3600e3, pin: "", by: "Bea" }],
        deliverables: [{ id: "d1", name: "1-minute TikTok", due: day(0), status: "todo", versions: [], notes: [] }], createdAt: T(now - 2 * 86400e3), createdAtMs: now - 2 * 86400e3, updatedAt: T(now) });
      await iq.add({ status: "done", code: "Q-UBE1", brief: { kind: "Brand collab / content", brand: "Ube Haus", platform: "TikTok", date: day(-20), location: "Ube Haus, BGC", details: "Ube latte launch", deliverables: "1-minute TikTok" }, customer: { name: "Jo of Ube Haus", phone: "0917 555 6666", email: "" }, customerUid: "demo",
        quote: { lines: [{ name: "1-minute TikTok / Reel", price: 3500 }, { name: "Cross-post to IG + FB", price: 1000 }], total: 4500, dpPercent: 50, revisions: 1, terms: "", note: "", date: day(-20), validUntil: now, at: now - 25 * 86400e3 }, paidAmount: 4500, revisionsUsed: 0,
        deliverables: [{ id: "d1", name: "1-minute TikTok", due: day(-17), status: "approved", deliveredAt: now - 18 * 86400e3, late: false, versions: [{ link: "https://taptayo.com", note: "Final", final: true, at: now - 18 * 86400e3 }], notes: [], post: { link: "https://taptayo.com", views: 52300, likes: 4100, at: now - 11 * 86400e3 } }],
        review: { rating: 5, result: "Ube latte sold out 3 days straight", comment: "Super pro and on time", at: now - 10 * 86400e3 }, createdAt: T(now - 25 * 86400e3), createdAtMs: now - 25 * 86400e3, updatedAt: T(now) });
    } else if (D.slug === "taptayo-ugc") {
      const iq = storeRef.collection("inquiries"); for (const d of (await iq.get()).docs) await d.ref.delete();
      const base = { kind: "xdeal", customerUid: "demo", deliverables: [], revisionsUsed: 0, offers: [], brief: { kind: "X-Deal", details: "" }, updatedAt: T(now) };
      await iq.add({ ...base, status: "negotiating", code: "X-CAFE1", item: { type: "food", desc: "Food for 2 — Spanish latte + ube cheese pandesal", value: 520 }, tipOffer: 150, minTip: 0, shipping: "talk", xDeliver: "1 vertical video (30–45 s)", instructions: "Visit any weekday afternoon. Show the latte pour and first bite. We'll post it on our page.", fromStoreName: "TapTayo Café", customer: { name: "Carlo (owner)", phone: "0918 111 2222" }, x: { log: [{ a: "sent_offer", at: now - 2 * 3600e3 }] }, createdAt: T(now - 2 * 3600e3), createdAtMs: now - 2 * 3600e3 });
      await iq.add({ ...base, status: "received", code: "X-JAM22", item: { type: "product", desc: "2 jars ube jam + cookies", value: 650 }, tipOffer: 0, shipping: "business", releaseDays: 5, xDeliver: "1 vertical video + 3 photos", instructions: "Unboxing + toast spread, natural light.", fromStoreName: "Ube Haus", customer: { name: "Jo", phone: "0917 555 6666" }, x: { sentAt: now - 3 * 86400e3, tracking: "LBC 8890 1123", receivedAt: now - 2 * 86400e3, dueAt: now + 3 * 86400e3, log: [{ a: "sent_offer", at: now - 4 * 86400e3 }, { a: "accepted", at: now - 4 * 86400e3 }, { a: "item_sent", at: now - 3 * 86400e3 }, { a: "item_received", at: now - 2 * 86400e3 }] }, createdAt: T(now - 4 * 86400e3), createdAtMs: now - 4 * 86400e3 });
      await iq.add({ ...base, status: "done", code: "X-STAY9", item: { type: "staycation", desc: "1-night staycation for 2", value: 1800 }, tipOffer: 300, shipping: "talk", releaseDays: 5, xDeliver: "1 room-tour reel", instructions: "Room tour + pool at golden hour.", fromStoreName: "TapTayo Airbnb", customer: { name: "Host", phone: "0917 000 0000" }, x: { receivedAt: now - 12 * 86400e3, submittedAt: now - 9 * 86400e3, approvedAt: now - 8 * 86400e3, releasedAt: now - 8 * 86400e3, confirmedAt: now - 7 * 86400e3, tips: [{ amount: 300, ref: "GC 7712", at: now - 7 * 86400e3, confirmed: true }], reviewByBusiness: { rating: 5, comment: "On time and the reel looks premium!", at: now - 7 * 86400e3 }, log: [] }, createdAt: T(now - 14 * 86400e3), createdAtMs: now - 14 * 86400e3 });
    } else if (D.businessType === "freelance") {
      const day = (n) => new Date(now + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
      const iq = storeRef.collection("inquiries");
      for (const d of (await iq.get()).docs) await d.ref.delete();
      await iq.add({ status: "new", code: "Q-7KX2M", brief: { kind: "Brand collab / content", brand: "Kape Co.", platform: "TikTok + IG Reels", budget: "₱15,000–₱20,000", deadline: day(12), date: "", location: "Quezon City café", details: "Launching our ube latte. Need 2 TikToks + 3 IG stories, fun and bright. We'll provide the drinks.", deliverables: "2 TikToks + 3 stories" }, customer: { name: "Rica of Kape Co.", phone: "0917 000 1111", email: "" }, customerUid: "demo", deliverables: [], revisionsUsed: 0, createdAt: T(now - 3 * 3600e3), createdAtMs: now - 3 * 3600e3, updatedAt: T(now) });
      await iq.add({ status: "in_progress", code: "Q-4PZ9A", brief: { kind: "Event coverage (whole day)", brand: "Santos–Reyes wedding", platform: "", budget: "₱25,000", deadline: "", date: day(-3), location: "Tagaytay", details: "Church + reception, same-day edit.", deliverables: "Photos + SDE video" }, customer: { name: "Jen Santos", phone: "0917 222 3333", email: "" }, customerUid: "demo",
        quote: { lines: [{ name: "Wedding coverage (whole day)", price: 25000 }, { name: "Rush same-day edit", price: 1500 }], total: 26500, dpPercent: 50, revisions: 2, terms: "", note: "", date: day(-3), validUntil: now + 7 * 86400e3, at: now - 20 * 86400e3 },
        dp: { amount: 13250, refNo: "1029 384 756", method: "GCash", status: "verified" }, paidAmount: 13250, revisionsUsed: 1,
        deliverables: [{ id: "d1", name: "Same-day edit video", due: day(-3), status: "approved", versions: [{ link: "https://taptayo.com", note: "SDE", final: true, at: now - 3 * 86400e3 }], notes: [] }, { id: "d2", name: "300 edited photos", due: day(4), status: "review", versions: [{ link: "https://taptayo.com", note: "Draft — first 150", at: now - 86400e3 }], notes: [{ from: "client", text: "Brighter please on the reception set", at: now - 2 * 86400e3 }] }, { id: "d3", name: "Photo album (print)", due: day(14), status: "todo", versions: [], notes: [] }],
        createdAt: T(now - 25 * 86400e3), createdAtMs: now - 25 * 86400e3, updatedAt: T(now) });
    }
    if (D.mode === "stay") {
      const ymd = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
      [[0, -1, 2, "checked_in"], [1, 3, 2, "confirmed"], [2, 6, 1, "pending"], [0, 10, 3, "confirmed"]].forEach(([ri, start, n, st], i) => { const r = rooms[ri]; const inMs = now + start * 86400000, outMs = inMs + n * 86400000; const nights = Array.from({ length: n }, (_, k) => ymd(inMs + k * 86400000)); const tot = r.price * n;
        S.set(storeRef.collection("stays").doc(), { code: `S-DEMO${i + 1}`, roomId: r.id, roomName: r.name, checkIn: T(inMs), checkOut: T(outMs), checkInYmd: ymd(inMs), checkOutYmd: ymd(outMs), nights, nightsCount: n, guests: 2 + i, poolGuests: 0, poolFee: 0, subtotal: tot, charges: [], total: tot, downpayment: tot / 2, paidAmount: st === "pending" ? 0 : tot / 2, payment: null, customer: { name: NAMES[i], phone: phoneOf(i) }, customerKey: phoneOf(i).replace(/\D/g, ""), noRefundAccepted: true, requests: [], status: st, needsConfirm: false, reschedule: null, extension: null, sample: true, createdAt: T(now - 5 * 86400000), updatedAt: T(now) }); });
    }
    await S.commit();
    if (D.collabs) { // demo posts on the Open Collab board
      for (const x of (await db.collection("collabs").where("storeId", "==", storeId).get()).docs) await x.ref.delete();
      for (const c of D.collabs) await db.collection("collabs").add({ title: c.title, details: c.details, niche: c.niche, city: D.city || "", budgetEach: c.budgetEach, freebies: c.freebies, deliverables: c.deliverables, deadline: new Date(now + 8 * 3600e3 + c.days * 86400e3).toISOString().slice(0, 10), slots: c.slots, ugc: c.ugc, onSite: c.onSite, storeId, storeName: D.name, storeSlug: D.slug, logoUrl: null, businessType: D.businessType, address: D.address, pin: "", status: "open", filled: 0, apps: 2, demo: true, createdAtMs: now - 86400e3, updatedAt: now });
    }
    await rebuildPublicStore(storeId);
    return { slug: D.slug, storeId };
  }

  /** remove pretend orders/bookings customers made on demo stores (older than `hours`) */
  async function cleanDemos(hours = 3) {
    const cutoff = Date.now() - hours * 3600e3; let n = 0;
    for (const D of DEMOS) {
      const pub = (await db.doc(`publicStores/${D.slug}`).get()).data(); if (!pub?.storeId) continue;
      for (const c of ["orders", "appointments", "stays", "reservations"]) {
        const snap = await db.collection(`stores/${pub.storeId}/${c}`).where("test", "==", true).get();
        const old = snap.docs.filter((d) => (d.data().createdAt?.toMillis?.() || 0) < cutoff);
        for (let i = 0; i < old.length; i += 400) { const b = db.batch(); old.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); n += Math.min(400, old.length - i); }
      }
    }
    return n;
  }
  return { DEMOS, seedOne, cleanDemos, DEMO_NOTE };
};
module.exports.DEMO_SLUGS = DEMOS.map((d) => d.slug);
