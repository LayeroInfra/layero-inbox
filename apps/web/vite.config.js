import { defineConfig } from "vite";

// Один проект: лендинг на /, кабинет на /dashboard/.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: "index.html", dashboard: "dashboard/index.html" },
    },
  },
});
