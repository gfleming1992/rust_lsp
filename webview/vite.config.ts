import { defineConfig } from "vite";

export default defineConfig({
  server: {
    open: false
  },
  build: {
    target: "es2020"
  }
});
