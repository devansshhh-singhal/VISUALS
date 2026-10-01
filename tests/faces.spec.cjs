const { test, expect, seedConnection, mockGitHub, encodeShare, sharePayload } = require('./helpers.cjs');
const { writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const PROBE = join(tmpdir(), 'visuals-face-probe.png');
writeFileSync(PROBE, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
));

async function installStub(page) {
  await page.addInitScript(() => {
    window.__visualsFaceDetect = async (it) => {
      const other = it && (it.id === 'secret' || it.name === 'Secret' || it.name === 'other-face.png');
      const descriptor = Array.from({ length: 128 }, (_, i) => (i === 0 ? (other ? -0.85 : 0.62) : i === 1 ? 0.2 : 0));
      return [{ box: [0.2, 0.1, 0.35, 0.45], score: 0.91, descriptor }];
    };
  });
}

test('people can be scanned, named and kept out of share links', async ({ page }) => {
  await installStub(page);
  await seedConnection(page);
  const api = await mockGitHub(page);
  await page.goto('/');
  await expect(page.locator('#peopleSec')).toBeVisible();
  await expect(page.locator('#peopleHint')).toContainText('not sent to a face service');
  const roundTrip = await page.evaluate(() => {
    const raw = Array.from({ length: 128 }, (_, i) => (i === 3 ? 0.4 : 0));
    const encoded = window.VisualsFaces.quantize(raw);
    return { encoded, distance: window.VisualsFaces.distance(raw, window.VisualsFaces.dequantize(encoded)) };
  });
  expect(roundTrip.encoded).toMatch(/^[A-Za-z0-9+/]+$/);
  expect(roundTrip.distance).toBeLessThan(0.02);

  await page.locator('#peopleManage').click();
  await expect(page.locator('#peopleSheet')).toBeVisible();
  await expect(page.locator('#peAuto')).not.toBeChecked();
  await page.locator('#peScan').click();
  await expect(page.locator('#peList')).toContainText('Person 1');
  await expect(page.locator('#peList')).toContainText('Person 2');
  await expect(page.locator('#peStatus')).toContainText('Scan finished');

  await page.locator('#peList .row').filter({ hasText: '2 photos' }).locator('[data-person-edit]').click();
  await page.locator('#psName').fill('Alex');
  await page.locator('#psSave').click();
  await expect.poll(() => {
    const write = api.writes.filter(w => w.path === 'contents/faces.json').pop();
    if (!write) return '';
    return Buffer.from(write.body.content, 'base64').toString('utf8');
  }).toContain('"name":"Alex"');
  const saved = JSON.parse(api.writes.filter(w => w.path === 'contents/faces.json').pop().body.content
    ? Buffer.from(api.writes.filter(w => w.path === 'contents/faces.json').pop().body.content, 'base64').toString('utf8') : '{}');
  expect(saved.version).toBe(1);
  expect(saved.faces.every(f => typeof f.d === 'string' && f.d.length > 16)).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('descriptor');
  expect(api.writes.filter(w => w.path === 'contents/library.json').every(w => !Buffer.from(w.body.content, 'base64').toString('utf8').includes('"people"'))).toBe(true);

  await page.locator('#psOpen').click();
  await expect(page.locator('#title')).toHaveText('Alex');
  await expect(page.locator('#grid')).toContainText('Sunrise');
  await expect(page.locator('#grid')).toContainText('Sea');
  await expect(page.locator('#grid')).not.toContainText('Secret');
  await page.locator('#back').click();
  await expect(page.locator('#title')).toHaveText('My Visuals');
  await page.locator('#q').fill('Alex');
  await expect(page.locator('#grid')).toContainText('Sunrise');
  await expect(page.locator('#grid')).not.toContainText('Secret');

  await page.locator('#q').fill('');
  await page.locator('#peopleManage').click();
  await page.locator('#peFile').setInputFiles(PROBE);
  await expect(page.locator('#peMatchOut')).toContainText('Looks like Alex');
  await expect(page.locator('#peMatchOut')).toContainText('not uploaded');
  expect(api.writes.some(w => String(w.path).includes('face-probe'))).toBe(false);

  const recipient = await page.context().newPage();
  const recipientErrors = [];
  recipient.on('pageerror', error => recipientErrors.push(error.message));
  const shared = await mockGitHub(recipient);
  await recipient.goto('/' + encodeShare(sharePayload({ rn: false })));
  await expect(recipient.locator('#title')).toHaveText('Travel');
  await expect(recipient.locator('#peopleSec')).toBeHidden();
  expect(shared.calls.some(c => c.path === 'contents/faces.json')).toBe(false);
  expect(recipientErrors).toEqual([]);
  await recipient.close();
});

test('unreadable face data is left untouched and a forgotten person is not resurrected', async ({ page }) => {
  await installStub(page);
  await seedConnection(page);
  const blocked = await mockGitHub(page, { faces: { version: 2, people: [{ id: 'keep-me', name: 'Do not downgrade' }] } });
  await page.goto('/');
  await page.locator('#peopleManage').click();
  await expect(page.locator('#peScan')).toBeDisabled();
  await expect(page.locator('#peStatus')).toContainText('left untouched');
  await expect(page.locator('#peForget')).toContainText('Replace unreadable');
  expect(blocked.writes.some(w => w.path === 'contents/faces.json')).toBe(false);

  const fresh = await page.context().newPage();
  const freshErrors = [];
  fresh.on('pageerror', error => freshErrors.push(error.message));
  await fresh.addInitScript(faceStubToSource());
  await seedConnection(fresh);
  const api = await mockGitHub(fresh, {
    faces: {
      version: 1,
      people: [{ id: 'p-old', name: 'Riley', hidden: false, createdAt: 1, updatedAt: 1, c: 'aaaa' }],
      faces: [],
      scans: []
    },
    facesConflicts: 1
  });
  await fresh.goto('/');
  await fresh.locator('#peopleManage').click();
  await fresh.locator('#peForget').click();
  await fresh.locator('#peForget').click();
  await expect.poll(() => api.writes.filter(w => w.path === 'contents/faces.json').length).toBe(1);
  const rewritten = JSON.parse(Buffer.from(api.writes.find(w => w.path === 'contents/faces.json').body.content, 'base64').toString('utf8'));
  expect(rewritten.people.some(p => p.id === 'p-old' || p.name === 'Riley')).toBe(false);
  expect(api.calls.some(c => c.path === 'contents/faces.json' && c.conflict)).toBe(true);
  expect(freshErrors).toEqual([]);
  await fresh.close();
});

function faceStubToSource() {
  return () => {
    window.__visualsFaceDetect = async (it) => {
      const other = it && (it.id === 'secret' || it.name === 'Secret');
      const descriptor = Array.from({ length: 128 }, (_, i) => (i === 0 ? (other ? -0.85 : 0.62) : 0));
      return [{ box: [0.2, 0.1, 0.3, 0.4], score: 0.8, descriptor }];
    };
  };
}
