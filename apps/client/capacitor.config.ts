import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.codexnest.app",
  appName: "CodexNest",
  webDir: "dist",
  server: {
    androidScheme: "http",
    hostname: "localhost",
  },
  android: {
    minWebViewVersion: 83,
  },
};

export default config;
