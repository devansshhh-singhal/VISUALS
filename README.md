# My Visuals

A static, installable visual library backed by a private GitHub data repository.
The app is in `index.html`; no runtime build or backend is required.

## Connect and share

1. Create a private data repository (for example, `visuals-data`) and initialize it with a README.
2. In the app's **Settings**, save your GitHub username, repository, and a token with **Contents → Read and write** for editing on this device.
3. In the same Settings panel, optionally save a **separate fine-grained token** with **Contents → Read-only**, limited to the same data repository. Confirm its read-only permission and select **Save and connect**. This token is reused for all folders; tokens are no longer entered in individual folder forms.
4. Open a folder and choose **Share folder**. Use the HTTPS address where this app is deployed, not a localhost address. Password protection is enabled by default; send the password separately.
5. Pick what the link may do — **View only**, **View + download** or **View + upload** — and optionally narrow it to one subfolder, cap views/downloads/uploads, or stamp a watermark on everything opened through it.

### Share link permissions

- **View only** hides the download buttons and the folder `.zip`.
- **View + download** is the classic link.
- **View + upload** carries the read-and-write token (so the password and an expiry are
  mandatory). Visitors can view, download and add files into the shared folder only —
  they can never delete, rename, move or edit anything that already exists.
- The permission mode travels in the link payload as `md` (`view`/`dl`/`write`).
  Legacy links with only a `dl` boolean still work: `dl:false` means view-only.
- **Scope, limits and watermark** are stored in the payload (`sc`, `lim`, `wm`) and in
  the saved link record. Counters live on each visitor device and are written back by
  upload links, so limits are a strong hint rather than a hard server-side guarantee.
- The audit **webhook is configured once in Settings** and is used by every link. Older
  links that embedded their own webhook (`wh`) are ignored on purpose: only the
  Settings endpoint receives events.

### Audit log

Every action is recorded in one place: logins and failed logins, blocked downloads,
file views with dwell time, downloads, uploads, edits, deleted and restored files,
folders, collections, smart folders, share links created/revoked/copied, settings and
security changes, offline queue activity, storage checks and orphan cleanup — including
exports of the audit log itself and clearing it. Entries carry who did it (owner or visitor),
the folder/file/link, time, and device details (IP, location, platform, screen, time
zone) when available.

- **On this device** the log lives in `localStorage` (`visuals-audit-v1:…`, 1200 entries).
- **In the repository** it is committed to `contents/audit.json` a few seconds after the
  last event (owner devices with a write token; visitors never write repository files).
- **By webhook** each entry is POSTed to the endpoint from Settings in batches of ten.
- Open it from **Settings → Audit & insight → Audit log**, filter by group or actor, and
  export `.csv`/`.json`. **Sharing analytics** summarises views, downloads and uploads
  per link, hour of day and top actors.

### Library tools

- **Trash**: deleting moves files to a 30-day, 200-item trash (with an Undo toast)
  instead of removing them; restore or purge from **Settings → Trash**.
- **Image editor**: crop, rotate, flip, brightness, contrast and saturation. Saving
  archives the current bytes under `versions/`, replaces the file in place and appends a
  `contentPatches` entry, so an edit never destroys the original. Restore any archived
  version from the same sheet.
- **Collections**: named sets that gather files from any folder. Add the current
  selection with **Add to collection**; membership lives in `library.json` and never
  re-uploads a file.
- **Smart folders**: built-in Favorites, Videos, Geotagged and Recently added views plus
  saved searches ("Save this search") stored with the library.
- **Storage check**: Settings lists what the repository actually stores, flags orphaned
  previews or archived versions, and can delete them (with a second confirming tap).
- **Large libraries**: the grid renders in batches of 60 as you scroll, uses tiny blurred
  placeholders for tiles that have them, and prefetches upcoming previews.

Existing device connections and older sharing-link formats remain supported.
Recipients never overwrite the connection already saved on their device.
Both tokens are encrypted in browser storage when a device password is enabled,
including when you update the tokens later in Settings.

### Security boundaries

- Editing tokens are never included in generated sharing links.
- Unencrypted links contain the read-only credential in the URL fragment; treat them as secrets. Password-protected links encrypt that credential with PBKDF2-SHA256 and AES-256-GCM.
- GitHub tokens grant **repository-level**, not folder-level, access. Folder filtering, expiry, download controls, and per-link revocation are enforced by the app, not by GitHub. Use separate repositories for strict isolation, and revoke the token on GitHub to fully cut off API access.
- Read-only visitors cannot write login logs to your repository. Visitor logs remain on their device unless a configured webhook receives them.
- Never commit real tokens, generated sharing links, or passwords to this repository.

## Loading and troubleshooting

A top-of-screen spinner and animated progress bar indicate library loads, token
checks, link creation, uploads, saves, media downloads, and ZIP preparation.
The animation respects reduced-motion preferences.

Metadata requests time out after 20 seconds; file transfers and writes time out
after 90 seconds. Network errors, rejected tokens, missing folders, expired links,
and revoked links display a useful message instead of remaining on “Loading.”
Use **Try again** for a transient connection issue. For invalid/expired credentials,
replace the token in Settings and generate a new link.

After deploying changes, reload the app to run the updated sharing code.
`sw.js` versions the offline app shell; private GitHub API responses do not go
through that service worker.

## Local development and tests

Requires Python 3 and Node.js 20 or later for the browser tests.

```sh
npm ci
npm run dev
```

The development server listens on `0.0.0.0:4173` and only exposes the public app
files, not `.git`, test files, or development dependencies.

```sh
npx playwright install --with-deps chromium
npm test
```

Tests use mocked GitHub responses and fake credentials. `tests/sharing.spec.cjs` covers
plaintext and encrypted links, legacy formats, permissions, expiry/revocation, failed and
timed-out requests, cancellation, repository-wide token settings, and device-lock
encryption. `tests/features.spec.cjs` covers the audit log, the trash, the image editor
and archived versions, collections and smart folders, share scopes/limits/watermarks,
the storage check, and the batched grid. No real data repository is contacted or modified
by the tests.
