/**
 * QU CORE — public entry point of the kernel package.
 *
 * Re-exports everything an app or Engine needs to talk to the kernel:
 * QuCore (the store + static crypto access), QuCrypto, QuMount, QuEvents,
 * QuStore, VolatileAdapter and the QuBit helpers/typedefs.
 */
import { QuCrypto } from './crypto.js';
import { QuMount } from './mount.js';
import { QuEvents } from './events.js';
import { QuStore } from './store.js';
import { VolatileAdapter } from './adapters/volatile.js';
import { QUBIT_FIELDS, isQuBit, createQuBit } from './qubit.js';

/**
 * QuCore is the concrete kernel instance apps interact with. It is just
 * QuStore with static crypto access attached for convenience - there is
 * intentionally no other behaviour here. Domain concepts live in
 * @qu/engines and @qu/services, never here.
 */
export class QuCore extends QuStore {
  static crypto = QuCrypto;
}

export { QuCrypto, QuMount, QuEvents, QuStore, VolatileAdapter, QUBIT_FIELDS, isQuBit, createQuBit };
