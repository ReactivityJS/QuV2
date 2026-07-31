import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

const CONTENT_TYPES = { '.quapp': 'application/json', '.js': 'text/javascript', '.json': 'application/json' };

/**
 * Serves the files under `appsDir` as static HTTP, so OTHER relays can
 * `QuLoader.loadRemote()` the apps THIS relay hosts (e.g.
 * `GET /apps/forum/manifest.quapp`, `GET /apps/forum/index.js`).
 *
 * This is intentionally a hand-rolled ~20-line handler, not a dependency on
 * a web framework - a relay only ever needs to serve a small, known set of
 * static files (plus the WebSocket upgrade handled separately), so pulling
 * in a full HTTP framework for that would be more surface area than the
 * job requires.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} appsDir
 * @returns {Promise<boolean>} Whether this handler served the request.
 */
export async function serveApps(req, res, appsDir) {
  if (!req.url.startsWith('/apps/')) return false;

  // Reject any path that could escape appsDir via '..' segments before ever touching the filesystem.
  const relative = normalize(decodeURIComponent(req.url.slice('/apps/'.length))).replace(/^(\.\.(\/|\\|$))+/, '');
  if (relative.split(sep).includes('..')) {
    res.writeHead(400).end('Bad Request');
    return true;
  }

  const ext = relative.slice(relative.lastIndexOf('.'));
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    res.writeHead(404).end('Not Found');
    return true;
  }

  try {
    const body = await readFile(join(appsDir, relative));
    res.writeHead(200, { 'content-type': contentType, 'access-control-allow-origin': '*' }).end(body);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('Not Found');
    else {
      console.error('[serveApps]', err);
      res.writeHead(500).end('Internal Server Error');
    }
  }
  return true;
}
