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
 */
export class FsAdapter {
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
  async put(rel, quBit) {
    const filePath = this.#filePath(rel);
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
      // which reads a possibly-just-written collection).
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }
}
