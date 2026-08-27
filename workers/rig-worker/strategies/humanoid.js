"use strict";

function createHumanoidStrategy({ providerOrder, uniRig, meshifyFallback, fallbackConfigured }) {
  return {
    id: "humanoid",
    probe() {
      const owned = uniRig.probe();
      const fallback = {
        ready: Boolean(fallbackConfigured),
        reason: fallbackConfigured ? null : "Meshy humanoid fallback is not configured."
      };
      return {
        ready: owned.ready || fallback.ready,
        owned,
        fallback,
        providers: ["unirig", "meshy-fallback"]
      };
    },
    async rig(context) {
      const failures = [];
      for (const provider of providerOrder) {
        try {
          if (provider === "unirig") {
            const health = uniRig.probe();
            if (!health.ready) throw new Error(health.reason);
            return await uniRig.rig(context);
          }
          if (provider === "meshy") return await meshifyFallback(context.source, context.sourceBuffer);
          failures.push(`${provider}: unknown humanoid rig provider`);
        } catch (error) {
          failures.push(`${provider}: ${error.message}`);
        }
      }
      throw new Error(`${context.source.name} could not be rigged as a humanoid. ${failures.join(" | ")}`);
    }
  };
}

module.exports = { createHumanoidStrategy };
