/**
 * DEPENDENCY RESOLVER — turns a package's `requires` list into a safe load
 * order, and turns "we forgot to load something" into one clear error
 * instead of a runtime `Registry: no service named "..."` deep inside some
 * unrelated App.
 *
 * Scope, on purpose:
 *   - Resolves by NAME PRESENCE, not semver ranges. Two Engines named
 *     "document-engine" can't coexist in one Registry anyway (Registry
 *     rejects duplicate names), so "is it registered" is already a
 *     meaningful check. Real semver range resolution (multiple versions
 *     side-by-side, version conflict resolution) is a much bigger feature
 *     with real trade-offs (which version wins? do Engines need to be
 *     version-isolated?) - adding it before there is a second version of
 *     any Engine in the wild would be speculative complexity. This resolver
 *     is intentionally the smallest thing that makes remote/third-party
 *     loading safe today; it can grow into real version resolution later
 *     without changing its public shape.
 *   - Detects circular `requires` and reports the exact cycle.
 *   - Treats anything already present in the Registry as satisfied without
 *     re-loading it - built-in Engines registered by @qu/relay at boot don't
 *     need their own manifest to be "required" by an App.
 */
export class DependencyResolver {
  /** @param {import('./registry.js').Registry} registry */
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * Computes the load order for `targetManifest`, given the pool of
   * manifests that are available to satisfy its (transitive) `requires`.
   *
   * @param {import('./manifest.js').Manifest} targetManifest
   * @param {import('./manifest.js').Manifest[]} availableManifests - Candidate
   *   packages that could be loaded to satisfy dependencies (e.g. every
   *   manifest.quapp found in a local `packages/` directory, or a resolved
   *   remote package index). Each manifest satisfies its own `name`, plus
   *   any name listed in its `provides`.
   * @returns {import('./manifest.js').Manifest[]} Manifests in the order
   *   they must be loaded (dependencies first), ending with `targetManifest`.
   *   Manifests already satisfied by the Registry are NOT included.
   * @throws {Error} On a missing dependency or a circular `requires` chain.
   */
  resolve(targetManifest, availableManifests = []) {
    const byProvidedName = new Map();
    for (const manifest of availableManifests) {
      const names = manifest.provides?.length ? manifest.provides : [manifest.name];
      for (const name of names) {
        if (!byProvidedName.has(name)) byProvidedName.set(name, manifest);
      }
    }
    if (!byProvidedName.has(targetManifest.name)) {
      byProvidedName.set(targetManifest.name, targetManifest);
    }

    const order = [];
    const inProgress = new Set(); // names currently on the DFS stack, for cycle detection
    const done = new Set();

    const visit = (manifest, chain) => {
      if (done.has(manifest.name)) return;
      if (inProgress.has(manifest.name)) {
        throw new Error(
          `DependencyResolver: circular "requires" chain: ${[...chain, manifest.name].join(' -> ')}`
        );
      }
      inProgress.add(manifest.name);

      for (const dep of manifest.requires ?? []) {
        if (this.registry.has(dep)) continue; // already satisfied by something loaded earlier
        const depManifest = byProvidedName.get(dep);
        if (!depManifest) {
          throw new Error(
            `DependencyResolver: "${manifest.name}" requires "${dep}", but nothing registered or ` +
              `available provides it. Available: ${Array.from(byProvidedName.keys()).join(', ') || '(none)'}`
          );
        }
        visit(depManifest, [...chain, manifest.name]);
      }

      inProgress.delete(manifest.name);
      done.add(manifest.name);
      order.push(manifest);
    };

    visit(targetManifest, []);
    return order;
  }
}
