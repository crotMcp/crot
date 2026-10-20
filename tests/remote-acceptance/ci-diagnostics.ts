/** Public check annotations remain readable when Actions log downloads require an extra permission. */
import { beforeEach, onTestFailed } from "vitest";
beforeEach(() => {
  if (!process.env.GITHUB_ACTIONS) return;
  onTestFailed(({ task }) => {
    for (const error of task.result?.errors ?? []) {
      const message = String(error.message)
        .replace(/[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g, "[redacted JWT]")
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .slice(-3500)
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A");
      console.log(`\n::error title=WP-32/WP-38 acceptance diagnostic::${message}`);
    }
  });
});
