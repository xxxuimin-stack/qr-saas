// What's coming on TapTayo — one list used by the dashboard (with votes), Explore and the homepage. Only things we actually plan to ship.
export const ROADMAP = [
  { key: "reels", icon: "🎬", title: "Reels — your work on video", what: "Short vertical videos on your shop page and in Explore: before/after, a room tour, today's special. Like a video portfolio clients can swipe.", who: "all", eta: "Next" },
  { key: "gcash_auto", icon: "💸", title: "Auto-confirmed GCash / Maya payments", what: "Clients pay from the app and the booking is marked paid by itself — no more screenshots to check. TapTayo still never holds your money.", who: "all", eta: "Soon" },
  { key: "ads", icon: "📣", title: "Boost in Explore", what: "Put your shop at the top of Explore for people nearby for a few days. Pay only for the days you choose.", who: "all", eta: "Soon" },
  { key: "inventory", icon: "📦", title: "Stock & supplies", what: "Track products and supplies per branch, low-stock alerts, and what each service uses up.", who: "all", eta: "Planned" },
  { key: "memberships_online", icon: "💳", title: "Online memberships & subscriptions", what: "Sell monthly plans online — e.g. ₱999/month for unlimited blowouts or a laundry bundle — with auto reminders before each renewal.", who: "all", eta: "Planned" },
  { key: "receipt_fil", icon: "🧾", title: "Receipts in Filipino", what: "Customers pick English or Filipino for their digital receipt and order status.", who: "all", eta: "Planned" },
  { key: "pro_insurance", icon: "🛡️", title: "Freelancer protection", what: "Simple accident cover and a dispute desk for freelancer jobs booked through TapTayo.", who: "salon", eta: "Planned" },
  { key: "client_app", icon: "📱", title: "Client wallet & rebooking", what: "One place for clients to see all their bookings, loyalty cards and gift cards from every shop — and rebook in one tap.", who: "all", eta: "Planned" },
  { key: "ai_reply", icon: "🤖", title: "Auto-reply assistant", what: "Answers common Messenger questions (hours, price, availability) from your own menu and settings, and hands over to you for the rest.", who: "all", eta: "Exploring" },
];
export const roadmapFor = (mode) => ROADMAP.filter((r) => r.who === "all" || r.who === mode);
