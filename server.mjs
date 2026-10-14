import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, chmod } from 'node:fs';
import { open, mkdir, rename, unlink, lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));
const defaultDataFile = join(root, 'data', 'appointments.json');
const staticAssets = new Map([
  ['/images/foods/pizza.jpg', 'foods/pizza.jpg'],
  ['/images/foods/matcha.jpg', 'foods/matcha.jpg'],
  ['/images/foods/burger.jpg', 'foods/burger.jpg'],
  ['/images/foods/baasto.jpg', 'foods/baasto.jpg'],
  ['/images/foods/tacos.jpg', 'foods/tacos.jpg'],
  ['/images/foods/ubax.jpg', 'foods/ubax.jpg'],
  ['/images/restaurants/mado-official.png', 'restaurants/mado-official.png'],
  ['/images/restaurants/paparoti-owner-upload.jpeg', 'restaurants/paparoti-owner-upload.jpeg'],
  ['/images/restaurants/6-sano-guuro-wacan-anniversary.jpeg', 'restaurants/6-sano-guuro-wacan-anniversary.jpeg'],
  ['/images/restaurants/carshi-owner-upload.jpeg', 'restaurants/carshi-owner-upload.jpeg'],
  ['/images/restaurants/dilek-owner-upload.jpeg', 'restaurants/dilek-owner-upload.jpeg'],
  ['/images/restaurants/karmel-owner-upload.jpeg', 'restaurants/karmel-owner-upload.jpeg'],
  ['/images/restaurants/elite-owner-upload.png', 'restaurants/elite-owner-upload.png']
]);
const dataFile = resolve(process.env.APPOINTMENTS_FILE || defaultDataFile);
const isDefaultStore = dataFile === resolve(defaultDataFile);
const port = Number(process.env.PORT || 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const publicUrl = new URL(process.env.PUBLIC_URL || `http://localhost:${port}`);
if (!['http:', 'https:'].includes(publicUrl.protocol) || !publicUrl.hostname || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
  throw new Error('PUBLIC_URL must be a public origin without credentials, path, query, or fragment.');
}
if (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') {
  throw new Error('PUBLIC_URL must use HTTPS in production.');
}
const publicOrigin = publicUrl.origin;
const trustedProxies = new Set((process.env.TRUSTED_PROXY_IPS || '').split(',').map(value => value.trim()).filter(Boolean));
if ([...trustedProxies].some(value => !isIP(value))) throw new Error('TRUSTED_PROXY_IPS must contain comma-separated IP addresses.');
if (process.env.NODE_ENV === 'production' && trustedProxies.size === 0) throw new Error('TRUSTED_PROXY_IPS must identify the HTTPS-terminating reverse proxy in production.');
const invitationTtlMs = 180 * 24 * 60 * 60 * 1000;
const maxBodyBytes = 4096;
const foodOptions = new Set(['Pizza', 'Matcha', 'Burger', 'Baasto', 'Tacos', 'Ubax']);
const locationOptions = new Set(['Paparoti', 'Mado', 'Carshi', 'Dilek', 'Karmel', 'Elite']);
const timeOptions = new Set(['12:00 Duhur', '2:00 Galab', '4:00 Galab', '6:00 Fiid', '7:00 Fiid', '8:00 Fiid']);

const hashToken = token => createHash('sha256').update(token, 'ascii').digest();
const newToken = () => randomBytes(32).toString('base64url');
const normalizeIp = ip => ip?.startsWith('::ffff:') ? ip.slice(7) : ip;

function clientAddress(req) {
  const peer = normalizeIp(req.socket.remoteAddress || 'unknown');
  if (!trustedProxies.has(peer)) return peer;
  const chain = (req.headers['x-forwarded-for'] || '').split(',').map(value => value.trim());
  const candidate = normalizeIp(chain.at(-1));
  return isIP(candidate) ? candidate : peer;
}

const windows = new Map();
function rateLimit(req, res, bucket, maximum, durationMs) {
  const now = Date.now();
  if (windows.size > 10000) {
    for (const [key, value] of windows) if (value.resetAt <= now) windows.delete(key);
    while (windows.size > 10000) windows.delete(windows.keys().next().value);
  }
  const key = `${clientAddress(req)}:${bucket}`;
  let entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + durationMs };
    windows.set(key, entry);
  }
  entry.count++;
  if (entry.count <= maximum) return true;
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
  json(res, 429, { error: 'Too many requests. Please wait and try again.' });
  return false;
}

async function readAppointments() {
  let handle;
  try {
    // Node's POSIX mode bits do not manage Windows directory ACLs, and chmod
    // may fail for directories there. Keep the owner-only mode on POSIX; on
    // Windows use the directory's inherited ACLs instead.
    if (isDefaultStore && process.platform !== 'win32') {
      await chmod(dirname(dataFile), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const pathInfo = await lstat(dataFile);
    if (pathInfo.isSymbolicLink()) throw new Error('Invalid data store.');
    handle = await open(dataFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Invalid data store.');
    await handle.chmod(0o600);
    const data = JSON.parse(await handle.readFile('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid data store.');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  } finally {
    await handle?.close();
  }
}

async function saveAppointments(appointments) {
  const directory = dirname(dataFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempFile = join(directory, `.appointments-${randomUUID()}.tmp`);
  if (isDefaultStore && process.platform !== 'win32') await chmod(directory, 0o700);
  let handle;
  try {
    handle = await open(tempFile, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(appointments));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempFile, dataFile);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}

let mutationQueue = Promise.resolve();
function mutateAppointments(change) {
  const operation = mutationQueue.then(async () => {
    const appointments = await readAppointments();
    const result = await change(appointments);
    await saveAppointments(appointments);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function secureHeaders(res, nonce) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'${process.env.NODE_ENV === 'production' ? '; upgrade-insecure-requests' : ''}`);
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function bodyJson(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) throw fail(415, 'Send JSON using the application/json content type.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Invalid JSON request body.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'JSON request body must be an object.');
  return value;
}

function exactKeys(data, expected) {
  const keys = Object.keys(data);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(data, key))) throw fail(400, 'Request contains invalid fields.');
}

function safeChoice(value, choices) {
  return typeof value === 'string' && value === value.normalize('NFC').trim() && choices.has(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function presentedToken(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const token = match[1];
  const decoded = Buffer.from(token, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === token ? token : null;
}

function canonicalToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const decoded = Buffer.from(token, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === token;
}

function safeEqualHash(stored, actual) {
  if (typeof stored !== 'string' || !/^[0-9a-f]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), actual);
}

function findByToken(records, actualHash) {
  let match = null;
  for (const appointment of Object.values(records)) {
    const inviteMatch = safeEqualHash(appointment?.inviteHash, actualHash);
    const manageMatch = safeEqualHash(appointment?.manageHash, actualHash);
    if (inviteMatch) match = { appointment, role: 'invite' };
    if (manageMatch) match = { appointment, role: 'organizer' };
  }
  return match;
}

function publicAppointment(appointment) {
  return { id: appointment.id, date: appointment.date, time: appointment.time, location: appointment.location, food: appointment.food, creator: appointment.creator, recipient: appointment.recipient, status: appointment.status, updatedAt: appointment.updatedAt };
}

function requestOrigin(req) {
  const peer = normalizeIp(req.socket.remoteAddress || '');
  const trustedProxy = trustedProxies.has(peer);
  // Forwarded authority is only meaningful when it came from a configured proxy.
  const forwardedHost = trustedProxy ? req.headers['x-forwarded-host'] : null;
  const host = (forwardedHost || req.headers.host || '').split(',').at(-1).trim();
  const forwardedProto = trustedProxy ? (req.headers['x-forwarded-proto'] || '').split(',').at(-1).trim().toLowerCase() : '';
  const protocol = forwardedProto === 'https' ? 'https:' : forwardedProto === 'http' ? 'http:' : req.socket.encrypted ? 'https:' : 'http:';
  if (!host || /[\s\u0000-\u001f/@\\]/.test(host)) return null;
  try {
    const candidate = new URL(`${protocol}//${host}`);
    if (candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) return null;
    return candidate.origin;
  } catch {
    return null;
  }
}

function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-site requests are not allowed.');
  const origin = req.headers.origin;
  if (origin && origin !== publicOrigin && origin !== requestOrigin(req)) throw fail(403, 'Request origin is not allowed.');
}

function secureTransport(req) {
  if (process.env.NODE_ENV !== 'production') return true;
  const peer = normalizeIp(req.socket.remoteAddress || '');
  if (!trustedProxies.has(peer)) return false;
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',').at(-1)?.trim().toLowerCase();
  return forwardedProto === 'https';
}

const server = createServer(async (req, res) => {
  const nonce = randomBytes(18).toString('base64');
  secureHeaders(res, nonce);
  if (!rateLimit(req, res, 'all', 120, 60_000)) return;
  if (!secureTransport(req)) return json(res, 400, { error: 'Use the configured HTTPS endpoint.' });

  try {
    const url = new URL(req.url, publicOrigin);
    if (url.origin !== publicOrigin) throw fail(400, 'Invalid request target.');
    if (url.pathname.startsWith('/api/') && url.search) throw fail(400, 'API query parameters are not allowed.');
    const staticAsset = staticAssets.get(url.pathname);
    if (staticAsset) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw fail(405, 'Method not allowed.');
      }
      const image = await readFile(join(root, 'public', 'images', staticAsset));
      const contentType = staticAsset.endsWith('.png') ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': image.length, 'Cache-Control': 'public, max-age=86400, immutable' });
      return res.end(req.method === 'HEAD' ? undefined : image);
    }
    if (url.pathname.startsWith('/images/')) throw fail(404, 'Not found.');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /api/appointments') {
      if (!rateLimit(req, res, 'create', 8, 15 * 60_000)) return;
      checkOrigin(req);
      const data = await bodyJson(req);
      exactKeys(data, ['date', 'time', 'food', 'location']);
      if (!validDate(data.date) || !safeChoice(data.time, timeOptions) || !safeChoice(data.food, foodOptions) || !safeChoice(data.location, locationOptions)) {
        throw fail(400, 'Choose a valid date, time, food, and location.');
      }
      const inviteToken = newToken();
      const manageToken = newToken();
      const now = new Date();
      const appointment = {
        id: randomUUID(), inviteHash: hashToken(inviteToken).toString('hex'), manageHash: hashToken(manageToken).toString('hex'),
        date: data.date, time: data.time, location: data.location, food: data.food, creator: 'Website visitor', recipient: null,
        status: 'pending', updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + invitationTtlMs).toISOString()
      };
      await mutateAppointments(records => { records[appointment.id] = appointment; });
      return json(res, 201, { appointment: publicAppointment(appointment), invitationUrl: `${publicOrigin}/#invite=${encodeURIComponent(inviteToken)}`, manageUrl: `${publicOrigin}/#manage=${encodeURIComponent(manageToken)}` });
    }

    if (['GET /api/appointment', 'POST /api/appointment/respond', 'POST /api/appointment/cancel'].includes(route)) {
      if (!rateLimit(req, res, 'token', 60, 60_000)) return;
      if (req.method === 'POST') checkOrigin(req);
      const token = presentedToken(req);
      if (!token) throw fail(401, 'A valid invitation or organizer link is required.');
      const records = await readAppointments();
      const match = findByToken(records, hashToken(token));
      if (!match) throw fail(404, 'This invitation could not be found.');
      const { appointment, role } = match;
      if (appointment.expiresAt && (!Number.isFinite(Date.parse(appointment.expiresAt)) || Date.parse(appointment.expiresAt) <= Date.now())) {
        throw fail(410, 'This invitation has expired.');
      }
      if (route === 'GET /api/appointment') return json(res, 200, { appointment: publicAppointment(appointment), isOrganizer: role === 'organizer' });
      if (route === 'POST /api/appointment/respond') {
        if (role !== 'invite') throw fail(403, 'Organizer links cannot respond as the invitee.');
        const data = await bodyJson(req);
        exactKeys(data, ['status']);
        if (!['accepted', 'declined'].includes(data.status)) throw fail(400, 'Choose accept or decline.');
        const updated = await mutateAppointments(currentRecords => {
          const current = currentRecords[appointment.id];
          if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) throw fail(410, 'This invitation has expired.');
          if (current.status === 'cancelled') throw fail(409, 'This appointment has been cancelled.');
          if (current.status !== 'pending' && current.status !== data.status) throw fail(409, `This appointment is already ${current.status}.`);
          current.status = data.status;
          current.updatedAt = new Date().toISOString();
          return current;
        });
        return json(res, 200, { appointment: publicAppointment(updated) });
      }
      if (role !== 'organizer') throw fail(403, 'Only the organizer can cancel this appointment.');
      const data = await bodyJson(req);
      exactKeys(data, ['status']);
      if (data.status !== 'cancelled') throw fail(400, 'Organizer can only cancel the appointment.');
      const updated = await mutateAppointments(currentRecords => {
        const current = currentRecords[appointment.id];
        if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) throw fail(410, 'This invitation has expired.');
        current.status = 'cancelled';
        current.updatedAt = new Date().toISOString();
        return current;
      });
      return json(res, 200, { appointment: publicAppointment(updated) });
    }

    const allowedMethods = {
      '/api/appointments': 'POST',
      '/api/appointment': 'GET',
      '/api/appointment/respond': 'POST',
      '/api/appointment/cancel': 'POST'
    };
    if (allowedMethods[url.pathname]) {
      res.setHeader('Allow', allowedMethods[url.pathname]);
      throw fail(405, 'Method not allowed.');
    }
    if (url.pathname.startsWith('/api/')) throw fail(404, 'Not found.');
    if (req.method === 'GET' && url.pathname === '/') {
      const invites = url.searchParams.getAll('invite');
      const managers = url.searchParams.getAll('manage');
      const legacyInvite = invites[0];
      const legacyManage = managers[0];
      if (invites.length || managers.length) {
        if (invites.length + managers.length !== 1 || !canonicalToken(legacyInvite || legacyManage)) throw fail(400, 'Invalid invitation link.');
        const role = legacyInvite ? 'invite' : 'manage';
        res.writeHead(302, { Location: `/#${role}=${encodeURIComponent(legacyInvite || legacyManage)}` });
        return res.end();
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw fail(405, 'Method not allowed.');
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') throw fail(404, 'Not found.');
    const html = await readFile(join(root, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : html.replace(/<(style|script)(?=[\s>])/g, `<$1 nonce="${nonce}"`));
  } catch (error) {
    if (error.status) return json(res, error.status, { error: error.message });
    // Never write exception text, request paths, tokens, or stored appointment data to logs.
    console.error('Request failed while processing an application operation.');
    return json(res, 500, { error: 'Could not save or load the appointment. Please try again.' });
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Choose another port by setting PORT (for example, PORT=4001) and run npm start again.`);
  } else {
    console.error(`The server could not start${error.code ? ` (${error.code})` : ''}. Check the port and network configuration.`);
  }
  // A failed listen has no useful work to keep this process alive for. Exit only
  // this server process so a port collision cannot leave npm start hanging.
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  const localUrl = `http://localhost:${port}/`;
  const publicNotice = process.env.NODE_ENV === 'production' ? ` Public URL: ${publicOrigin}/` : '';
  console.log(`Somali Date Proposal listening on port ${port}. Local URL: ${localUrl}${publicNotice}`);
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 120;
