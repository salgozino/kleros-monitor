// vitest.config.mjs — test runner configuration for kleros-monitor.
// Sets minimal required env vars so config.mjs module-level exports
// do not throw during test collection. Tests exercise loadConfig() directly.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Provide baseline env for module-level config.mjs initialization.
    // Individual tests call loadConfig() with their own isolated envs.
    env: {
      WORKDIR: "/tmp/kleros-test",
      COURT_ID: "34",
      KLEROS_JUROR_HOME: "/tmp/kleros-test-home",
    },
  },
});
