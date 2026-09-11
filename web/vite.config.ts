import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 构建产物在 web/dist，后端在同一个端口把它当静态目录托管。
// base 保持默认 '/'，不使用路由库（服务端只对 '/' 做 SPA fallback）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn 组件按约定从 "@/components/ui/*" 引入。
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发时把 /api 代理到控制面；生产由后端同源提供。
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
