"use strict";

function createCreatureStrategy({ providerOrder, uniRig }) {
  return {
    id: "creature",
    probe() {
      const owned = uniRig.probe();
      return { ready: owned.ready, owned, providers: ["unirig"] };
    },
    async rig(context) {
      const failures = [];
      for (const provider of providerOrder) {
        if (provider !== "unirig") {
          failures.push(`${provider}: the creature strategy requires UniRig and does not silently substitute a humanoid rig`);
          continue;
        }
        try {
          const health = uniRig.probe();
          if (!health.ready) throw new Error(health.reason);
          return await uniRig.rig(context);
        } catch (error) {
          failures.push(`unirig: ${error.message}`);
        }
      }
      throw new Error(`${context.source.name} could not be rigged as a creature. ${failures.join(" | ")}`);
    }
  };
}

module.exports = { createCreatureStrategy };
