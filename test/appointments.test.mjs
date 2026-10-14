import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Script } from 'node:vm';

class TestElement {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classes.has(name) : force;
        if (enabled) this.classes.add(name); else this.classes.delete(name);
        return enabled;
      }
    };
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  async click() { if (!this.disabled) return this.listeners.get('click')?.({ currentTarget: this }); }
  querySelectorAll(selector) { return selector === '.choice' ? this.children.filter(child => child.classList.contains('choice')) : []; }
}

test('browser code parses and has no inline event or style attributes', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'inline browser script should exist');
  assert.doesNotThrow(() => new Script(script));
  assert.doesNotMatch(html, /\sonclick\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  for (const value of ['Pizza', 'Matcha', 'Burger', 'Baasto', 'Tacos', 'Ubax', 'Paparoti', 'Mado', 'Carshi', 'Dilek', 'Karmel', 'Elite']) {
    assert.ok(script.includes(`value: "${value}"`), `the existing ${value} value should stay in the selection data`);
  }
  assert.match(script, /Text wordmark · logo unverified/);
  assert.match(script, /Official logo verified/);
});

test('food and restaurant selection, continue, appointment creation, and WhatsApp sharing work', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const elements = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new TestElement(id));
  for (const [, , id] of html.matchAll(/<section class="(screen(?: active)?)" id="([^"]+)"/g)) {
    const section = elements.get(id);
    for (const name of id === 'food' ? ['screen', 'active'] : ['screen']) section.classList.add(name);
  }
  const askSubmit = new TestElement('ask-submit');
  const document = {
    getElementById: id => elements.get(id),
    createElement: tagName => Object.assign(new TestElement(), { tagName }),
    querySelectorAll: selector => selector === '.screen' ? [...elements.values()].filter(element => element.classList.contains('screen')) : [],
    querySelector: selector => selector === '#ask .answers button' ? askSubmit : null
  };
  const clipboard = [];
  const opened = [];
  let createdPayload;
  const invitationToken = 'i'.repeat(43);
  const manageToken = 'm'.repeat(43);
  const context = {
    document,
    location: { hash: '', origin: 'http://localhost' },
    navigator: { clipboard: { writeText: async value => { clipboard.push(value); } } },
    window: { open: value => { opened.push(value); } },
    alert: message => { throw new Error(`Unexpected alert: ${message}`); },
    confirm: () => true,
    fetch: async (path, options) => {
      createdPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        appointment: { id: 'test-id', ...createdPayload, status: 'pending' },
        invitationUrl: `http://localhost/#invite=${invitationToken}`,
        manageUrl: `http://localhost/#manage=${manageToken}`
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
    URL,
    URLSearchParams,
    console
  };
  new Script(script).runInContext((await import('node:vm')).createContext(context));

  const foodGrid = elements.get('foodChoices');
  const placeGrid = elements.get('places');
  assert.equal(foodGrid.children.length, 6);
  assert.equal(placeGrid.children.length, 6);
  const pizza = foodGrid.children.find(button => button.children[1].textContent === 'Pizza');
  const burger = foodGrid.children.find(button => button.children[1].textContent === 'Burger');
  await pizza.click();
  await burger.click();
  assert.equal(pizza.getAttribute('aria-pressed'), 'false');
  assert.equal(burger.getAttribute('aria-pressed'), 'true');
  await pizza.click();
  const restaurant = placeGrid.children.find(button => button.children[1].textContent === 'Carshi');
  await restaurant.click();
  await elements.get('nextFoodButton').click();
  assert.equal(elements.get('date').classList.contains('active'), true, 'Sii wad advances after valid selections');
  elements.get('day').value = '2027-02-10';
  elements.get('time').value = '6:00 Fiid';
  await elements.get('nextDateButton').click();
  assert.equal(elements.get('ask').classList.contains('active'), true);
  await elements.get('yesButton').click();
  assert.deepEqual(createdPayload, { food: 'Pizza', location: 'Carshi', date: '2027-02-10', time: '6:00 Fiid' });
  assert.equal(elements.get('yes').classList.contains('active'), true);
  await elements.get('whatsappButton').click();
  const whatsapp = new URL(opened[0]);
  assert.equal(whatsapp.origin, 'https://wa.me');
  assert.match(whatsapp.searchParams.get('text'), /Date: 2027-02-10/);
  assert.match(whatsapp.searchParams.get('text'), /Location: Carshi/);
  assert.match(whatsapp.searchParams.get('text'), new RegExp(invitationToken));
  await elements.get('copyButton').click();
  assert.equal(clipboard[0], `http://localhost/#invite=${invitationToken}`);
});

test('authorization, validation, rate limiting, expiry, and cross-device status flow', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'date-proposal-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const storePath = join(dir, 'appointments.json');
  const publicUrl = `http://127.0.0.1:${port}`;
  const existingInvite = randomBytes(32).toString('base64url');
  const existingManage = randomBytes(32).toString('base64url');
  const existingId = randomUUID();
  await writeFile(storePath, JSON.stringify({
    [existingId]: {
      id: existingId,
      inviteHash: createHash('sha256').update(existingInvite).digest('hex'),
      manageHash: createHash('sha256').update(existingManage).digest('hex'),
      date: '2027-02-10', time: '6:00 Fiid', location: 'Paparoti', food: 'Matcha',
      creator: 'Website visitor', recipient: null, status: 'accepted', updatedAt: new Date().toISOString()
    }
  }));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), PUBLIC_URL: publicUrl, APPOINTMENTS_FILE: storePath },
    stdio: 'inherit'
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  });

  const base = publicUrl;
  let ready = false;
  let startupResponse = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(base); ready = response.ok; startupResponse = `${response.status}: ${await response.text()}`; if (ready) break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(ready, true, `server should start (${startupResponse})`);

  const page = await fetch(base);
  const policy = page.headers.get('content-security-policy');
  const pageHtml = await page.text();
  assert.match(policy, /script-src 'nonce-[^']+'/);
  assert.match(pageHtml, /<style nonce="[^"]+">/);
  assert.match(pageHtml, /<script nonce="[^"]+">/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  for (const asset of [
    '/images/foods/pizza.jpg', '/images/foods/matcha.jpg', '/images/foods/burger.jpg',
    '/images/foods/baasto.jpg', '/images/foods/tacos.jpg', '/images/foods/ubax.jpg',
    '/images/restaurants/mado-official.png'
  ]) {
    const image = await fetch(`${base}${asset}`);
    assert.equal(image.status, 200, `${asset} should be served`);
    assert.match(image.headers.get('content-type'), /^image\/(?:jpeg|png)$/);
    assert.ok((await image.arrayBuffer()).byteLength > 1000);
  }
  assert.equal((await fetch(`${base}/images/../data/appointments.json`)).status, 404, 'unlisted image paths must not expose files');
  assert.equal((await fetch(`${base}/data/appointments.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/appointment`, { method: 'OPTIONS' })).status, 405);
  const legacyLink = await fetch(`${base}/?invite=${existingInvite}`, { redirect: 'manual' });
  assert.equal(legacyLink.status, 302);
  assert.equal(legacyLink.headers.get('location'), `/#invite=${existingInvite}`);

  const create = (data, headers = {}) => fetch(`${base}/api/appointments`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: publicUrl, ...headers }, body: JSON.stringify(data)
  });
  const initial = { date: '2027-02-10', time: '6:00 Fiid', location: 'Paparoti', food: 'Matcha' };
  const createdResponse = await create(initial, { host: 'attacker.example' });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const invite = new URL(created.invitationUrl).hash.slice('#invite='.length);
  const manage = new URL(created.manageUrl).hash.slice('#manage='.length);
  assert.match(invite, /^[A-Za-z0-9_-]{43}$/);
  assert.match(manage, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(invite, manage);
  assert.equal(new URL(created.invitationUrl).search, '');
  assert.equal(new URL(created.invitationUrl).origin, publicUrl, 'generated links must ignore the request Host header');
  assert.equal(new URL(created.invitationUrl).hash.includes(manage), false);
  assert.equal(created.appointment.status, 'pending');

  const storedText = await readFile(storePath, 'utf8');
  const stored = JSON.parse(storedText)[created.appointment.id];
  assert.equal(stored.inviteHash, createHash('sha256').update(invite).digest('hex'));
  assert.equal(stored.manageHash, createHash('sha256').update(manage).digest('hex'));
  assert.equal(storedText.includes(invite), false);
  assert.equal(storedText.includes(manage), false);
  assert.ok(Date.parse(stored.expiresAt) > Date.now());
  if (process.platform !== 'win32') assert.equal((await stat(storePath)).mode & 0o777, 0o600);

  const auth = token => ({ authorization: `Bearer ${token}` });
  assert.equal((await fetch(`${base}/api/appointment`)).status, 401);
  assert.equal((await fetch(`${base}/api/appointment`, { headers: auth('malformed') })).status, 401);
  assert.equal((await fetch(`${base}/api/appointment`, { headers: auth('A'.repeat(43)) })).status, 404);
  assert.equal((await fetch(`${base}/api/appointment?token=${invite}`)).status, 400);
  const legacyRecord = await (await fetch(`${base}/api/appointment`, { headers: auth(existingInvite) })).json();
  assert.equal(legacyRecord.appointment.status, 'accepted', 'existing records without expiresAt remain readable');

  const recipientViewResponse = await fetch(`${base}/api/appointment`, { headers: auth(invite) });
  const recipientView = await recipientViewResponse.json();
  assert.equal(recipientView.appointment.location, 'Paparoti');
  assert.equal(recipientView.isOrganizer, false);
  assert.equal(recipientViewResponse.headers.get('access-control-allow-origin'), null);
  assert.match(recipientViewResponse.headers.get('content-security-policy'), /default-src 'none'/);

  const inviteCancel = await fetch(`${base}/api/appointment/cancel`, {
    method: 'POST', headers: { ...auth(invite), 'content-type': 'application/json', origin: publicUrl }, body: JSON.stringify({ status: 'cancelled' })
  });
  assert.equal(inviteCancel.status, 403, 'invitation tokens must not cancel');
  const managerRespond = await fetch(`${base}/api/appointment/respond`, {
    method: 'POST', headers: { ...auth(manage), 'content-type': 'application/json', origin: publicUrl }, body: JSON.stringify({ status: 'accepted' })
  });
  assert.equal(managerRespond.status, 403, 'organizer tokens must not respond as invitee');
  const crossOrigin = await fetch(`${base}/api/appointment/cancel`, {
    method: 'POST', headers: { ...auth(manage), 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify({ status: 'cancelled' })
  });
  assert.equal(crossOrigin.status, 403);

  const invalidBodies = [
    { ...initial, date: '2027-02-31' },
    { ...initial, location: '<img src=x onerror=alert(1)>' },
    { ...initial, time: '6:00 AM' },
    { ...initial, creator: 'mass assignment' },
    { ...initial, id: 'client-controlled-id' },
    null
  ];
  for (const value of invalidBodies) assert.equal((await create(value)).status, 400);
  assert.equal((await fetch(`${base}/api/appointments`, { method: 'POST', headers: { origin: publicUrl }, body: '{}' })).status, 415);

  const tooLarge = await fetch(`${base}/api/appointment/respond`, {
    method: 'POST', headers: { ...auth(invite), 'content-type': 'application/json', origin: publicUrl }, body: JSON.stringify({ status: 'accepted', extra: 'x'.repeat(5000) })
  }).catch(error => error);
  assert.ok(tooLarge instanceof Response, 'oversized request should receive an HTTP response');
  assert.equal(tooLarge.status, 413);

  const acceptedResponse = await fetch(`${base}/api/appointment/respond`, {
    method: 'POST', headers: { ...auth(invite), 'content-type': 'application/json', origin: publicUrl }, body: JSON.stringify({ status: 'accepted' })
  });
  assert.equal(acceptedResponse.status, 200);
  assert.equal((await acceptedResponse.json()).appointment.status, 'accepted');
  const conflict = await fetch(`${base}/api/appointment/respond`, {
    method: 'POST', headers: { ...auth(invite), 'content-type': 'application/json', origin: publicUrl }, body: JSON.stringify({ status: 'declined' })
  });
  assert.equal(conflict.status, 409);

  const organizerView = await (await fetch(`${base}/api/appointment`, { headers: auth(manage) })).json();
  assert.equal(organizerView.appointment.status, 'accepted');
  assert.equal(organizerView.isOrganizer, true);
  const cancelled = await fetch(`${base}/api/appointment/cancel`, {
    method: 'POST', headers: { ...auth(manage), 'content-type': 'application/json', origin: publicUrl }, body: JSON.stringify({ status: 'cancelled' })
  });
  assert.equal((await cancelled.json()).appointment.status, 'cancelled');
  assert.equal((await (await fetch(`${base}/api/appointment`, { headers: auth(invite) })).json()).appointment.status, 'cancelled');

  assert.equal((await create(initial)).status, 429, 'repeated create attempts are rate limited');

  const persisted = JSON.parse(await readFile(storePath, 'utf8'));
  persisted[created.appointment.id].expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(storePath, JSON.stringify(persisted));
  assert.equal((await fetch(`${base}/api/appointment`, { headers: auth(invite) })).status, 410);
  assert.equal((await fetch(`${base}/api/appointment`, { headers: auth(manage) })).status, 410);

  let tokenRateLimited = false;
  for (let index = 0; index < 60; index++) {
    const response = await fetch(`${base}/api/appointment`, { headers: auth(invite) });
    if (response.status === 429) { tokenRateLimited = true; break; }
    assert.equal(response.status, 410);
  }
  assert.equal(tokenRateLimited, true, 'appointment lookup attempts are rate limited');
});

test('production requests require HTTPS through an explicitly trusted proxy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'date-proposal-prod-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'production', PUBLIC_URL: 'https://dates.example.test',
      TRUSTED_PROXY_IPS: '127.0.0.1', APPOINTMENTS_FILE: join(dir, 'appointments.json')
    },
    stdio: 'ignore'
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  });
  const localUrl = `http://127.0.0.1:${port}`;
  let listening = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await fetch(localUrl); listening = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(listening, true);
  assert.equal((await fetch(localUrl)).status, 400, 'unmarked HTTP must not be treated as HTTPS');
  const forwarded = await fetch(localUrl, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.8' } });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.headers.get('strict-transport-security'), 'max-age=31536000');
  const created = await fetch(`${localUrl}/api/appointments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', origin: 'https://dates.example.test',
      'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.8'
    },
    body: JSON.stringify({ date: '2027-02-10', time: '6:00 Fiid', location: 'Paparoti', food: 'Matcha' })
  });
  assert.equal(created.status, 201);
  const invite = await created.json();
  assert.match(invite.invitationUrl, /^https:\/\/dates\.example\.test\/#invite=/);
});

test('startup reports EADDRINUSE clearly and exits without disturbing the listener', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'date-proposal-port-'));
  const occupied = createServer();
  // Match the application's wildcard bind so the OS reports a real collision.
  occupied.listen(0, '0.0.0.0');
  await once(occupied, 'listening');
  const port = occupied.address().port;
  const env = { ...process.env, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, APPOINTMENTS_FILE: join(dir, 'appointments.json'), NODE_ENV: 'test' };
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [exitCode] = await once(child, 'exit');
  assert.notEqual(exitCode, 0);
  assert.match(stderr, new RegExp(`Port ${port} is already in use`));
  assert.equal(occupied.listening, true, 'the pre-existing listener remains untouched');
  await new Promise(resolve => occupied.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('default appointment store works on the platform without directory chmod support', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'date-proposal-default-store-'));
  await mkdir(join(dir, 'data'));
  await copyFile(new URL('../server.mjs', import.meta.url), join(dir, 'server.mjs'));
  await copyFile(new URL('../index.html', import.meta.url), join(dir, 'index.html'));
  const probe = createServer();
  probe.listen(0, '0.0.0.0');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let startupOutput = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: dir,
    // Browser origin may use a local host alias different from the configured public URL.
    env: { ...process.env, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { startupOutput += chunk; });
  child.stderr.on('data', chunk => { startupOutput += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(ready, true, `default-store server should start (exit ${child.exitCode}; ${startupOutput})`);
  const response = await fetch(`${base}/api/appointments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ date: '2027-02-10', time: '6:00 Fiid', location: 'Paparoti', food: 'Matcha' })
  });
  assert.equal(response.status, 201, await response.text());
  const store = JSON.parse(await readFile(join(dir, 'data', 'appointments.json'), 'utf8'));
  assert.equal(Object.keys(store).length, 1);
});
