import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.NIGHTFALL_BACKEND_URL || "http://127.0.0.1:8000";
  const proxy = Object.fromEntries(
    [
      "/app/state",
      "/state",
      "/health",
      "/profile",
      "/tree",
      "/setup",
      "/voice",
      "/samples",
      "/sse",
      "/ws",
      "/cam",
      "/enroll",
      "/door",
      "/arm",
      "/answer",
      "/agent",
      "/ack",
      "/brief/",
      "/takeover",
      "/say",
      "/event",
      "/reset",
      "/out",
      "/frames",
      "/robert.svg",
      "/audio",
      "/advance",
    ].map((path) => [path, { target, changeOrigin: true, ws: path === "/ws" }]),
  );
  return {
    base: "/ui/",
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy },
    build: { outDir: "../static/ui", emptyOutDir: true },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
      css: true,
    },
  };
});
