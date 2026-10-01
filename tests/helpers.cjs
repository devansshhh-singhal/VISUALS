const { test: base, expect } = require('@playwright/test');
const { webcrypto } = require('node:crypto');

// All values here are fake test credentials; requests never reach GitHub.
const WRITE_TOKEN = 'github_pat_fake_write_token';
const READ_TOKEN = 'github_pat_fake_read_token';
const STORAGE_KEY = 'visualsLibrary.v1';
const OWNER_CFG = {
  owner: 'tester', repo: 'visuals-data', branch: 'main', token: WRITE_TOKEN,
  readToken: READ_TOKEN, readTokenConfirmed: true,
  publicAppUrl: 'https://visuals.example/my-visuals/', locked: false
};
const test = base.extend({
  appErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'No app runtime errors or unhandled rejections').toEqual([]);
  }, { auto: true }]
});

function libraryFixture() {
  return {
    version: 3,
    folders: [
      { id: 'travel', name: 'Travel', parent: null },
      { id: 'coast', name: 'Coast', parent: 'travel' },
      { id: 'private', name: 'Private', parent: null }
    ],
    items: [
      { id: 'sunrise', file: 'sunrise.svg', name: 'Sunrise', folder: 'travel', type: 'image/svg+xml', size: 100, tags: ['travel'] },
      { id: 'sea', file: 'sea.svg', name: 'Sea', folder: 'coast', type: 'image/svg+xml', size: 100 },
      { id: 'secret', file: 'secret.svg', name: 'Secret', folder: 'private', type: 'image/svg+xml', size: 100 }
    ],
    shareLinks: [{ id: 'test-link', folderId: 'travel', createdAt: Date.now() - 60000, allowDl: true, revoked: false }],
    shareRevokedBefore: 0
  };
}
function sharePayload(overrides = {}) {
  return { o: 'tester', r: 'visuals-data', b: 'main', t: READ_TOKEN, f: 'travel',
    id: 'test-link', exp: 0, rn: false, dl: true, cat: Date.now() - 60000, ...overrides };
}
function encodeShare(payload) {
  return '#share=' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
async function encryptedShare(payload, password = 'secret123', overrides = {}) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', Buffer.from(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(payload)));
  return { enc: true, id: payload.id, f: payload.f, exp: payload.exp, rn: payload.rn, dl: payload.dl,
    v: 2, alg: 'A256GCM', it: 210000,
    s: Buffer.from(salt).toString('base64url'), iv: Buffer.from(iv).toString('base64url'),
    ct: Buffer.from(encrypted).toString('base64url'), ...overrides };
}
async function decryptShare(envelope, password) {
  const material = await webcrypto.subtle.importKey('raw', Buffer.from(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(envelope.s, 'base64url'), iterations: envelope.it, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64url') }, key, Buffer.from(envelope.ct, 'base64url'));
  return JSON.parse(Buffer.from(plain).toString('utf8'));
}
async function seedConnection(page, cfg = OWNER_CFG) {
  await page.addInitScript(({ key, cfg }) => {
    if (!localStorage.getItem('__visualsTestSeeded')) {
      localStorage.setItem(key, JSON.stringify(cfg));
      localStorage.setItem('__visualsTestSeeded', '1');
    }
  }, { key: STORAGE_KEY, cfg });
}
async function savedConfig(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}
async function mockGitHub(page, options = {}) {
  const api = { library: options.library || libraryFixture(), calls: [], writes: [] };
  await page.route('https://ipapi.co/**', route => route.fulfill({ json: {} }));
  await page.route('https://api.ipify.org/**', route => route.fulfill({ json: {} }));
  await page.route('https://api.github.com/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/?/, '');
    const call = { path, method: req.method(), token: req.headers().authorization, accept: req.headers().accept };
    api.calls.push(call);
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (options.badTokens?.includes(call.token)) return json({ message: 'Bad credentials' }, 401);
    if (path === '') return json({ private: true, default_branch: 'main', size: 10, permissions: { push: true } });
    if (path.startsWith('branches/')) return json({ name: 'main' }, options.branchStatus || 200);
    if (path === 'contents/library.json' && req.method() === 'GET') {
      if (options.holdLibrary) await options.holdLibrary(call);
      if (options.libraryStatus) return json({ message: 'Unavailable' }, options.libraryStatus);
      if (call.accept?.includes('raw')) return json(api.library, options.rawStatus || 200);
      return json({ sha: 'library-sha', ...(options.rawLibrary ? {} : { content: Buffer.from(JSON.stringify(api.library)).toString('base64') }) });
    }
    if (path === 'contents/library.json' && req.method() === 'PUT') {
      api.writes.push({ ...call, body: req.postDataJSON() });
      if (options.failWrite) return json({ message: 'Permission denied' }, 403);
      api.library = JSON.parse(Buffer.from(req.postDataJSON().content, 'base64').toString('utf8'));
      return json({ content: { sha: 'updated-library-sha' } });
    }
    if (path === 'contents/login-logs.json') {
      if (req.method() === 'GET') return json({ message: 'Not found' }, 404);
      return json({ content: { sha: 'logs-sha' } });
    }
    if (path.startsWith('contents/images/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#4453d1"/></svg>' });
    return json({ message: 'Not found' }, 404);
  });
  return api;
}
async function openOwnerFolder(page) {
  await page.goto('/#f=travel');
  await expect(page.locator('#title')).toHaveText('Travel');
  await expect(page.locator('#folderShareBtn')).toBeVisible();
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await page.locator('#folderShareBtn').click();
  await expect(page.locator('#folderSheet')).toBeVisible();
}
async function createLink(page, { password = null, requireName = false } = {}) {
  await page.locator('#fShareBase').fill('https://visuals.example/my-visuals/');
  if (password) await page.locator('#fSharePass').fill(password);
  else await page.locator('#fShareUsePass').uncheck();
  await page.locator('#fShareRequireName').setChecked(requireName);
  await page.locator('#fShareGo').click();
  await expect(page.locator('#fShareOut')).toBeVisible();
  return page.locator('#fShareOut').textContent();
}

module.exports = { test, expect, WRITE_TOKEN, READ_TOKEN, STORAGE_KEY, OWNER_CFG, libraryFixture,
  sharePayload, encodeShare, encryptedShare, decryptShare, seedConnection, savedConfig, mockGitHub, openOwnerFolder, createLink };
