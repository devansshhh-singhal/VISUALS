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
    version: 5,
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
    trash: [],
    collections: [],
    smart: [],
    shareLinks: [{ id: 'test-link', folderId: 'travel', folderName: 'Travel', createdAt: Date.now() - 60000,
      allowDl: true, mode: 'dl', requireName: true, revoked: false }],
    shareRevokedBefore: 0
  };
}
// The repository side of a storage check: every blob the API would report in git/trees.
function repoTreeFixture() {
  return {
    'library.json': { size: 900, sha: 'sha-lib' },
    'images/sunrise.svg': { size: 100, sha: 'sha-i1' },
    'images/sea.svg': { size: 200, sha: 'sha-i2' },
    'images/secret.svg': { size: 300, sha: 'sha-i3' },
    'images/orphan.svg': { size: 4096, sha: 'sha-orphan' }
  };
}
function sharePayload(overrides = {}) {
  // Share links carry the permission mode in `md`; older links only ever had `dl`.
  return { o: 'tester', r: 'visuals-data', b: 'main', t: READ_TOKEN, f: 'travel',
    id: 'test-link', exp: 0, rn: false, dl: true, md: 'dl', cat: Date.now() - 60000, ...overrides };
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
  return { enc: true, id: payload.id, f: payload.f, exp: payload.exp, rn: payload.rn, dl: payload.dl, md: payload.md,
    ...(payload.audit ? { audit: payload.audit } : {}), ...(payload.sc ? { sc: payload.sc } : {}), ...(payload.lim ? { lim: payload.lim } : {}), ...(payload.wm ? { wm: payload.wm } : {}),
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
  const api = {
    library: options.library || libraryFixture(), calls: [], writes: [], deletes: [],
    tree: options.tree || repoTreeFixture(), audits: options.audits || [], logins: options.logins || [], auditConflicts: options.auditConflicts || 0,
    faces: options.faces === undefined ? null : options.faces, facesSha: options.facesSha || 'faces-sha', facesConflicts: options.facesConflicts || 0
  };
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
      if (req.method() === 'GET') return api.logins.length ? json({ sha: 'logs-sha', content: Buffer.from(JSON.stringify(api.logins)).toString('base64') }) : json({ message: 'Not found' }, 404);
      const body = req.postDataJSON(); api.writes.push({ ...call, body });
      api.logins = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      return json({ content: { sha: 'logs-sha' } });
    }
    if (path === 'contents/audit.json') {
      if (req.method() === 'GET') {
        if (call.accept?.includes('raw')) return json(api.audits);
        return api.audits.length ? json({ sha: 'audit-sha', ...(options.rawAudit ? {} : { content: Buffer.from(JSON.stringify(api.audits)).toString('base64') }) }) : json({ message: 'Not found' }, 404);
      }
      if (api.auditConflicts > 0) {
        api.auditConflicts--;
        api.audits.push(...(options.conflictEntries || []));
        return json({ message: 'Conflict' }, 409);
      }
      if (options.holdAuditWrite) await options.holdAuditWrite();
      if (options.failAuditWrite) return json({ message: 'Unavailable' }, 503);
      const body = req.postDataJSON();
      api.writes.push({ ...call, body });
      api.audits = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      return json({ content: { sha: 'audit-sha-2' } });
    }
    if (path === 'contents/faces.json') {
      if (req.method() === 'GET') {
        if (options.facesStatus) return json({ message: 'Unavailable' }, options.facesStatus);
        if (options.facesCorrupt) return json({ sha: api.facesSha, content: Buffer.from('{not json').toString('base64') });
        if (!api.faces) return json({ message: 'Not found' }, 404);
        if (call.accept?.includes('raw')) return json(api.faces);
        return json({ sha: api.facesSha, ...(options.rawFaces ? {} : { content: Buffer.from(JSON.stringify(api.faces)).toString('base64') }) });
      }
      if (req.method() === 'PUT') {
        const body = req.postDataJSON();
        if (api.facesConflicts > 0) {
          api.facesConflicts--;
          api.calls[api.calls.length - 1].conflict = true;
          return json({ message: 'Conflict' }, 409);
        }
        api.writes.push({ ...call, body });
        api.faces = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
        api.facesSha = 'faces-sha-' + api.writes.length;
        return json({ content: { sha: api.facesSha } });
      }
    }
    if (path.startsWith('git/trees/')) {
      return json({ truncated: false, tree: Object.entries(api.tree).map(([p, meta]) => ({ path: p, type: 'blob', size: meta.size, sha: meta.sha })) });
    }
    if (path.startsWith('contents/images/') || path.startsWith('contents/thumbs/') || path.startsWith('contents/versions/')) {
      const rel = path.replace(/^contents\//, '');
      if (req.method() === 'PUT') {
        const body = req.postDataJSON();
        api.writes.push({ ...call, body, bytes: Buffer.from(body.content, 'base64').length });
        api.tree[rel] = { size: Buffer.from(body.content, 'base64').length, sha: 'blob-' + Math.random().toString(36).slice(2, 8) };
        return json({ content: { sha: api.tree[rel].sha } });
      }
      if (req.method() === 'DELETE') {
        api.deletes.push({ ...call, body: req.postDataJSON() });
        const existed = !!api.tree[rel];
        delete api.tree[rel];
        return json(existed ? { content: null } : { message: 'Not found' }, existed ? 200 : 404);
      }
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#4453d1"/></svg>' });
    }
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
async function createLink(page, { password = null, requireName = false, mode = 'dl',
  scope = '', maxViews = '', maxDls = '', maxUploads = '', watermark = '', watermarkPos = 'br',
  expiry = '604800000' } = {}) {
  await page.locator('#fShareBase').fill('https://visuals.example/my-visuals/');
  if (password) await page.locator('#fSharePass').fill(password);
  else await page.locator('#fShareUsePass').uncheck();
  await page.locator('#fShareRequireName').setChecked(requireName);
  await page.locator('#fShareExpiry').selectOption(expiry);
  if (mode !== 'dl') await page.locator('#fMode' + mode[0].toUpperCase() + mode.slice(1)).click();
  if (scope) await page.locator('#fShareScope').selectOption(scope);
  if (maxViews) await page.locator('#fShareMaxViews').fill(String(maxViews));
  if (maxDls) await page.locator('#fShareMaxDls').fill(String(maxDls));
  if (maxUploads) await page.locator('#fShareMaxUploads').fill(String(maxUploads));
  if (watermark){
    await page.locator('#fShareWm').check();
    await page.locator('#fShareWmText').fill(watermark);
    await page.locator('#fShareWmPos').selectOption(watermarkPos);
  }
  await page.locator('#fShareGo').click();
  await expect(page.locator('#fShareOut')).toBeVisible();
  return page.locator('#fShareOut').textContent();
}

module.exports = { test, expect, WRITE_TOKEN, READ_TOKEN, STORAGE_KEY, OWNER_CFG, libraryFixture, repoTreeFixture,
  sharePayload, encodeShare, encryptedShare, decryptShare, seedConnection, savedConfig, mockGitHub, openOwnerFolder, createLink };
