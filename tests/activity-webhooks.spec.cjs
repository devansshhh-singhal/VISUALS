const {
  test, expect, WRITE_TOKEN, READ_TOKEN, OWNER_CFG, libraryFixture, sharePayload, encodeShare,
  encryptedShare, decryptShare, seedConnection, savedConfig, mockGitHub, openOwnerFolder, createLink
} = require('./helpers.cjs');

const SCOPE = 'tester/visuals-data@main';
const HOOK = 'https://activity.example/visuals';
const auditRoute = { v: 1, url: HOOK, scope: SCOPE };
function auditedLibrary() {
  return { ...libraryFixture(), auditWebhook: { v: 1, url: HOOK, updatedAt: Date.now() } };
}
async function mockWebhook(page, { url = HOOK, status = () => 204, headers = {}, abort = false } = {}) {
  const calls = [];
  await page.route(url, async route => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type', 'access-control-expose-headers': 'retry-after', ...headers
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body, attachment;
    if ((req.headers()['content-type'] || '').startsWith('multipart/form-data')) {
      const form = await new Response(req.postDataBuffer(), { headers: { 'Content-Type': req.headers()['content-type'] } }).formData();
      body = JSON.parse(form.get('payload_json'));
      attachment = JSON.parse(await form.get('files[0]').text());
    } else body = req.postDataJSON();
    calls.push({ body, attachment, headers: req.headers(), status: status() });
    if (abort) return route.abort('failed');
    return route.fulfill({ status: status(), headers: cors, body: status() === 429 ? '{"retry_after":10}' : '' });
  });
  return calls;
}
async function entries(page, type = 'audit', scope = SCOPE) {
  return page.evaluate(({ scope, type }) => window.VisualsLogs.entries(scope, type), { scope, type });
}
async function pending(page) { return page.evaluate(() => window.VisualsLogs.outbox()); }
async function openReceiver(page, overrides = {}, library = auditedLibrary()) {
  const api = await mockGitHub(page, { library });
  await page.goto('/' + encodeShare(sharePayload({ audit: auditRoute, ...overrides })));
  await expect(page.locator('#title')).toHaveText('Travel');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  return api;
}

// Real receiver actions and actual HTTP response semantics, never real credentials/endpoints.
test('anonymous receivers send every open, quick reopen, folder visit, search and download to the owner webhook', async ({ page }) => {
  await seedConnection(page, { ...OWNER_CFG, webhookUrl: 'https://recipient.example/own-hook' });
  const wrongDestination = await mockWebhook(page, { url: 'https://recipient.example/own-hook' });
  const calls = await mockWebhook(page);
  const api = await openReceiver(page);
  await expect(page.locator('#banner')).toContainText('Activity notice');
  await expect.poll(() => calls.some(c => c.body.entry.kind === 'login.success')).toBe(true);

  for (let i = 0; i < 2; i++) {
    await page.locator('[data-item-id="sunrise"] .open').click();
    await expect(page.locator('#viewer')).toBeVisible();
    await page.locator('#vClose').click();
    await expect(page.locator('#viewer')).toBeHidden();
  }
  await expect.poll(async () => (await entries(page)).filter(e => e.kind === 'view.image' && e.imageId === 'sunrise').length).toBe(2);
  await expect.poll(async () => (await entries(page)).filter(e => e.kind === 'view.dwell' && e.imageId === 'sunrise').length).toBe(2);
  await page.locator('[data-folder-id="coast"] .open').click();
  await expect(page.locator('#title')).toHaveText('Coast');
  await page.locator('#q').fill('sea');
  await page.locator('#q').press('Enter');
  await page.locator('[data-item-id="sea"] .open').click();
  await page.locator('#vInfo').click();
  await page.locator('#dClose').click();
  const download = page.waitForEvent('download');
  await page.locator('#vDl').click();
  await download;
  await expect.poll(() => calls.some(c => c.body.entry.kind === 'download.file' && c.body.entry.status === 'success')).toBe(true);
  await expect.poll(async () => (await pending(page)).filter(t => t.url).length).toBe(0);

  const logs = await entries(page);
  for (const kind of ['share.open', 'share.ready', 'login.success', 'view.folder', 'search.query', 'view.image', 'view.dwell', 'view.details', 'download.file'])
    expect(logs.some(e => e.kind === kind), kind).toBe(true);
  const sent = new Set(calls.map(c => c.body.entry.id));
  expect(logs.every(e => sent.has(e.id))).toBe(true);
  expect(logs.every(e => e.actorType === 'visitor' && e.linkId === 'test-link' && e.sessionId && e.iso && e.platform)).toBe(true);
  expect(new Set(logs.map(e => e.id)).size).toBe(logs.length);
  expect(wrongDestination).toHaveLength(0);
  expect(api.writes).toHaveLength(0);
  expect((await savedConfig(page)).webhookUrl).toBe('https://recipient.example/own-hook');
  const payloads = JSON.stringify(calls);
  expect(payloads).not.toContain(READ_TOKEN);
  expect(payloads).not.toContain(WRITE_TOKEN);
  expect(payloads).not.toContain('#share=');
  expect(calls.every(c => !c.headers.authorization && !c.headers.referer)).toBe(true);
});

test('new encrypted links inherit the Settings routing snapshot without exposing the GitHub token', async ({ page }) => {
  await seedConnection(page, { ...OWNER_CFG, webhookUrl: HOOK });
  const api = await mockGitHub(page);
  await mockWebhook(page);
  await openOwnerFolder(page);
  const url = await createLink(page, { password: 'secret123' });
  const envelope = JSON.parse(Buffer.from(new URL(url).hash.slice(7), 'base64url').toString());
  expect(envelope.audit).toEqual(auditRoute);
  expect(envelope.wh).toBeUndefined();
  expect(envelope.t).toBeUndefined();
  const inner = await decryptShare(envelope, 'secret123');
  expect(inner.audit).toEqual(auditRoute);
  expect(inner.t).toBe(READ_TOKEN);
  expect(api.library.auditWebhook.url).toBe(HOOK);
  expect(JSON.stringify(envelope.audit)).not.toContain(READ_TOKEN);
});

test('wrong passwords are persisted and delivered before decryption, never with the password or token', async ({ page }) => {
  const calls = await mockWebhook(page);
  const api = await mockGitHub(page, { library: auditedLibrary() });
  const envelope = await encryptedShare(sharePayload({ audit: auditRoute, rn: true }));
  await page.goto('/' + encodeShare(envelope));
  await expect(page.locator('#lgNotice')).toContainText('access attempts');
  await page.locator('#lgVisitor').fill('Receiver One');
  await page.locator('#lgPass').fill('wrong-password-private');
  await page.locator('#lgSubmit').click();
  await expect(page.locator('#lgMsg')).toContainText('Incorrect password');
  await expect.poll(() => calls.some(c => c.body.entry.status === 'failed_password')).toBe(true);
  expect(api.calls).toHaveLength(0);
  const failed = calls.find(c => c.body.entry.status === 'failed_password').body.entry;
  expect(failed.actor).toBe('Receiver One');
  expect(failed.linkId).toBe('test-link');
  expect(failed.repo).toBe(SCOPE);
  expect(JSON.stringify(calls)).not.toContain('wrong-password-private');
  expect(JSON.stringify(calls)).not.toContain(READ_TOKEN);
  await page.locator('#lgPass').fill('secret123');
  await page.locator('#lgSubmit').click();
  await expect(page.locator('#title')).toHaveText('Travel');
  await expect.poll(async () => (await entries(page, 'login')).map(e => e.status).sort()).toEqual(['failed_password', 'success']);
});

test('legacy encrypted attempts are kept locally and routed after the owner setting becomes readable', async ({ page }) => {
  const calls = await mockWebhook(page);
  await mockGitHub(page, { library: auditedLibrary() });
  const envelope = await encryptedShare(sharePayload()); // No public routing snapshot on a legacy envelope.
  await page.goto('/' + encodeShare(envelope));
  await page.locator('#lgPass').fill('incorrect');
  await page.locator('#lgSubmit').click();
  await expect(page.locator('#lgMsg')).toContainText('Incorrect password');
  expect(calls).toHaveLength(0);
  await page.locator('#lgPass').fill('secret123');
  await page.locator('#lgSubmit').click();
  await expect(page.locator('#title')).toHaveText('Travel');
  await expect.poll(() => calls.some(c => c.body.entry.status === 'failed_password')).toBe(true);
  expect((await entries(page)).some(e => e.status === 'failed_password')).toBe(true);
});

for (const [status, overrides, library] of [
  ['expired_link', { exp: Date.now() - 10000 }, null],
  ['revoked_link', {}, { ...auditedLibrary(), shareLinks: [{ ...libraryFixture().shareLinks[0], revoked: true }] }],
  ['missing_folder', { f: 'missing' }, null]
]) test('blocked ' + status + ' visits retain and notify the access result', async ({ page }) => {
  const calls = await mockWebhook(page);
  const api = await mockGitHub(page, { library: library || auditedLibrary() });
  await page.goto('/' + encodeShare(sharePayload({ audit: auditRoute, ...overrides })));
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await expect(page.locator('#empty')).toBeVisible();
  await expect.poll(() => calls.some(c => c.body.entry.kind === 'login.failed' && c.body.entry.status === status)).toBe(true);
  expect((await entries(page)).some(e => e.kind === 'share.open')).toBe(true);
  expect((await entries(page, 'login')).filter(e => e.status === status)).toHaveLength(1);
  expect(api.writes).toHaveLength(0);
});

test('existing plaintext links use the repository Settings endpoint, ignoring legacy wh and recipient settings', async ({ page }) => {
  await seedConnection(page, { ...OWNER_CFG, webhookUrl: 'https://recipient.example/own-hook' });
  const calls = await mockWebhook(page);
  const ignored = await mockWebhook(page, { url: 'https://legacy.example/hook' });
  const wrong = await mockWebhook(page, { url: 'https://recipient.example/own-hook' });
  await mockGitHub(page, { library: auditedLibrary() });
  await page.goto('/' + encodeShare(sharePayload({ wh: 'https://legacy.example/hook' })));
  await expect(page.locator('#title')).toHaveText('Travel');
  await expect.poll(() => calls.some(c => c.body.entry.kind === 'share.open')).toBe(true);
  expect(ignored).toHaveLength(0); expect(wrong).toHaveLength(0);
  expect((await savedConfig(page)).webhookUrl).toBe('https://recipient.example/own-hook');
});

test('HTTP failures remain in a durable outbox across reload/offline and resume on reconnection', async ({ page }) => {
  let responseStatus = 500;
  const calls = await mockWebhook(page, { status: () => responseStatus });
  await page.addInitScript(() => {
    window.__offline = false;
    Object.defineProperty(navigator, 'onLine', { get: () => !window.__offline });
  });
  await page.clock.install();
  await openReceiver(page);
  await expect.poll(async () => (await pending(page)).some(t => t.attempts === 1 && t.lastStatus === 500)).toBe(true);
  await page.evaluate(() => { window.__offline = true; window.dispatchEvent(new Event('offline')); });
  await page.locator('[data-item-id="sunrise"] .open').click();
  await expect.poll(async () => (await pending(page)).some(t => t.entry.kind === 'view.image')).toBe(true);
  const queuedIds = (await pending(page)).map(t => t.entry.id);
  const failedCalls = calls.length;
  // The init script resets its flag on navigation; a second script keeps this reload offline.
  await page.addInitScript(() => { window.__offline = true; });
  await page.reload();
  await expect(page.locator('#title')).toHaveText('Travel');
  expect((await pending(page)).map(t => t.entry.id)).toEqual(expect.arrayContaining(queuedIds));
  await page.clock.fastForward(5000);
  expect(calls).toHaveLength(failedCalls);
  responseStatus = 204;
  await page.evaluate(() => { window.__offline = false; window.dispatchEvent(new Event('online')); });
  await expect.poll(async () => (await pending(page)).filter(t => t.url).length, { timeout: 10000 }).toBe(0);
  const accepted = calls.filter(c => c.status === 204).map(c => c.body.entry.id);
  expect(accepted).toEqual(expect.arrayContaining(queuedIds));
  const attempts = await page.evaluate(scope => window.VisualsLogs.attempts(scope), SCOPE);
  expect(attempts.some(a => !a.ok && a.status === 500)).toBe(true);
  expect(attempts.some(a => a.ok && a.status === 204)).toBe(true);
  expect((await entries(page)).map(e => e.id)).toEqual(expect.arrayContaining(queuedIds));
});

test('429 Retry-After throttles the entire endpoint without discarding its burst of events', async ({ page }) => {
  let responseStatus = 429;
  const calls = await mockWebhook(page, { status: () => responseStatus, headers: { 'retry-after': '10' } });
  await page.clock.install();
  await openReceiver(page);
  await expect.poll(() => calls.length).toBe(1);
  await expect.poll(async () => (await pending(page)).some(t => t.lastStatus === 429)).toBe(true);
  await page.clock.fastForward(5000);
  expect(calls).toHaveLength(1);
  responseStatus = 204;
  await page.clock.fastForward(6000);
  await expect.poll(() => calls.length).toBeGreaterThan(1);
  await expect.poll(async () => (await pending(page)).filter(t => t.url).length).toBe(0);
});

test('a failed webhook test never claims delivery and never falls back to unacknowledged no-cors POSTs', async ({ page }) => {
  await seedConnection(page);
  await mockGitHub(page);
  const calls = await mockWebhook(page, { abort: true });
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.__hookModes = [];
    window.fetch = (url, options) => {
      if (String(url).includes('activity.example')) window.__hookModes.push(options.mode);
      return fetch(url, options);
    };
  });
  await page.goto('/'); await page.locator('#securityBtn').click();
  await page.locator('#secWebhookUrl').fill(HOOK);
  await page.locator('#secWebhookTest').click();
  await expect(page.locator('#secWebhookMsg')).toContainText('delivery is not confirmed');
  expect(calls.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__hookModes)).toEqual(expect.arrayContaining(['cors']));
  expect(await page.evaluate(() => window.__hookModes.includes('no-cors'))).toBe(false);
  expect((await pending(page)).some(t => t.entry.kind === 'webhook.test')).toBe(true);
  await expect(page.locator('#secWebhookDelivery')).toContainText('pending');
});

test('Settings publishes its webhook for old links and validates the full HTTPS URL', async ({ page }) => {
  await seedConnection(page); const api = await mockGitHub(page); await mockWebhook(page);
  await page.goto('/'); await page.locator('#securityBtn').click();
  for (const invalid of ['https://', 'http://activity.example/hook', 'https://user:password@activity.example/hook', HOOK + '#secret']) {
    await page.locator('#secWebhookUrl').fill(invalid); await page.locator('#secWebhookSave').click();
    await expect(page.locator('#secWebhookMsg')).toContainText('valid HTTPS');
  }
  await page.locator('#secWebhookUrl').fill(HOOK); await page.locator('#secWebhookSave').click();
  await expect(page.locator('#secWebhookMsg')).toContainText('saved for every shared link');
  expect(api.library.auditWebhook.url).toBe(HOOK);
  expect((await savedConfig(page)).webhookUrl).toBe(HOOK);
  await page.locator('#secWebhookTest').click();
  await expect(page.locator('#secWebhookMsg')).toContainText('delivery confirmed');
});

test('view-only download attempts and per-file upload outcomes are logged, without receiver repository log writes', async ({ page }) => {
  const calls = await mockWebhook(page);
  const api = await openReceiver(page, { md: 'view', dl: false });
  await page.locator('[data-item-id="sunrise"] .open').click();
  await page.keyboard.press('d');
  await expect.poll(() => calls.some(c => c.body.entry.kind === 'download.file' && c.body.entry.status === 'blocked')).toBe(true);
  await page.locator('#vClose').click();
  await page.locator('#file').setInputFiles({ name: 'denied.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect.poll(async () => (await entries(page)).some(e => e.kind === 'image.upload' && e.status === 'blocked')).toBe(true);
  expect(api.writes).toHaveLength(0);
});

test('upload links retain per-file successes and limit denials and preserve the owner webhook metadata', async ({ page }) => {
  const calls = await mockWebhook(page);
  const api = await mockGitHub(page, { library: auditedLibrary() });
  await page.clock.install();
  const payload = sharePayload({ t: WRITE_TOKEN, md: 'write', lim: { u: 1 }, audit: auditRoute, exp: Date.now() + 86400000 });
  await page.goto('/' + encodeShare(await encryptedShare(payload)));
  await page.locator('#lgPass').fill('secret123'); await page.locator('#lgSubmit').click();
  await expect(page.locator('#title')).toHaveText('Travel');
  await page.locator('#file').setInputFiles(['first', 'second'].map(name => ({ name: name + '.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') })));
  await page.locator('#upGo').click();
  await expect(page.locator('#upload')).toBeHidden();
  await expect.poll(async () => (await entries(page)).some(e => e.kind === 'image.upload' && e.imageName === 'first' && e.status === 'success')).toBe(true);
  await expect.poll(async () => (await entries(page)).some(e => e.kind === 'image.upload' && e.imageName === 'second' && e.status === 'blocked')).toBe(true);
  await page.clock.fastForward(5000);
  await expect.poll(() => api.library.items.some(e => e.name === 'first')).toBe(true);
  expect(api.library.auditWebhook.url).toBe(HOOK);
  expect(api.writes.some(w => /contents\/(audit|login-logs)\.json/.test(w.path))).toBe(false);
  await expect.poll(() => calls.some(c => c.body.entry.kind === 'image.upload')).toBe(true);
});

test('page exit persists dwell and a leave event and attempts keepalive delivery', async ({ page }) => {
  await mockWebhook(page);
  await page.addInitScript(() => {
    const fetch = window.fetch; window.__keepalive = [];
    window.fetch = (url, options) => {
      if (String(url).includes('activity.example')) window.__keepalive.push(!!options.keepalive);
      return fetch(url, options);
    };
  });
  await openReceiver(page);
  await expect.poll(async () => (await pending(page)).filter(t => t.url).length).toBe(0);
  await page.locator('[data-item-id="sunrise"] .open').click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(async () => (await entries(page)).some(e => e.kind === 'share.leave')).toBe(true);
  expect((await entries(page)).some(e => e.kind === 'view.dwell' && e.note === 'page_exit')).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__keepalive.includes(true))).toBe(true);
});

test('the archive, exports and repository merges retain logs beyond both old limits and handle write conflicts', async ({ page }) => {
  const now = Date.now() - 100000;
  const auditHistory = Array.from({ length: 1305 }, (_, i) => ({ id: 'old-' + i, t: now - i, kind: 'view.image', msg: 'Historical view ' + i, actor: 'Visitor', actorType: 'visitor' }));
  const loginHistory = Array.from({ length: 305 }, (_, i) => ({ id: 'login-' + i, t: now - i, iso: new Date(now - i).toISOString(), status: 'success', mode: 'share_link', user: 'Visitor' }));
  const concurrent = { id: 'other-device', t: now, kind: 'settings.save', msg: 'Saved on another device' };
  await seedConnection(page);
  await page.addInitScript(({ scope, audits, logins }) => {
    if (!localStorage.getItem('__historySeeded')) {
      localStorage.setItem('visuals-audit-v1:' + scope, JSON.stringify(audits));
      localStorage.setItem('visuals-login-logs-v1', JSON.stringify(logins));
      localStorage.setItem('__historySeeded', '1');
    }
  }, { scope: SCOPE, audits: auditHistory, logins: loginHistory });
  const api = await mockGitHub(page, { audits: [auditHistory[0]], auditConflicts: 1, conflictEntries: [concurrent], rawAudit: true });
  await page.clock.install(); await page.goto('/');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  expect(await entries(page)).toHaveLength(1305);
  expect(await entries(page, 'login')).toHaveLength(305);
  await page.clock.fastForward(4100);
  await expect.poll(() => api.audits.some(e => e.id === 'other-device')).toBe(true);
  await expect.poll(() => api.audits.length).toBe(1306);
  await expect.poll(() => api.logins.length).toBe(305);
  expect(api.calls.some(c => c.path === 'contents/audit.json' && c.accept.includes('raw'))).toBe(true);
  await page.locator('#gear').click(); await page.locator('#sAudit').click();
  await expect(page.locator('#auScope')).toContainText('1306 archived events');
  await expect(page.locator('#auList .audit-row')).toHaveCount(100);
  await page.locator('#auMore').click();
  await expect(page.locator('#auList .audit-row')).toHaveCount(200);
  const download = page.waitForEvent('download'); await page.locator('#auJson').click();
  const file = await download;
  const fs = require('node:fs/promises');
  const exported = JSON.parse(await fs.readFile(await file.path(), 'utf8'));
  expect(exported).toHaveLength(1306);
  await page.locator('#auClear').click(); await page.locator('#auClear').click();
  expect((await entries(page)).some(e => e.id === 'old-1304')).toBe(true);
  await expect(page.locator('#auShowAll')).toBeVisible();
  await page.locator('#auShowAll').click();
  await expect(page.locator('#auScope')).toContainText('archived events');
  await page.reload();
  await expect(page.locator('#loadingStatus')).toBeHidden();
  expect((await entries(page)).some(e => e.id === 'old-1304')).toBe(true);
});

test('IndexedDB still preserves every entry when the localStorage compatibility mirror is full', async ({ page }) => {
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('visuals-audit-v1:')) throw new DOMException('Storage full', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  });
  await mockWebhook(page); await openReceiver(page);
  await expect.poll(async () => (await entries(page)).length).toBeGreaterThan(0);
  const ids = (await entries(page)).map(e => e.id);
  await page.reload(); await expect(page.locator('#title')).toHaveText('Travel');
  expect((await entries(page)).map(e => e.id)).toEqual(expect.arrayContaining(ids));
});

test('the persistent localStorage fallback retains unsent events when IndexedDB is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('Unavailable'); } } }));
  await mockWebhook(page, { status: () => 500 }); await openReceiver(page);
  await expect.poll(async () => (await pending(page)).some(t => t.attempts > 0)).toBe(true);
  const ids = (await pending(page)).map(t => t.entry.id);
  await page.reload(); await expect(page.locator('#title')).toHaveText('Travel');
  expect((await pending(page)).map(t => t.entry.id)).toEqual(expect.arrayContaining(ids));
  expect((await entries(page)).map(e => e.id)).toEqual(expect.arrayContaining(ids));
});

test('queued destinations are immutable across library or link changes', async ({ page }) => {
  let status = 500;
  const calls = await mockWebhook(page, { status: () => status });
  const other = await mockWebhook(page, { url: 'https://other-owner.example/hook' });
  await page.clock.install(); await openReceiver(page);
  await expect.poll(async () => (await pending(page)).some(t => t.attempts > 0)).toBe(true);
  const oldIds = (await pending(page)).map(t => t.entry.id);
  await page.goto('/' + encodeShare(sharePayload({ id: 'second-link', f: 'private', audit: { ...auditRoute, url: 'https://other-owner.example/hook' } })));
  await expect(page.locator('#title')).toHaveText('Private');
  status = 204; await page.clock.fastForward(4000);
  await expect.poll(async () => (await pending(page)).filter(t => t.url).length).toBe(0);
  expect(calls.filter(c => c.status === 204).map(c => c.body.entry.id)).toEqual(expect.arrayContaining(oldIds));
  expect(other.some(c => oldIds.includes(c.body.entry.id))).toBe(false);
});

test('Discord receives provider-compatible messages containing the full entry and no mentions', async ({ page }) => {
  const url = 'https://discord.com/api/webhooks/fake-id/fake-secret';
  const calls = await mockWebhook(page, { url });
  await openReceiver(page, { audit: { ...auditRoute, url } }, { ...auditedLibrary(), auditWebhook: { v: 1, url, updatedAt: Date.now() } });
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  const body = calls[0].body;
  expect(body.allowed_mentions).toEqual({ parse: [] });
  expect(body.event).toBeUndefined();
  const json = body.embeds.map(e => e.description.replace(/^```json\n|\n```$/g, '')).join('');
  const complete = JSON.parse(json);
  expect(complete.entry.id).toBeTruthy(); expect(complete.entry.kind).toBe('share.open');
  expect(complete.repo).toBe(SCOPE);
});

test('stalled webhook requests time out without blocking the library or losing an entry', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch; window.__stalledHooks = 0;
    window.fetch = (url, options) => {
      if (!String(url).includes('activity.example')) return fetch(url, options);
      window.__stalledHooks++;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    };
  });
  await page.clock.install(); await openReceiver(page);
  await expect.poll(() => page.evaluate(() => window.__stalledHooks)).toBeGreaterThan(0);
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await page.clock.fastForward(8500);
  await expect.poll(async () => (await pending(page)).some(t => t.lastError === 'Webhook timed out')).toBe(true);
  expect((await entries(page)).some(e => e.kind === 'share.open')).toBe(true);
  await expect(page.locator('#title')).toHaveText('Travel');
});

test('late enrichment cannot recreate an acknowledged task and failures retain the newest metadata', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async ({ scope, url }) => {
    const store = window.VisualsLogs, t = Date.now();
    const entry = { id: 'unit-event', t, iso: new Date(t).toISOString(), kind: 'view.image', actor: 'Visitor', actorType: 'visitor' };
    const stale = { id: 'unit-task', scope, url, entry, createdAt: t, nextAt: t + 60000, attempts: 1 };
    await store.append(scope, 'audit', entry, stale);
    await store.updateTask(stale.id, { entry: { ...entry, ip: '192.0.2.1' } });
    await store.finishAttempt(stale, { ok: false, status: 500, error: 'HTTP 500' });
    const enriched = (await store.outbox()).find(task => task.id === stale.id);
    await store.finishAttempt(stale, { ok: true, status: 204 });
    await store.updateTask(stale.id, { entry: { ...entry, ip: '192.0.2.2' } });
    return { ip: enriched.entry.ip, remaining: (await store.outbox()).some(task => task.id === stale.id), archived: (await store.entries(scope, 'audit')).some(e => e.id === entry.id) };
  }, { scope: SCOPE, url: HOOK });
  expect(result).toEqual({ ip: '192.0.2.1', remaining: false, archived: true });
});

test('unavailable browser storage warns instead of silently pretending logs are durable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('Unavailable'); } } });
    Storage.prototype.setItem = function() { throw new DOMException('Storage full', 'QuotaExceededError'); };
  });
  await mockWebhook(page, { status: () => 500 }); await openReceiver(page);
  await expect(page.locator('#toast')).toContainText('only in memory');
  expect((await entries(page)).some(e => e.kind === 'share.open')).toBe(true);
  expect(await page.evaluate(() => window.VisualsLogs.storageError)).toContain('export them');
});

test('CSV exports keep receiver names as text rather than executable spreadsheet formulas', async ({ page }) => {
  await seedConnection(page); await mockGitHub(page);
  await page.addInitScript(scope => localStorage.setItem('visuals-audit-v1:' + scope, JSON.stringify([
    { id: 'formula-name', t: Date.now(), kind: 'login.success', msg: 'Login', actor: '=1+1', actorType: 'visitor' }
  ])), SCOPE);
  await page.goto('/'); await page.locator('#gear').click(); await page.locator('#sAudit').click();
  const download = page.waitForEvent('download'); await page.locator('#auCsv').click();
  const file = await download, fs = require('node:fs/promises');
  const csv = await fs.readFile(await file.path(), 'utf8');
  expect(csv).toContain('"\'=1+1"');
});

test('changing the owner connection during a log write still backs up the new connection logs', async ({ page }) => {
  let release, started = false, hold = true;
  const held = new Promise(resolve => { release = resolve; });
  const remote = { id: 'remote-only', t: Date.now() - 1000, kind: 'settings.save', msg: 'Existing remote history', repo: SCOPE };
  await seedConnection(page);
  const api = await mockGitHub(page, { audits: [remote], holdAuditWrite: async () => { if (hold) { started = true; await held; } } });
  await page.clock.install(); await page.goto('/');
  await page.locator('#gear').click(); await page.locator('#sThemeDark').click(); await page.locator('#sClose').click();
  await page.clock.fastForward(4100);
  await expect.poll(() => started).toBe(true);
  await page.locator('#gear').click(); await page.locator('#sOwner').fill('other-owner'); await page.locator('#sSave').click();
  await expect.poll(async () => (await savedConfig(page)).owner).toBe('other-owner');
  await expect(page.locator('#settings')).toBeHidden();
  hold = false; release();
  await expect.poll(() => page.evaluate(scope => JSON.parse(localStorage.getItem('visuals-audit-v1:' + scope) || '[]').some(e => e.id === 'remote-only'), SCOPE)).toBe(true);
  await page.clock.fastForward(4100);
  await expect.poll(() => api.audits.some(e => e.kind === 'settings.save' && e.repo === 'other-owner/visuals-data@main'), { timeout: 10000 }).toBe(true);
});

test('oversized Discord metadata is delivered as a full JSON attachment, not rejected or truncated', async ({ page }) => {
  const url = 'https://discord.com/api/webhooks/fake-id/fake-secret';
  const calls = await mockWebhook(page, { url });
  await openReceiver(page, { audit: { ...auditRoute, url } });
  await page.evaluate(async ({ scope, url }) => {
    const t = Date.now(), entry = { id: 'oversized-entry', t, iso: new Date(t).toISOString(), kind: 'view.image', actor: 'Visitor', actorType: 'visitor', repo: scope };
    for (const key of ['folder', 'imageName', 'note', 'ua', 'location', 'isp', 'ref', 'tz', 'lang', 'screen', 'ip']) entry[key] = '\u0000'.repeat(220);
    await window.VisualsLogs.append(scope, 'audit', entry, { id: 'wh-' + entry.id, scope, url, entry, createdAt: t, nextAt: 0, attempts: 0 });
    window.dispatchEvent(new Event('online'));
  }, { scope: SCOPE, url });
  await expect.poll(() => calls.some(c => c.attachment?.entry.id === 'oversized-entry')).toBe(true);
  const delivered = calls.find(c => c.attachment?.entry.id === 'oversized-entry');
  expect(delivered.body.allowed_mentions).toEqual({ parse: [] });
  expect(delivered.body.embeds).toBeUndefined();
  expect(delivered.body.attachments[0].filename).toBe('visuals-oversized-entry.json');
  expect(delivered.attachment.entry.note).toBe('\u0000'.repeat(220));
  expect(delivered.attachment.repo).toBe(SCOPE);
  expect(JSON.stringify(delivered.attachment).length).toBeGreaterThan(6000);
  await expect.poll(async () => (await pending(page)).some(t => t.entry.id === 'oversized-entry')).toBe(false);
});
