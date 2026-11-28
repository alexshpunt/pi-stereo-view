/** Run one startup prune and hold every writer until it finishes. @param {() => Promise<unknown>} run */
export function createImagePruner(run) {
  let pending;
  return () => pending ??= Promise.resolve().then(run).catch(() => {});
}
