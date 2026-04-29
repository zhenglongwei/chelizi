const path = require('path');

/**
 * Minimal module registry (v1).
 * - Keeps server.js as the composition root
 * - Each module exports { manifest, registerRoutes(app, ctx) }
 *
 * ctx is provided by server.js and can include pool, auth middlewares,
 * capability helpers, response helpers, and shared services.
 */

function getBuiltinModules() {
  // Start with an explicit list; later this can be env-driven or filesystem-discovered.
  return [
    require(path.join(__dirname, 'AccidentAssistant_v1')),
    require(path.join(__dirname, 'DiagnosticAssistant_v1')),
    require(path.join(__dirname, 'ValueModules_v1')),
  ];
}

function registerAllModules(app, ctx) {
  const modules = getBuiltinModules();
  const manifests = [];
  for (const m of modules) {
    if (!m || typeof m !== 'object') continue;
    if (m.manifest) manifests.push(m.manifest);
    if (typeof m.registerRoutes === 'function') {
      m.registerRoutes(app, ctx);
    }
  }
  return { modules: manifests };
}

module.exports = {
  registerAllModules,
};

