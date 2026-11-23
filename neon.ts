import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  // Managed Better Auth is provisioned on the default branch's seosa_auth database.
  // This does not switch existing SEOSA users or API bearer tokens to Neon Auth.
  // Review `neon config plan` before applying on any other branch.
  auth: true,
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
