// THEMES — chosen by the owner in Settings. Each theme: colors, header gradient, decorations, default banner.
// To add a theme, just add an entry here.
export const THEMES = {
  // TapTayo defaults per business type (new stores start here)
  taptayo:   { name: "TapTayo Red", primary: "#C62828", accent: "#FDECEC", price: "#B91C1C", header: ["#C62828", "#991B1B"], ink: "#ffffff", decor: [], banner: "" },
  pink:      { name: "Salon Pink",  primary: "#FF3D7F", accent: "#FFE4EE", price: "#E11D63", header: ["#FF3D7F", "#E11D63"], ink: "#ffffff", decor: [], banner: "" },
  sky:       { name: "Laundry Blue", primary: "#1E8BFF", accent: "#E3F0FF", price: "#1D6FD6", header: ["#1E8BFF", "#1D6FD6"], ink: "#ffffff", decor: [], banner: "" },
  spa:       { name: "Spa Plum",    primary: "#7B2D8E", accent: "#F5E8F8", price: "#6A1F7B", header: ["#8E3AA3", "#5E1F6E"], ink: "#ffffff", decor: [], banner: "" },
  freelance: { name: "Creator Green", primary: "#16A34A", accent: "#DCFCE7", price: "#15803D", header: ["#22C55E", "#15803D"], ink: "#ffffff", decor: [], banner: "" },
  teal:      { name: "Stay Teal",   primary: "#0D9488", accent: "#E6FAF6", price: "#0F766E", header: ["#0D9488", "#0F766E"], ink: "#ffffff", decor: [], banner: "" },
  classic:   { name: "Classic",   primary: "#1f6f5f", accent: "#e9b949", price: "#e8622c", header: ["#1f6f5f", "#17594c"], ink: "#ffffff", decor: [], banner: "" },
  midnight:  { name: "Midnight",  primary: "#2b2d5c", accent: "#ffb347", header: ["#1b1d3a", "#2b2d5c"], ink: "#ffffff", decor: [], banner: "" },
  sunset:    { name: "Sunset",    primary: "#c2410c", accent: "#fde68a", header: ["#7c2d12", "#ea580c"], ink: "#ffffff", decor: [], banner: "" },
  forest:    { name: "Forest",    primary: "#2f5d3a", accent: "#d9c27a", header: ["#1f3d27", "#3b7a4b"], ink: "#ffffff", decor: [], banner: "" },
  rose:      { name: "Rosé",      primary: "#9d2d4f", accent: "#ffd6e0", header: ["#6b1b35", "#b83a63"], ink: "#ffffff", decor: [], banner: "" },
  coffee:    { name: "Café Teal", primary: "#2b6777", accent: "#ffd34d", price: "#e8622c", header: ["#1f4f5e", "#3c8f9e"], ink: "#ffffff", decor: [], banner: "" },
  ocean:     { name: "Ocean",     primary: "#0e6ba8", accent: "#9be7ff", header: ["#07486f", "#1289c9"], ink: "#ffffff", decor: [], banner: "" },
  mono:      { name: "Mono",      primary: "#16181a", accent: "#e2e4df", header: ["#16181a", "#2b2e31"], ink: "#ffffff", decor: [], banner: "" },
  // salon / beauty
  blush:     { name: "Blush 💗",     primary: "#d6336c", accent: "#ffd6e7", header: ["#f783ac", "#d6336c"], ink: "#ffffff", decor: ["💗", "✨"], banner: "", soft: true },
  lavender:  { name: "Lavender 💜",  primary: "#7048e8", accent: "#e5dbff", header: ["#9775fa", "#5f3dc4"], ink: "#ffffff", decor: ["💜", "✨"], banner: "", soft: true },
  peach:     { name: "Peach 🍑",     primary: "#e8590c", accent: "#ffe8cc", header: ["#ffa94d", "#e8590c"], ink: "#ffffff", decor: ["🍑", "🌸"], banner: "", soft: true },
  mint:      { name: "Mint 🌿",      primary: "#0ca678", accent: "#c3fae8", header: ["#63e6be", "#0ca678"], ink: "#083d2f", decor: ["🌿", "✨"], banner: "", soft: true },
  noir:      { name: "Noir Gold ✨",  primary: "#1a1a1a", accent: "#e6b422", header: ["#1a1a1a", "#3a3a3a"], ink: "#f5e6b8", decor: ["✨"], banner: "", soft: true },
  sakura:    { name: "Sakura 🌸",    primary: "#c2255c", accent: "#ffdeeb", header: ["#faa2c1", "#c2255c"], ink: "#ffffff", decor: ["🌸", "🌸"], banner: "", soft: true },
  // seasonal
  halloween: { name: "Halloween 🎃", primary: "#4a1d6e", accent: "#ff8a00", header: ["#2d0f4a", "#f08a1d"], ink: "#ffffff", decor: ["🎃", "👻", "🕸️", "🦇", "🍬"], banner: "🎃 Happy Halloween! 👻" },
  christmas: { name: "Christmas 🎄", primary: "#8b1e2d", accent: "#f2c94c", header: ["#0f4d2a", "#8b1e2d"], ink: "#ffffff", decor: ["🎄", "❄️", "🎅", "🎁", "⭐"], banner: "🎄 Merry Christmas from all of us! ❄️" },
  valentine: { name: "Valentine 💘", primary: "#b91c4b", accent: "#ffd1dc", header: ["#7a0f35", "#e0457b"], ink: "#ffffff", decor: ["💘", "💖", "🌹", "💝"], banner: "💘 Happy Valentine's! Treat someone special." },
  fiesta:    { name: "Fiesta 🎉",   primary: "#d9480f", accent: "#ffe066", header: ["#1971c2", "#d9480f"], ink: "#ffffff", decor: ["🎉", "🎊", "🎈", "🪅"], banner: "🎉 Fiesta time! Thanks for visiting." },
  summer:    { name: "Summer ☀️",   primary: "#0ca678", accent: "#ffe066", header: ["#0ca678", "#fcc419"], ink: "#ffffff", decor: ["☀️", "🌴", "🍉", "🌊"], banner: "☀️ Summer specials available!" },
};

// SEASONAL THEMES — a quick on/off from the dashboard Overview. Only the customer menu and the
// customer status page change; the store's normal theme comes back when it's turned off.
export const SEASONS = {
  halloween:  { name: "Halloween", icon: "🎃", v: { bg: "#FFF6EC", brand: "#3B1F4A", accent: "#E8730C", soft: "#FCE9D6", price: "#B8520A", line: "#F2DEC8" }, g: "linear-gradient(160deg,#2A1236 0%,#5A2D6E 55%,#E8730C 100%)", d: ["🎃", "👻", "🕸️", "🦇"], r: "🎃 Happy Halloween from {store}! 👻", f: ["🎃", "🦇", "👻", "🕸️", "🍬", "🎃"] },
  christmas:  { name: "Christmas", icon: "🎄", v: { bg: "#F6FAF6", brand: "#14532D", accent: "#C62828", soft: "#E6F2E8", price: "#B71C1C", line: "#D9E9DC" }, g: "linear-gradient(160deg,#0E3B21 0%,#1E6B3A 55%,#C62828 100%)", d: ["🎄", "🎁", "⭐", "❄️"], r: "🎄 Merry Christmas from {store}! 🎁", f: ["❄️", "❄️", "❄️", "⭐", "🎄", "🎁"] },
  valentines: { name: "Valentine's", icon: "💝", v: { bg: "#FFF5F8", brand: "#9D174D", accent: "#E11D48", soft: "#FCE7EF", price: "#BE123C", line: "#F7D6E2" }, g: "linear-gradient(160deg,#831843 0%,#BE185D 55%,#FB7185 100%)", d: ["💝", "🍫", "💕", "🌹"], r: "💕 Happy Valentine’s Day! 💕", f: ["💕", "❤️", "💗", "🌹", "💖"] },
  newyear:    { name: "New Year", icon: "🎆", v: { bg: "#F7F6FB", brand: "#1E1B4B", accent: "#C9970C", soft: "#EEEBFA", price: "#7A5C00", line: "#E2DEF2" }, g: "linear-gradient(160deg,#0F0C29 0%,#302B63 60%,#C9970C 100%)", d: ["🎆", "🥂", "🎇", "✨"], r: "🎆 Happy New Year from {store}! 🥂", f: ["✨", "🎉", "🎆", "🥂", "✨"] },
  party:      { name: "Party / 18+", icon: "🍻", v: { bg: "#F4FAF9", brand: "#155E6E", accent: "#E07A5F", soft: "#E3F2F0", price: "#C0563B", line: "#D4E8E5" }, g: "linear-gradient(135deg,#123C4A 0%,#1F6F7C 55%,#E58E6C 100%)", d: ["🍻", "🎉", "🪩", "🥂"], r: "🎉 Party time! Please drink responsibly 🍻", f: ["🎉", "🍻", "🪩", "✨", "🥂", "🎶"] },
  cny:        { name: "Chinese New Year", icon: "🧧", v: { bg: "#FFF7F0", brand: "#9B111E", accent: "#D4A017", soft: "#FCEBD9", price: "#B3121F", line: "#F3D9C4" }, g: "linear-gradient(160deg,#6E0A12 0%,#C41E3A 58%,#E0A100 100%)", d: ["🧧", "🏮", "🏮", "🍊"], r: "🧧 Gong Xi Fa Cai! Happy Chinese New Year 🏮", f: ["🧧", "🏮", "🍊", "✨", "🧧"] },
};

/** Resolve the store's theme: preset + overrides (primary, banner, decor on/off) + seasonal theme on top */
export function resolveTheme(theme = {}, storeName = "") {
  // old café stores were created with a brown brand color — show them the new café look instead
  if (!theme.preset && theme.primary === "#6b4f3a") theme = { ...theme, preset: "coffee", primary: "" };
  const base = THEMES[theme.preset] || THEMES.classic;
  const t = {
    preset: theme.preset || "classic",
    name: base.name,
    primary: theme.primary || base.primary,
    accent: base.accent,
    price: base.price || theme.primary || base.primary,
    header: base.header,
    grad: null,
    ink: base.ink,
    decor: theme.decor === false ? [] : base.decor,
    float: [],
    soft: !!base.soft,
    banner: theme.banner != null && theme.banner !== "" ? theme.banner : theme.bannerOff ? "" : base.banner,
    season: null,
  };
  const S = SEASONS[theme.season];
  if (S) Object.assign(t, {
    season: theme.season, name: S.name, primary: S.v.brand, accent: S.v.accent, price: S.v.price, bg: S.v.bg, softBg: S.v.soft, line: S.v.line,
    header: [S.v.brand, S.v.accent], grad: S.g, ink: "#ffffff", decor: S.d, float: S.f,
    banner: S.r.replace("{store}", storeName || "us"),
  });
  return t;
}

/** Apply the CSS variables to an element (document.documentElement by default) */
export function applyTheme(theme, el = document.documentElement, storeName = "") {
  const t = resolveTheme(theme, storeName);
  el.style.setProperty("--primary", t.primary);
  el.style.setProperty("--price", t.price);
  el.style.setProperty("--head-grad", t.grad || `linear-gradient(135deg, ${t.header[0]}, ${t.header[1]})`);
  for (const [k, v] of [["--paper", t.bg], ["--soft-bg", t.softBg], ["--mist", t.line]]) { if (v) el.style.setProperty(k, v); else el.style.removeProperty(k); }
  if (el === document.documentElement) document.body?.classList.toggle("season", !!t.season);
  if (el === document.documentElement) document.body?.classList.toggle("theme-soft", t.soft);
  el.style.setProperty("--accent", t.accent);
  el.style.setProperty("--head-from", t.header[0]);
  el.style.setProperty("--head-to", t.header[1]);
  el.style.setProperty("--head-ink", t.ink);
  return t;
}
