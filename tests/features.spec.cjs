const {
  test, expect, WRITE_TOKEN, READ_TOKEN, libraryFixture, sharePayload, encodeShare,
  seedConnection, mockGitHub, openOwnerFolder, createLink, decryptShare
} = require('./helpers.cjs');

async function decodePayload(url) {
  return JSON.parse(Buffer.from(new URL(url).hash.slice(7), 'base64url').toString('utf8'));
}

function bigLibrary(count = 150) {
  const library = libraryFixture();
  for (let i = 0; i < count; i++) {
    library.items.push({ id: 'bulk-' + i, file: 'bulk-' + i + '.svg', name: 'Bulk ' + i, folder: 'travel',
      type: 'image/svg+xml', size: 100, order: 10 + i, createdAt: 100 + i, tags: [] });
  }
  return library;
}

test('share links carry view/download/write modes and never a per-link webhook', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await openOwnerFolder(page);
  const url = await createLink(page, { mode: 'view', requireName: false });
  const payload = await decodePayload(url);
  expect(payload.md).toBe('view');
  expect(payload.wh).toBeUndefined();
  expect(api.library.shareLinks.find(s => s.id === payload.id).mode).toBe('view');

  const recipient = await page.context().newPage();
  await mockGitHub(recipient, { library: api.library });
  await recipient.goto('/' + new URL(url).hash);
  await expect(recipient.locator('#title')).toHaveText('Travel');
  await expect(recipient.locator('#shareDock')).toBeHidden();
  await expect(recipient.locator('#banner')).toContainText('view-only');
  await recipient.close();
});

test('a write link lets a visitor upload while deletion stays impossible', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await openOwnerFolder(page);
  const url = await createLink(page, { mode: 'write', password: 'secret123', maxUploads: 5 });
  const payload = await decodePayload(url);
  expect(payload.md).toBe('write');
  expect(payload.lim.u).toBe(5);
  expect(payload.t).toBeUndefined(); // The token is encrypted, not on the envelope.
  expect((await decryptShare(payload, 'secret123')).t).toBe(WRITE_TOKEN);

  const recipient = await page.context().newPage();
  await mockGitHub(recipient, { library: api.library });
  await recipient.goto('/' + new URL(url).hash);
  await recipient.locator('#lgPass').fill('secret123');
  await recipient.locator('#lgSubmit').click();
  await expect(recipient.locator('#title')).toHaveText('Travel');
  await expect(recipient.locator('#banner')).toContainText('add files');
  await expect(recipient.locator('#bDel')).toBeHidden();
  await recipient.close();
});

test('a scoped link opens only the chosen subfolder and lists the remaining usage', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await openOwnerFolder(page);
  const url = await createLink(page, { scope: 'coast', maxViews: 3, maxDls: 2, watermark: 'Preview only', requireName: false });
  const payload = await decodePayload(url);
  expect(payload.sc).toBe('coast');
  expect(payload.lim).toEqual({ v: 3, d: 2 });
  expect(payload.wm).toEqual({ p: 'br', t: 'Preview only' });

  const recipient = await page.context().newPage();
  await mockGitHub(recipient, { library: api.library });
  await recipient.goto('/' + new URL(url).hash);
  await expect(recipient.locator('#title')).toHaveText('Coast');
  await expect(recipient.locator('#grid')).toContainText('Sea');
  await expect(recipient.locator('#grid')).not.toContainText('Sunrise');
  await expect(recipient.locator('#banner')).toContainText('views left');
  await recipient.locator('[data-item-id="sea"] .open').click();
  await recipient.locator('#vInfo').click();
  await expect(recipient.locator('#detail .wm-layer')).toContainText('Preview only');
  await recipient.close();
});

test('the audit log records sharing, edits and settings changes for the owner', async ({ page }) => {
  await seedConnection(page);
  await mockGitHub(page);
  await openOwnerFolder(page);
  await createLink(page, { requireName: false });
  await page.locator('#fClose').click();
  await page.locator('#activityBtn').click();
  await expect(page.locator('#activitySheet')).toBeVisible();
  await page.locator('#aClose').click();
  await page.locator('#gear').click();
  await page.locator('#sAudit').click();
  await expect(page.locator('#auditSheet')).toBeVisible();
  await expect(page.locator('#auList')).toContainText('share');
  const stored = await page.evaluate(() => localStorage.getItem('visuals-audit-v1:tester/visuals-data@main') || '');
  expect(stored).toContain('share.create');
  await expect(page.locator('#auCsv')).toBeVisible();
});

test('deleting a file moves it to the trash and the undo restores it', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await page.goto('/#f=travel');
  await page.locator('[data-item-id="sunrise"] .open').click();
  await page.locator('#vInfo').click();
  await page.locator('#dDel').click();
  await page.locator('#dDel').click();
  await expect(page.locator('#toast')).toContainText('trash');
  const stored = api.writes.filter(w => w.path === 'contents/library.json').pop();
  expect(stored.body.content).toBeTruthy();
  await page.locator('#toast .textbtn').click();
  await expect(page.locator('#grid')).toContainText('Sunrise');
  expect(api.deletes).toHaveLength(0);
});

test('the image editor archives the old file and records a content patch', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await page.goto('/#f=travel');
  await page.locator('[data-item-id="sunrise"] .open').click();
  await page.locator('#vInfo').click();
  await page.locator('#dEdit').click();
  await expect(page.locator('#editorSheet')).toBeVisible();
  await expect(page.locator('#edSave')).toBeDisabled();
  await page.locator('#edRotR').click();
  await page.locator('#edCropSquare').click();
  await expect(page.locator('#edOps')).toContainText('crop square');
  await page.locator('#edSave').click();
  await expect(page.locator('#editorSheet')).toBeHidden();
  expect(api.writes.some(w => w.path.startsWith('contents/versions/'))).toBe(true);
  expect(api.writes.some(w => w.path === 'contents/images/sunrise.svg')).toBe(true);
  const library = api.writes.filter(w => w.path === 'contents/library.json').pop().body;
  const item = JSON.parse(Buffer.from(library.content, 'base64').toString('utf8')).items.find(i => i.id === 'sunrise');
  expect(item.contentPatches.length).toBe(1);
  expect(item.versions.length).toBe(1);
});

test('collections and smart folders organise files without re-uploading them', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await page.goto('/#f=travel');
  await page.locator('#selectBtn').click();
  await page.locator('[data-item-id="sunrise"] .open').click();
  await page.locator('#bCollect').click();
  await page.locator('#ctNew').click();
  await page.locator('#coName').fill('Best of 2021');
  await page.locator('#coSave').click();
  await page.locator('#bDone').click();
  await page.locator('#back').click();
  await expect(page.locator('#title')).toHaveText('My Visuals');
  await expect(page.locator('[data-collection-id]')).toContainText('Best of 2021');
  await page.locator('[data-collection-id] .open').click();
  await expect(page.locator('#grid')).toContainText('Sunrise');
  const library = JSON.parse(Buffer.from(api.writes.filter(w => w.path === 'contents/library.json').pop().body.content, 'base64').toString('utf8'));
  expect(library.collections[0].name).toBe('Best of 2021');
  // smart folders are built in and saved searches can be added
  await page.locator('#back').click();
  await expect(page.locator('#smartChips')).toContainText('Recently added');
  await page.locator('#q').fill('sea');
  await expect(page.locator('#saveSearch')).toBeVisible();
  await page.locator('#saveSearch').click();
  await expect(page.locator('#smartChips')).toContainText('sea');
});

test('the storage check finds orphan files and removes them', async ({ page }) => {
  await seedConnection(page);
  const api = await mockGitHub(page);
  await page.goto('/');
  await page.locator('#gear').click();
  await page.locator('#sStorageScan').click();
  await expect(page.locator('#storageReport')).toContainText('images/orphan.svg');
  await expect(page.locator('#sStorageClean')).toBeVisible();
  await page.locator('#sStorageClean').click();
  await expect(page.locator('#sStorageClean')).toContainText('Tap again');
  await page.locator('#sStorageClean').click();
  await expect.poll(() => api.deletes.length).toBe(1);
  expect(api.deletes[0].path).toBe('contents/images/orphan.svg');
  expect(api.tree['images/sunrise.svg']).toBeTruthy();
});

test('the grid renders in batches and loads more as it is scrolled', async ({ page }) => {
  await seedConnection(page);
  await mockGitHub(page, { library: bigLibrary(150) });
  await page.goto('/#f=travel');
  await expect(page.locator('#grid .tile')).toHaveCount(60);
  await expect(page.locator('#gridMore')).toContainText('91 left');
  await page.locator('#gridMore').scrollIntoViewIfNeeded();
  await expect(page.locator('#grid .tile')).toHaveCount(120);
  await page.locator('#gridMore').scrollIntoViewIfNeeded();
  await expect(page.locator('#grid .tile')).toHaveCount(151);
  await expect(page.locator('#gridMore')).toHaveCount(0);
});

test('settings let the owner switch the appearance and reach the audit tools', async ({ page }) => {
  await seedConnection(page);
  await mockGitHub(page);
  await page.goto('/');
  await page.locator('#gear').click();
  await page.locator('#sThemeDark').click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await page.locator('#sShortcuts').click();
  await expect(page.locator('#shortcutsSheet')).toBeVisible();
  await expect(page.locator('#ksList')).toContainText('command palette');
});

test('a legacy link carrying its own webhook still opens, using the Settings webhook instead', async ({ page }) => {
  await mockGitHub(page);
  await page.goto('/' + encodeShare(sharePayload({ wh: 'https://legacy.example/hook' })));
  await expect(page.locator('#title')).toHaveText('Travel');
  const calls = await page.evaluate(() => window.__fetchLog || []);
  expect(calls.some(u => String(u).includes('legacy.example'))).toBe(false);
});
