import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发模式：Vite 起在 5199，/api 反代到后端 3199
// 生产模式：npm run build 后由 Express 直接托管 dist，单端口 3199
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3199",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
