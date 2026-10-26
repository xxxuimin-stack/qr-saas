// SOURCE OF TRUTH for presets. When changing anything here, update src/presets.js too.
const PRESETS = {
  cafe: {
    mode: "table",
    labels: { items: "Menu", unit: "Table", order: "Order" },
    categories: ["Drinks", "Food", "Desserts"],
    theme: { preset: "taptayo" },
  },
  restaurant: {
    hidden: true,
    mode: "table",
    labels: { items: "Menu", unit: "Table", order: "Order" },
    categories: ["Appetizers", "Mains", "Drinks", "Desserts"],
    theme: { preset: "taptayo", primary: "#C62828" },
  },
  salon: {
    mode: "salon",
    labels: { items: "Services", unit: "Chair", order: "Appointment" },
    categories: ["Hair", "Hair extension", "Lashes", "Brows", "Nails", "Aesthetic"],
    theme: { preset: "pink", primary: "#FF3D7F" },
  },
  spa: {
    mode: "salon",
    labels: { items: "Services", unit: "Room", order: "Booking", staff: "Therapist" },
    categories: ["Massage", "Foot spa", "Body scrub", "Facial", "Add-ons"],
    theme: { preset: "spa", primary: "#7B2D8E" },
  },
  makeup: {
    mode: "salon",
    labels: { items: "Services", unit: "Chair", order: "Booking", staff: "Artist" },
    categories: ["Makeup"],
    theme: { preset: "pink", primary: "#FF3D7F" },
  },
  tattoo: {
    mode: "salon",
    labels: { items: "Services", unit: "Chair", order: "Booking", staff: "Artist" },
    categories: ["Tattoo"],
    theme: { preset: "pink", primary: "#111111" },
  },
  freelance: {
    hidden: true,
    mode: "salon",
    labels: { items: "Services", unit: "Booking", order: "Booking", staff: "Team member" },
    categories: ["Shoots & sessions", "Whole-day events", "Content & collabs", "Add-ons"],
    theme: { preset: "freelance", primary: "#16A34A" },
  },
  clinic: {
    hidden: true,
    mode: "booking",
    labels: { items: "Services", unit: "Appointment", order: "Booking" },
    categories: ["Consultation", "Treatment", "Aesthetic"],
    theme: { primary: "#2f6fb2" },
  },
  products: {
    hidden: true,
    mode: "table",
    labels: { items: "Products", unit: "Order", order: "Order" },
    categories: ["Bestsellers", "New arrivals", "Bundles"],
    theme: { preset: "taptayo", primary: "#EA580C" },
  },
  stay: {
    mode: "stay",
    labels: { items: "Rooms", unit: "Room", order: "Booking" },
    categories: [],
    theme: { preset: "teal", primary: "#0D9488" },
  },
  laundry: {
    mode: "laundry",
    labels: { items: "Services", unit: "Ticket", order: "Job" },
    categories: ["Wash · Dry · Fold", "Wash only", "Dry only", "Dry clean", "Add-ons"],
    theme: { preset: "sky", primary: "#1E8BFF" },
  },
};

// Default settings per mode
const MODE_DEFAULTS = {
  table: {
    acceptOrders: true,
    reservations: { enabled: true, maxPax: 12, requirePhone: true },
    service: { dineIn: true, takeOut: true, pickup: false, delivery: false, deliveryFee: 0 },
  },
  booking: {
    acceptOrders: true,
    booking: { slotMinutes: 30, requireStaff: true, leadTimeHours: 2 },
  },
  pickup: {
    acceptOrders: true,
    pickup: { requirePhone: true, turnaroundHours: 24 },
  },
  salon: {
    acceptOrders: true,
    salon: { slotMinutes: 30, leadTimeHours: 2, cancelHours: 2, graceMin: 15, allowAnyone: true, maxDaysAhead: 14, tips: true, requireConfirm: false, deposit: { enabled: false, amount: 100 } },
    policies: { salon: "• Please arrive 5 minutes before your appointment. A 15-minute grace period applies; after that your slot may be given to the next client.\n• Cancel or reschedule at least 2 hours before your appointment.\n• Repeated no-shows may require a reservation fee for future bookings.\n• Final price may vary depending on hair length / condition or add-ons agreed during the service.\n• For chemical services (color, rebond, lash extensions), please inform us of any allergies." },
  },
  stay: {
    acceptOrders: true,
    stay: { checkIn: "14:00", checkOut: "12:00", downPct: 50, weekendNights: ["fri", "sat"], holidays: [], pool: { mode: "included", price: 0 }, extension: { enabled: true, pricePerHour: 300, maxHours: 6 }, requireId: true, maxNights: 14, maxDaysAhead: 180,
      policy: "• Check-in 2:00 PM · Check-out 12:00 NN.\n• A downpayment is required to confirm your booking. NO REFUND for cancellations; you may reschedule once, subject to approval.\n• Maximum guests per room as stated. No parties or loud music after 10 PM.\n• Guests are responsible for damages and lost keys.\n• Smoking only in designated areas." },
    waiver: { text: "I confirm that the information I gave is true. I will follow the house rules and I am responsible for my group's safety, including in the pool and other areas, and for any damage to the property during our stay." },
  },
  laundry: {
    acceptOrders: true,
    service: { pickup: false, delivery: false, deliveryFee: 0, deliveryFeeMode: "counter" },
    laundry: {
      minKg: 5, maxLoadKg: 8, rushMode: "percent", rushValue: 50, etaHours: 24, rushEtaHours: 6,
      paymentFirst: false, foldFree: true, foldFee: 0, clothesCount: false, separateWhites: true,
      storageFreeDays: 7, storageFeePerDay: 0, complaintHours: 24, loyalty: { enabled: false, everyKg: 10, freeKg: 1 },
      modes: { dropoff_pickup: true, rider_rider: true, dropoff_delivery: true, rider_pickup: true },
      steps: { drying: true, folding: true },
    },
    policies: { laundry: "• Please present your claim stub (claim code) when picking up. No stub, no release — the stub may be presented by anyone you send.\n• Minimum load applies. Final price is computed after weighing at the shop.\n• Check pockets before drop-off; we are not liable for items left in garments.\n• Some garments need extra washing — we recommend the extra wash / hand wash service for better results. Stains are not guaranteed to be removed.\n• We are not liable for color bleeding, shrinkage or damage from the garment's own condition or care label.\n• Complaints are accepted within 24 hours after claiming, with a photo.\n• Items not claimed within the free storage period may incur a storage fee; unclaimed items after 60 days may be disposed of or donated." },
  },
};

const TRIAL_DAYS = 14;
const TRIAL_LIMITS = { tables: 10, staff: 3, items: 100 };

module.exports = { PRESETS, MODE_DEFAULTS, TRIAL_DAYS, TRIAL_LIMITS };
