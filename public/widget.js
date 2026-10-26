/* TapTayo booking button for any website.
   <script src="https://taptayo.com/widget.js" data-shop="your-link" data-label="Book now" data-color="#C62828" async></script>
   Adds a floating button (bottom-right) that opens your TapTayo page. data-position="left" moves it left;
   data-inline="#element-id" puts a normal button inside that element instead. */
(function () {
  var s = document.currentScript || document.querySelector('script[src*="widget.js"][data-shop]'); if (!s) return;
  var shop = (s.getAttribute("data-shop") || "").toLowerCase().replace(/[^a-z0-9-]/g, ""); if (!shop) return;
  var label = s.getAttribute("data-label") || "Book now", color = /^#[0-9a-fA-F]{3,8}$/.test(s.getAttribute("data-color") || "") ? s.getAttribute("data-color") : "#C62828";
  var url = "https://taptayo.com/m/" + shop + "?utm_source=widget&utm_medium=" + encodeURIComponent(location.hostname || "site");
  var a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; a.setAttribute("aria-label", label + " (opens TapTayo)");
  var base = "display:inline-flex;align-items:center;gap:8px;padding:14px 22px;border-radius:999px;background:" + color + ";color:#fff;font:600 16px/1 system-ui,-apple-system,Segoe UI,sans-serif;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.18);";
  var inline = s.getAttribute("data-inline"), host = inline && document.querySelector(inline);
  if (host) { a.style.cssText = base; host.appendChild(a); return; }
  a.style.cssText = base + "position:fixed;bottom:20px;" + (s.getAttribute("data-position") === "left" ? "left" : "right") + ":20px;z-index:2147483000;";
  (document.body || document.documentElement).appendChild(a);
})();
