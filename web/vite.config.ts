import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = process.env.VITE_DEV ? Number(process.env.VITE_DEV) : 5173;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`VITE_DEV must be a port number, got "${process.env.VITE_DEV}"`);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    // An explicitly requested port shouldn't silently fall back to another one.
    strictPort: process.env.VITE_DEV !== undefined,
    proxy: { "/api": "http://127.0.0.1:4747" },
  },
});
