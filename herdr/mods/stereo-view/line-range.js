// Render only the lines intersecting the viewport, plus a small overscan.
/** @param {number} count @param {number} top @param {number} offset @param {number} viewport @param {number} lineHeight @param {number} overscan */
export function lineRange(count, top, offset, viewport, lineHeight, overscan = 5) {
  const first = Math.max(0, Math.min(count, Math.floor((offset - top) / lineHeight) - overscan));
  const last = Math.max(first, Math.min(count, Math.ceil((offset + viewport - top) / lineHeight) + overscan));
  return { first, last };
}
