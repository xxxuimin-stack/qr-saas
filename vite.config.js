import { defineConfig } from "vite";
import { resolve } from "path";
import { readFileSync } from "fs";

// writes dist/version.json — open apps compare it with their own version and offer "Update"
function versionFile() {
  return {
    name: "version-file",
    generateBundle() {
      const v = (readFileSync(resolve(__dirname, "src/version.js"), "utf8").match(/APP_VERSION = "([^"]+)"/) || [])[1] || "dev";
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ v, at: new Date().toISOString() }) });
    },
  };
}

// Sa dev server, ang /app/..., /m/<slug>, /kitchen/... ay ipinapadala sa kanilang index.html
// (sa production, ginagawa ito ng "rewrites" sa firebase.json)
function multiPageFallback() {
  const roots = ["/login/", "/app/", "/m/", "/kitchen/", "/admin/", "/counter/", "/rider/", "/staff/", "/dispatch/", "/join/", "/tv/", "/help/", "/me/", "/collab/", "/terms/", "/privacy/", "/try/", "/explore/", "/pro/"];
  return {
    name: "multi-page-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url.split("?")[0];
        for (const root of roots) {
          if (url.startsWith(root) && !url.slice(root.length).includes(".")) {
            req.url = root + "index.html" + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");
            break;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [multiPageFallback(), versionFile()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        login: resolve(__dirname, "login/index.html"),
        app: resolve(__dirname, "app/index.html"),
        menu: resolve(__dirname, "m/index.html"),
        kitchen: resolve(__dirname, "kitchen/index.html"),
        admin: resolve(__dirname, "admin/index.html"),
        counter: resolve(__dirname, "counter/index.html"),
        rider: resolve(__dirname, "rider/index.html"),
        staff: resolve(__dirname, "staff/index.html"),
        dispatch: resolve(__dirname, "dispatch/index.html"),
        join: resolve(__dirname, "join/index.html"),
        tv: resolve(__dirname, "tv/index.html"),
        help: resolve(__dirname, "help/index.html"),
        me: resolve(__dirname, "me/index.html"),
        collab: resolve(__dirname, "collab/index.html"),
        try: resolve(__dirname, "try/index.html"),
        explore: resolve(__dirname, "explore/index.html"),
        pro: resolve(__dirname, "pro/index.html"),
        tryScreen: resolve(__dirname, "try/screen.html"),
      },
    },
  },
});
