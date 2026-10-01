const {
  test, expect, WRITE_TOKEN, READ_TOKEN, STORAGE_KEY, OWNER_CFG, libraryFixture,
  sharePayload, encodeShare, encryptedShare, decryptShare, seedConnection, savedConfig,
  mockGitHub, openOwnerFolder, createLink
} = require('./helpers.cjs');

async function expectSharedFolder(page) {
  await expect(page.locator('#title')).toHaveText('Travel');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await expect(page.locator('#gear')).toBeHidden();
  await expect(page.locator('#folderShareBtn')).toBeHidden();
  await expect(page.locator('#grid')).not.toContainText('Secret');
  await expect(page.locator('#folderGrid')).toContainText('Coast');
  await expect(page.locator('#folderGrid')).not.toContainText('Private');
}

test('an existing passwordless link opens without a runtime crash', async ({ page }) => {
  const api = await mockGitHub(page);
  await page.goto('/' + encodeShare(sharePayload()));
  await expectSharedFolder(page);
  expect(api.calls.filter(c => c.path === 'contents/library.json').every(c => c.token === 'Bearer ' + READ_TOKEN)).toBe(true);
  expect(api.writes).toHaveLength(0);
});

test('a name-only link uses the share token, not the connection already saved on the device', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await page.goto('/' + encodeShare(sharePayload({ rn: true })));
  await expect(page.locator('#loginGate')).toBeVisible();
  await expect(page.locator('#lgPassRow')).toBeHidden();
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await page.locator('#lgVisitor').fill('Test Visitor');
  await page.locator('#lgSubmit').click();
  await expectSharedFolder(page);
  expect(await savedConfig(page)).toEqual(OWNER_CFG);
  expect(api.calls.every(c => c.token === 'Bearer ' + READ_TOKEN)).toBe(true);
  expect(api.writes).toHaveLength(0);
});

test('a generated-format password-encrypted link opens and honors boolean download restrictions', async ({ page }) => {
  await mockGitHub(page);
  const envelope = await encryptedShare(sharePayload({ rn: true, dl: false }));
  await page.goto('/' + encodeShare(envelope));
  await expect(page.locator('#lgTitle')).toHaveText('Protected Shared Folder');
  await page.locator('#lgVisitor').fill('Test Visitor');
  await page.locator('#lgPass').fill('secret123');
  await page.locator('#lgSubmit').click();
  await expectSharedFolder(page);
  await expect(page.locator('#shareDock')).toBeHidden();
  await expect(page.locator('#banner')).toContainText('downloads disabled');
});

test('legacy AES-GCM envelopes without an enc flag still prompt for a password', async ({ page }) => {
  await mockGitHub(page);
  const envelope = await encryptedShare(sharePayload());
  delete envelope.enc;
  await page.goto('/' + encodeShare(envelope));
  await expect(page.locator('#lgPassRow')).toBeVisible();
  await expect(page.locator('#lgVisitorRow')).toBeHidden();
  await page.locator('#lgPass').fill('secret123');
  await page.locator('#lgSubmit').click();
  await expectSharedFolder(page);
});

test('a wrong password ends the animation and permits a successful retry', async ({ page }) => {
  await mockGitHub(page);
  const envelope = await encryptedShare(sharePayload());
  await page.goto('/' + encodeShare(envelope));
  await page.locator('#lgPass').fill('incorrect');
  await page.locator('#lgSubmit').click();
  await expect(page.locator('#lgMsg')).toContainText('Incorrect password');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await expect(page.locator('#lgSubmit')).toBeEnabled();
  await page.locator('#lgPass').fill('secret123');
  await page.locator('#lgSubmit').click();
  await expectSharedFolder(page);
});

test('encrypted inner expiry is enforced even if the outer expiry is removed', async ({ page }) => {
  await mockGitHub(page);
  const envelope = await encryptedShare(sharePayload({ exp: Date.now() - 10000 }), 'secret123', { exp: 0 });
  await page.goto('/' + encodeShare(envelope));
  await page.locator('#lgPass').fill('secret123');
  await page.locator('#lgSubmit').click();
  await expect(page.locator('#empty')).toContainText('expired');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await expect(page.locator('#title')).not.toHaveText('Travel');
});

test('inner name requirements cannot be skipped by editing outer encrypted fields', async ({ page }) => {
  await mockGitHub(page);
  const envelope = await encryptedShare(sharePayload({ rn: true }), 'secret123', { rn: false });
  await page.goto('/' + encodeShare(envelope));
  await page.locator('#lgPass').fill('secret123');
  await page.locator('#lgSubmit').click();
  await expect(page.locator('#lgVisitorRow')).toBeVisible();
  await expect(page.locator('#lgMsg')).toContainText('name or email');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await page.locator('#lgVisitor').fill('Visitor');
  await page.locator('#lgSubmit').click();
  await expectSharedFolder(page);
});

for (const fragment of ['#share=', '#share=not-base64', encodeShare({ enc: true }), encodeShare({ o: 'tester', r: 'visuals-data', t: READ_TOKEN })]) {
  test('malformed link shows an error without falling back to owner credentials: ' + fragment.slice(0, 32), async ({ page }) => {
    await seedConnection(page);
    const api = await mockGitHub(page);
    await page.goto('/' + fragment);
    await expect(page.locator('#empty')).toContainText('incomplete or invalid');
    await expect(page.locator('#loadingStatus')).toBeHidden();
    await expect(page.locator('#gear')).toBeHidden();
    await expect(page.locator('#empty')).not.toContainText('Open settings');
    expect(api.calls).toHaveLength(0);
    expect(await savedConfig(page)).toEqual(OWNER_CFG);
  });
}

for (const [status, message] of [[401, 'invalid, expired or revoked'], [403, 'denied access'], [404, "wasn't found"], [500, 'status 500']]) {
  test('GitHub ' + status + ' ends loading with a useful error and retry', async ({ page }) => {
    await mockGitHub(page, { libraryStatus: status });
    await page.goto('/' + encodeShare(sharePayload()));
    await expect(page.locator('#empty')).toContainText(message);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(page.locator('#loadingStatus')).toBeHidden();
    await expect(page.locator('#lgMsg')).not.toContainText('Incorrect password');
  });
}

test('a slow request shows the top animation, times out, and can be retried', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let hold = true;
  const api = await mockGitHub(page, { holdLibrary: async () => { if (hold) await held; } });
  await page.clock.install();
  await page.goto('/' + encodeShare(sharePayload()));
  await expect.poll(() => api.calls.filter(c => c.path === 'contents/library.json').length).toBe(1);
  await expect(page.locator('#loadingStatus')).toBeVisible();
  await expect(page.locator('.app')).toHaveAttribute('aria-busy', 'true');
  await page.clock.fastForward(21000);
  await expect(page.locator('#empty')).toContainText('timed out');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  hold = false; release();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expectSharedFolder(page);
});

test('large metadata uses the authenticated raw fallback', async ({ page }) => {
  const api = await mockGitHub(page, { rawLibrary: true });
  await page.goto('/' + encodeShare(sharePayload()));
  await expectSharedFolder(page);
  expect(api.calls.filter(c => c.path === 'contents/library.json')).toHaveLength(2);
  expect(api.calls.find(c => c.accept?.includes('raw')).token).toBe('Bearer ' + READ_TOKEN);
});

test('raw fallback HTTP failures are not silently parsed as library metadata', async ({ page }) => {
  await mockGitHub(page, { rawLibrary: true, rawStatus: 403 });
  await page.goto('/' + encodeShare(sharePayload()));
  await expect(page.locator('#empty')).toContainText('denied access');
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('tracked revoked links are blocked using the generated id field', async ({ page }) => {
  const library = libraryFixture(); library.shareLinks[0].revoked = true;
  await mockGitHub(page, { library });
  await page.goto('/' + encodeShare(sharePayload()));
  await expect(page.locator('#empty')).toContainText('revoked by the owner');
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await expect(page.locator('#grid')).not.toContainText('Sunrise');
});

test('revoke-all also blocks links whose metadata has aged out of the recent links list', async ({ page }) => {
  const library = libraryFixture(); library.shareLinks = []; library.shareRevokedBefore = Date.now();
  await mockGitHub(page, { library });
  await page.goto('/' + encodeShare(sharePayload({ cat: Date.now() - 60000 })));
  await expect(page.locator('#empty')).toContainText('revoked by the owner');
});

test('legacy sid links and numeric download flags remain compatible', async ({ page }) => {
  await mockGitHub(page);
  const payload = sharePayload({ dl: 0, sid: 'test-link' }); delete payload.id;
  await page.goto('/' + encodeShare(payload));
  await expectSharedFolder(page);
  await expect(page.locator('#shareDock')).toBeHidden();
});

test('a deleted shared folder shows a terminal error instead of loading forever', async ({ page }) => {
  await mockGitHub(page);
  await page.goto('/' + encodeShare(sharePayload({ f: 'deleted-folder' })));
  await expect(page.locator('#empty')).toContainText('no longer exists');
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('both tokens are managed once in Settings and reused after reload', async ({ page }) => {
  await seedConnection(page, { ...OWNER_CFG, readToken: '', readTokenConfirmed: false });
  await mockGitHub(page);
  await page.goto('/');
  await page.locator('#gear').click();
  await expect(page.locator('#sToken')).toHaveValue(WRITE_TOKEN);
  await expect(page.locator('#sReadToken')).toHaveValue('');
  await expect(page.locator('#sToken')).toHaveAttribute('type', 'password');
  await page.locator('#sReadToken').fill(READ_TOKEN);
  await page.locator('#sReadConfirm').check();
  await page.locator('#sSave').click();
  await expect(page.locator('#settings')).toBeHidden();
  expect((await savedConfig(page)).readToken).toBe(READ_TOKEN);
  await page.reload();
  await page.goto('/#f=travel');
  await page.locator('#folderShareBtn').click();
  await expect(page.locator('#fShareTokenStatus')).toContainText('saved in Settings');
  await expect(page.locator('#folderSheet #sReadToken')).toHaveCount(0);
  await expect(page.locator('#fShareToken')).toHaveCount(0);
  await page.locator('#fClose').click();
  await page.locator('#back').click();
  await page.getByRole('button', { name: /^Open folder Private/ }).click();
  await page.locator('#folderShareBtn').click();
  await expect(page.locator('#fShareTokenStatus')).toContainText('saved in Settings');
});

test('Settings rejects a write token reused for sharing', async ({ page }) => {
  await seedConnection(page);
  await mockGitHub(page);
  await page.goto('/'); await page.locator('#gear').click();
  await page.locator('#sReadToken').fill(WRITE_TOKEN);
  await page.locator('#sReadConfirm').check(); await page.locator('#sSave').click();
  await expect(page.locator('#sMsg')).toContainText('Never share your connected write token');
  expect((await savedConfig(page)).readToken).toBe(READ_TOKEN);
});

test('changing a read-only token resets the permission confirmation', async ({ page }) => {
  await seedConnection(page); await mockGitHub(page);
  await page.goto('/'); await page.locator('#gear').click();
  await expect(page.locator('#sReadConfirm')).toBeChecked();
  await page.locator('#sReadToken').fill('github_pat_other_read_token');
  await expect(page.locator('#sReadConfirm')).not.toBeChecked();
  await page.locator('#sSave').click();
  await expect(page.locator('#sMsg')).toContainText('Confirm');
});

test('a rejected sharing token leaves the previously saved connection untouched', async ({ page }) => {
  await seedConnection(page);
  await mockGitHub(page, { badTokens: ['Bearer github_pat_invalid'] });
  await page.goto('/'); await page.locator('#gear').click();
  await page.locator('#sReadToken').fill('github_pat_invalid');
  await page.locator('#sReadConfirm').check(); await page.locator('#sSave').click();
  await expect(page.locator('#sMsg')).toContainText('rejected the read-only token');
  await expect(page.locator('#sSave')).toBeEnabled();
  await expect(page.locator('#loadingStatus')).toBeHidden();
  expect(await savedConfig(page)).toEqual(OWNER_CFG);
});

test('branch errors are not accepted as a successful connection', async ({ page }) => {
  await seedConnection(page); await mockGitHub(page, { branchStatus: 403 });
  await page.goto('/'); await page.locator('#gear').click(); await page.locator('#sSave').click();
  await expect(page.locator('#sMsg')).toContainText('denied access');
  await expect(page.locator('#settings')).toBeVisible();
  expect(await savedConfig(page)).toEqual(OWNER_CFG);
});

test('generated links contain only the Settings read-only token and persist revocation metadata first', async ({ page, context }) => {
  await seedConnection(page); const api = await mockGitHub(page);
  await openOwnerFolder(page);
  const url = await createLink(page);
  const payload = JSON.parse(Buffer.from(new URL(url).hash.slice(7), 'base64url').toString('utf8'));
  expect(payload.t).toBe(READ_TOKEN); expect(payload.t).not.toBe(WRITE_TOKEN);
  expect(payload.cat).toBeGreaterThan(0);
  const entry = api.library.shareLinks.find(s => s.id === payload.id);
  expect(entry.folderId).toBe('travel'); expect(api.writes.length).toBeGreaterThan(0);
  expect(api.writes.every(c => c.token === 'Bearer ' + WRITE_TOKEN)).toBe(true);
  await expect(page.locator('#loadingStatus')).toBeHidden();
  const recipient = await context.newPage();
  await mockGitHub(recipient, { library: api.library });
  await recipient.goto('/' + new URL(url).hash);
  await expectSharedFolder(recipient);
  await recipient.close();
});

test('password-encrypted link generation matches the recipient decryption format', async ({ page }) => {
  await seedConnection(page); const api = await mockGitHub(page); await openOwnerFolder(page);
  const url = await createLink(page, { password: 'secret123', requireName: true });
  const envelope = JSON.parse(Buffer.from(new URL(url).hash.slice(7), 'base64url').toString('utf8'));
  expect(envelope.enc).toBe(true); expect(envelope.t).toBeUndefined();
  const inner = await decryptShare(envelope, 'secret123');
  expect(inner.t).toBe(READ_TOKEN); expect(inner.rn).toBe(true); expect(inner.f).toBe('travel');
  expect(api.library.shareLinks.find(s => s.id === inner.id).passwordProtected).toBe(true);
  await expect(page.locator('#fShareActiveList')).toContainText('AES-256 Password');
});

test('a link is not shown if saving its security metadata fails', async ({ page }) => {
  await seedConnection(page); await mockGitHub(page, { failWrite: true }); await openOwnerFolder(page);
  await page.locator('#fShareUsePass').uncheck(); await page.locator('#fShareGo').click();
  await expect(page.locator('#fShareMsg')).toContainText('could not be saved');
  await expect(page.locator('#fShareOut')).toBeHidden();
  await expect(page.locator('#fShareGo')).toBeEnabled();
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('closing the sharing sheet cancels a pending check and clears its animation', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await seedConnection(page);
  const api = await mockGitHub(page, { holdLibrary: async call => { if (call.token === 'Bearer ' + READ_TOKEN) await held; } });
  await openOwnerFolder(page); await page.locator('#fShareUsePass').uncheck();
  await page.locator('#fShareGo').click();
  await expect.poll(() => api.calls.filter(c => c.path === 'contents/library.json' && c.token === 'Bearer ' + READ_TOKEN).length).toBe(1);
  await expect(page.locator('#loadingStatus')).toBeVisible();
  await page.locator('#fClose').click(); release();
  await expect(page.locator('#loadingStatus')).toBeHidden();
  await expect(page.locator('#fShareOut')).toBeHidden();
  expect(api.writes).toHaveLength(0);
});

test('device passwords encrypt and restore both tokens, including later Settings changes', async ({ page }) => {
  await seedConnection(page); await mockGitHub(page);
  await page.goto('/'); await page.locator('#securityBtn').click();
  await page.locator('#secLockRequireName').uncheck();
  await page.locator('#secLockPass').fill('devicepass123'); await page.locator('#secLockSave').click();
  await expect(page.locator('#secLockMsg')).toContainText('Both GitHub tokens');
  let cfg = await savedConfig(page);
  expect(cfg.token).toBe(''); expect(cfg.readToken).toBe(''); expect(cfg.lockRequireName).toBe(false);
  expect(JSON.stringify(cfg)).not.toContain(WRITE_TOKEN); expect(JSON.stringify(cfg)).not.toContain(READ_TOKEN);
  await page.reload(); await expect(page.locator('#loginGate')).toBeVisible();
  await expect(page.locator('#lgVisitorRow')).toBeHidden();
  await page.locator('#lgPass').fill('devicepass123'); await page.locator('#lgSubmit').click();
  await expect(page.locator('#loginGate')).toBeHidden();
  await page.locator('#gear').click(); await expect(page.locator('#sReadToken')).toHaveValue(READ_TOKEN);
  await page.locator('#sReadToken').fill('github_pat_updated_read'); await page.locator('#sReadConfirm').check();
  await page.locator('#sSave').click(); await expect(page.locator('#settings')).toBeHidden();
  cfg = await savedConfig(page); expect(cfg.locked).toBe(true); expect(cfg.token).toBe(''); expect(cfg.readToken).toBe('');
  expect(JSON.stringify(cfg)).not.toContain('github_pat_updated_read');
  await page.reload(); await page.locator('#lgPass').fill('devicepass123'); await page.locator('#lgSubmit').click();
  await expect(page.locator('#loginGate')).toBeHidden();
  await page.locator('#gear').click(); await expect(page.locator('#sReadToken')).toHaveValue('github_pat_updated_read');
});

test('loading animation respects reduced-motion preferences', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  expect(await page.locator('#loadingStatus .loading-spinner').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  expect(await page.locator('#loadingStatus .loading-track span').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});

test('development server does not expose repository internals', async ({ request }) => {
  expect((await request.get('/.git/config')).status()).toBe(404);
  expect((await request.get('/package-lock.json')).status()).toBe(404);
});

test('a request whose response headers arrive but body stalls also times out', async ({ page }) => {
  await page.addInitScript(() => {
    const realFetch = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).includes('/contents/library.json')) {
        const body = new ReadableStream({
          start(controller) {
            options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
          }
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(url, options);
    };
  });
  await page.clock.install();
  await page.goto('/' + encodeShare(sharePayload()));
  await expect(page.locator('#loadingStatus')).toBeVisible();
  await page.clock.fastForward(21000);
  await expect(page.locator('#empty')).toContainText('timed out');
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('network failures show an offline message, not an endless loader', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.route('https://api.github.com/**', route => route.abort('failed'));
  await page.goto('/' + encodeShare(sharePayload()));
  await expect(page.locator('#empty')).toContainText("You're offline");
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('corrupted library metadata gives a readable error', async ({ page }) => {
  await page.route('https://api.github.com/**', route => route.fulfill({ json: { sha: 'bad-sha', content: Buffer.from('not JSON').toString('base64') } }));
  await page.goto('/' + encodeShare(sharePayload()));
  await expect(page.locator('#empty')).toContainText('library metadata is invalid');
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('invalid crypto work factors are rejected without getting stuck decrypting', async ({ page }) => {
  const envelope = await encryptedShare(sharePayload(), 'secret123', { it: 2000000000 });
  await page.goto('/' + encodeShare(envelope));
  await page.locator('#lgPass').fill('secret123'); await page.locator('#lgSubmit').click();
  await expect(page.locator('#lgMsg')).toContainText('Invalid encryption settings');
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('unavailable Web Crypto gives an HTTPS hint instead of a false wrong-password error', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window.crypto, 'subtle', { value: undefined }));
  const envelope = await encryptedShare(sharePayload());
  await page.goto('/' + encodeShare(envelope));
  await page.locator('#lgPass').fill('secret123'); await page.locator('#lgSubmit').click();
  await expect(page.locator('#lgMsg')).toContainText('secure HTTPS');
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('corrupted device configuration does not stop the app from opening', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, 'null'), STORAGE_KEY);
  await page.goto('/');
  await expect(page.locator('#empty')).toContainText('Connect your library');
  await expect(page.locator('#loadingStatus')).toBeHidden();
});

test('removing a sharing token in Settings leaves the editing token connected', async ({ page }) => {
  await seedConnection(page); await mockGitHub(page);
  await page.goto('/'); await page.locator('#gear').click();
  await page.locator('#sReadToken').fill(''); await page.locator('#sSave').click();
  await expect(page.locator('#settings')).toBeHidden();
  const cfg = await savedConfig(page);
  expect(cfg.token).toBe(WRITE_TOKEN); expect(cfg.readToken).toBe(''); expect(cfg.readTokenConfirmed).toBe(false);
  await page.goto('/#f=travel'); await page.locator('#folderShareBtn').click();
  await expect(page.locator('#fShareTokenStatus')).toContainText('Add and confirm');
  await expect(page.locator('#fShareGo')).toBeDisabled();
  await page.locator('#fShareSettings').click();
  await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('#sReadToken')).toBeFocused();
});

test('Settings token controls and the loading status fit a narrow mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedConnection(page); await mockGitHub(page);
  await page.goto('/'); await page.locator('#gear').click();
  await page.locator('#sReadToken').scrollIntoViewIfNeeded();
  expect(await page.locator('#settings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator('#sReadToken')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show read-only token', exact: true }).click();
  await expect(page.locator('#sReadToken')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide read-only token', exact: true }).click();
  await expect(page.locator('#sReadToken')).toHaveAttribute('type', 'password');
});

test('failed owner loads hide editing actions while preserving reconnect and retry', async ({ page }) => {
  await seedConnection(page); await mockGitHub(page, { libraryStatus: 401 });
  await page.goto('/');
  await expect(page.locator('#empty')).toContainText('GitHub rejected your token');
  await expect(page.locator('#dock')).toBeHidden();
  await expect(page.locator('#gear')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
});

test('pasting a share link into a tab already showing the owner app reloads into read-only sharing', async ({ page }) => {
  await seedConnection(page); const api = await mockGitHub(page);
  await page.goto('/'); await expect(page.locator('#gear')).toBeVisible();
  await page.goto('/' + encodeShare(sharePayload()));
  await expectSharedFolder(page);
  expect(api.calls.some(c => c.path === 'contents/library.json' && c.token === 'Bearer ' + READ_TOKEN)).toBe(true);
  expect(await savedConfig(page)).toEqual(OWNER_CFG);
});

test('changing between shared links in the same tab reparses the new folder and credentials', async ({ page }) => {
  await mockGitHub(page);
  await page.goto('/' + encodeShare(sharePayload())); await expectSharedFolder(page);
  await page.goto('/' + encodeShare(sharePayload({ f: 'private', id: 'second-link' })));
  await expect(page.locator('#title')).toHaveText('Private');
  await expect(page.locator('#grid')).toContainText('Secret');
  await expect(page.locator('#grid')).not.toContainText('Sunrise');
  await expect(page.locator('#gear')).toBeHidden();
  await expect(page.locator('#loadingStatus')).toBeHidden();
});
