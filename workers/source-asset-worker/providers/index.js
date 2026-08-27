"use strict";

const { createTrellis2Provider } = require("./trellis2");
const { createMeshyProvider } = require("./meshy");

function providerOrder(env = process.env) {
  const legacy = String(env.COMIC30_ASSET_WORKER_PROVIDER || "").trim();
  const configured = String(env.COMIC30_ASSET_PROVIDER_ORDER || legacy || "trellis2,meshy");
  return [...new Set(configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function createProviderRegistry(env = process.env) {
  const available = {
    trellis2: createTrellis2Provider(env),
    meshy: createMeshyProvider(env)
  };
  const ordered = providerOrder(env).map((id) => available[id]).filter(Boolean);
  return {
    ordered,
    unknown: providerOrder(env).filter((id) => !available[id]),
    async health() {
      const providers = [];
      for (const provider of ordered) providers.push({ id: provider.id, label: provider.label, configured: provider.configured, ...(await provider.probe()) });
      return providers;
    },
    async generate(context) {
      const failures = [];
      for (const provider of ordered) {
        const health = await provider.probe();
        if (!health.ready) {
          failures.push(`${provider.id}: ${health.reason}`);
          continue;
        }
        try {
          return await provider.generate(context);
        } catch (error) {
          failures.push(`${provider.id}: ${error.message}`);
        }
      }
      throw new Error(`No source-asset provider completed ${context.requirement.name}. ${failures.join(" ")}`);
    }
  };
}

module.exports = { createProviderRegistry, providerOrder };
