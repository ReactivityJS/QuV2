/**
 * UNWRAP — strips the QuBit envelope ({path, val, ts, pub, sig}) down to the
 * plain value apps actually want. This is the concrete mechanism behind
 * "Services hide storage details": QuStore always deals in QuBits (see
 * @qu/core), but nothing above the Service layer should ever need to know
 * that a value arrived wrapped in one.
 */

/**
 * @param {*} quBitOrValue
 * @returns {*} `.val` if this looks like a QuBit, otherwise the input unchanged.
 */
export function unwrap(quBitOrValue) {
  if (quBitOrValue && typeof quBitOrValue === 'object' && 'val' in quBitOrValue && 'ts' in quBitOrValue) {
    return quBitOrValue.val;
  }
  return quBitOrValue;
}

/** @param {Array<*>} list @returns {Array<*>} Each element run through unwrap(). */
export function unwrapAll(list) {
  return list.map(unwrap);
}
