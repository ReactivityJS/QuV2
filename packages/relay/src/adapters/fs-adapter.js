import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * FS ADAPTER — Node.js filesystem persistence. Stores each QuBit as one
 * JSON file, mirroring the path structure on disk (`/a/b/c` -> `<base>/a/b/c.json`).
 * Simple, human-inspectable, good enough for a single relay's local data;
 * swap for a real database adapter if you outgrow it - QuStore never knows
 * the difference.
 *
 * Two correctness properties `put()` guarantees that a naive
 * `fs.writeFile()` does not - both found by a real end-to-end push-delivery
 * test triggering two synced writes to the SAME path (a collection's
 * `create()` immediately followed by its own `addItem()`) in quick
 * succession, which corrupted the file on disk:
 *
 *   1. ATOMIC writes - `fs.writeFile()` alone is open+write+close; two
 *      overlapping calls to the same path can interleave at the OS level,
 *      producing a file that's neither the old nor the new value (often
 *      not even valid JSON). Writing to a uniquely-named temp file first,
 *      then `rename()`-ing it into place, is safe because POSIX rename is
 *      atomic - a concurrent reader always sees either the complete old
 *      file or the complete new one, never a mix.
 *   2. ORDERING - fixing #1 alone would still let two concurrent writers
 *      finish in EITHER order, so the "later" logical write (by content,
 *      e.g. addItem()'s updated list) could still lose to the "earlier"
 *      one (create()'s empty list) if that one simply finishes its I/O
 *      second. Every QuBit carries a monotonic `ts` (see @qu/core's
 *      createQuBit()) - `put()` reads the CURRENT on-disk value first and
 *      skips writing if it's already at least as new, so final state
 *      always reflects the logically-latest write regardless of I/O
 *      completion order.
 *   3. SERIALIZATION - point 2's own read-then-write is ITSELF a
 *      check-then-act race if two `put()` calls for the SAME path overlap:
 *      both can read the same "current" value before either has written,
 *      both pass the ts-guard, and whichever finishes its write second
 *      physically wins regardless of which call's `ts` was actually
 *      newer - silently reverting a later write back to an earlier one.
 *      Confirmed by a real adversarial test (two writes to the same
 *      collection path issued in quick succession by a single client -
 *      `createThread()`'s empty-collection write immediately followed by
 *      `postMessage()`'s `addItem()` write - lost the second write more
 *      often than not). `#putLocked()` below is the actual read+write
 *      body; `put()` chains calls for the SAME path through
 *      `#writeLocks` so only one is ever in flight per path - calls for
 *      DIFFERENT paths still run fully in parallel.
 */
export class FsAdapter {
  #writeLocks = new Map(); // filePath -> tail of the promise chain serializing put() calls to that path

  /** @param {string} [basePath='./qu-store'] */
  constructor(basePath = './qu-store') {
    this.basePath = basePath;
  }

  #filePath(rel) {
    return join(this.basePath, rel.replace(/^\//, '')) + '.json';
  }

  async #ensureDir(filePath) {
    await fs.mkdir(dirname(filePath), { recursive: true });
  }

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>} `quBit` (even if a newer value already on
   *   disk won the race and this write was skipped - see class doc
   *   comment point 2 - the CALLER wrote this value, so it's what they get
   *   back; `get()` immediately after may show something else).
   */
  put(rel, quBit) {
    const filePath = this.#filePath(rel);
    const previousTail = this.#writeLocks.get(filePath) ?? Promise.resolve();
    // Chained via `.then(fn, fn)` (not `.finally()`) so a REJECTED previous
    // write never poisons this one - each put() must still get its own
    // fair attempt regardless of whether an earlier one for this path failed.
    const thisWrite = previousTail.then(
      () => this.#putLocked(rel, filePath, quBit),
      () => this.#putLocked(rel, filePath, quBit)
    );
    this.#writeLocks.set(filePath, thisWrite);
    // Once this write settles, only remove the map entry if nothing newer
    // has replaced it in the meantime (a later put() for the same path may
    // already be the current tail) - otherwise we'd drop a still-pending
    // chain and let a future call start unserialized.
    thisWrite.finally(() => {
      if (this.#writeLocks.get(filePath) === thisWrite) this.#writeLocks.delete(filePath);
    });
    return thisWrite;
  }

  async #putLocked(rel, filePath, quBit) {
    await this.#ensureDir(filePath);

    const current = await this.get(rel);
    if (current && typeof current.ts === 'number' && typeof quBit.ts === 'number' && current.ts > quBit.ts) {
      return quBit; // a logically newer value is already stored - don't overwrite it with an older one
    }

    // Temp-file-then-rename: the ONLY safe way to make a multi-writer-syscall
    // operation (write bytes, THEN make them visible at the real path) atomic.
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(quBit), 'utf8');
    await fs.rename(tempPath, filePath);
    return quBit;
  }

  /**
   * @param {string} rel
   * @returns {Promise<object|null>}
   */
  async get(rel) {
    try {
      return JSON.parse(await fs.readFile(this.#filePath(rel), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // A reader can legitimately observe a mid-rename moment (file briefly
      // absent) or, on filesystems without atomic rename guarantees, a
      // torn write from BEFORE this fix - treat either as "nothing usable
      // here yet" rather than crashing the caller (see push delivery,
      // which reads a possibly-just-written collection). Still log it: a
      // genuinely corrupted file on disk looks identical to "never
      // written" to every caller otherwise, and that's worth knowing about.
      if (err instanceof SyntaxError) {
        console.error(`[FsAdapter] corrupt JSON at ${this.#filePath(rel)}: ${err.message}`);
        return null;
      }
      throw err;
    }
  }
}
