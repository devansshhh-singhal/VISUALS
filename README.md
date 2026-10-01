# My Visuals

A static, installable visual library backed by a private GitHub data repository.
The app is in `index.html`, with durable logging/webhook delivery in `activity-log.js`;
no runtime build or application backend is required.

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
- The activity **webhook is configured once in Settings → Security & Logins** and
  published as `library.json.auditWebhook`. All folders and links use that setting;
  there is no per-folder webhook input. Legacy custom `wh` URLs are still ignored.
- New links automatically carry a non-secret `audit` routing snapshot (`v`, `url`,
  `scope`) in both the payload and, for encrypted links, the outer envelope. This lets
  access attempts reach the webhook **before a password is successfully decrypted**.
  The current repository setting is used once the library can be read. Existing links
  without a snapshot pick up the repository setting after access; earlier attempts are
  queued locally and sent when that same link is successfully opened.

### Receiver activity and audit history

Every recorded action creates a separate, timestamped audit entry. Shared-link receiver
entries include the link ID, repository, session ID, sequence, actor/name, folder/file,
result/status and device/browser details. IP and approximate location are included when
available; they are optional, not a reason to delay or discard an entry. Passwords,
GitHub credentials and complete sharing URLs are never included in webhook payloads.
Recipients see an activity notice on the login screen and shared-folder banner.

Receiver events include:

- **Each link visit**, including anonymous/passwordless visits; successful access;
  missing name/password, incorrect passwords, invalid/expired/revoked links, missing
  folders, GitHub load errors and exhausted visit limits.
- **Every file open**, including sub-second views and quick reopens; separate viewing
  durations on file changes, closing the viewer, backgrounding the tab and page exit.
- Folder navigation, file details, completed/debounced searches, filters and sort changes;
  video play/pause/seek/end and load/playback failures.
- Individual and ZIP download requests, successes, failures and permission/limit denials.
  ZIP downloads also respect the link's download count.
- Upload starts and **per-file** successes, failures, size/type/usage-limit denials and
  upload-dialog cancellation.
- Background/return/page-exit events and offline/online transitions.

The existing owner audit also records edits, deletions/restores, folders, collections,
smart folders, sharing/security/settings changes, storage checks, offline saves and log
exports. “Recent activity” is still a short convenience view; the full audit is the archive.

- **Durable on-device history:** IndexedDB database `visuals-logs-v1` stores audit/login
  entries and every webhook delivery attempt. Audit and login histories are scoped by
  repository, migrated from existing localStorage logs, and have **no automatic count
  cap**. A localStorage compatibility mirror and persistent emergency fallback are kept.
  If both stores are unavailable/full, the app warns that new entries are memory-only.
- **Repository backup:** owner devices merge the complete histories into root files
  `audit.json` and `login-logs.json`, using fresh reads/retries on write conflicts. Large
  log files use GitHub's authenticated raw-read fallback. Corrupted repository log JSON
  is not silently overwritten. Read-only **and upload-link receivers never write these
  log files**; their remote logs go to the webhook.
- **Audit log:** Settings → Audit & insight → Audit log supports filters, paged browsing
  and full `.csv`/`.json` exports. Security & Logins also has paged login history.
  **Clear view only hides entries**; archived history and pending deliveries are kept.
  Use **Show full history** to restore the view. Full library ZIP backups include the
  audit, login and webhook-delivery histories. Existing logs that were pruned by an older
  release cannot be reconstructed unless you have a repository/export copy.

### Webhook setup and delivery guarantees

1. Open **Settings → Security & Logins → Receiver Activity Webhook**.
2. Enter a valid **HTTPS** URL without URL credentials or a fragment and select
   **Save webhook**. The app publishes it to your data repository. If publishing fails,
   retry library sync; the setting is not yet available to recipients.
3. Select **Send test event**. Success is shown only after a readable **HTTP 2xx** response;
   failures are shown as unconfirmed, not “dispatched successfully.” You can inspect
   pending/retrying counts, **Retry pending deliveries**, and **Export delivery history**.
4. Regenerate protected links to include the routing snapshot for pre-decryption
   attempts. If you rotate/clear the endpoint, regenerate those links too: an older
   encrypted envelope still has its old routing snapshot until it can read the library.

Each entry is POSTed separately; the dispatcher processes at most ten entries per pass.
Entries and their destinations are stored together in a persistent outbox **before
sending**. An entry only leaves the queue after HTTP 2xx; network/CORS/timeouts, HTTP
errors and 429 responses are retried with exponential backoff (up to five minutes),
respecting `Retry-After` and throttling the entire endpoint. Queues survive reload,
offline periods and changing between links/libraries. An existing queued entry always
keeps its captured destination, even if Settings changes later. Delivery resumes on the
next app visit/reconnection; page background/exit also attempts `fetch` keepalive.

A custom collector receives JSON like:

```json
{
  "schemaVersion": 1,
  "event": "visuals_audit",
  "repo": "owner/visuals-data@main",
  "sessionId": "vs-example-session",
  "entry": {
    "id": "au-example-event",
    "t": 1790812800000,
    "iso": "2026-10-01T00:00:00.000Z",
    "kind": "view.image",
    "status": "success",
    "actorType": "visitor",
    "actor": "Visitor",
    "linkId": "sl-example-link",
    "folderId": "travel",
    "imageId": "sunrise"
  }
}
```

The payload also has readable `content`/`text` summaries and additional entry metadata
when applicable. Your collector should **persist before returning 2xx** and **deduplicate
by `entry.id`**: delivery is **at least once**, not exactly once (for example, a server
may save an event but its acknowledgement can be lost).

Custom endpoints must support browser CORS/OPTIONS for the app origin, allowing `POST`
and the `Content-Type` header. Expose `Retry-After` if you use it. Requests omit credentials
and referrers and do not follow redirects. Opaque `no-cors` responses are never treated
as confirmed delivery. Discord gets supported `content`/`embeds` fields with the complete
structured entry and disabled mentions; oversized entries are attached as full JSON instead
of exceeding embed limits or dropping metadata. Slack gets `text`, but direct Slack incoming
webhooks generally need a **CORS-enabled relay** for browser delivery.

**Boundary:** the webhook URL is intentionally readable by recipients, including outside
password encryption, so use a dedicated, limited-purpose collector/webhook, **not a
privileged API secret**. This is client-side activity reporting, not tamper-proof tracking:
a recipient can block JavaScript/requests, clear browser storage, or close/kill a browser
before its last writes finish. Browsers and GitHub also impose storage/file/rate limits.
Keep server-side webhook retention and regular exports/backups for long-lived histories;
mandatory, authoritative access auditing requires a server-side access/collection layer.

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

- View-only/download links contain only the separate read-only token. Upload links
  intentionally contain the editing token **inside mandatory password encryption**; use
  them only for trusted recipients and with an expiry.
- Unencrypted links contain the read-only credential in the URL fragment; treat them as secrets. Password-protected links encrypt that credential with PBKDF2-SHA256 and AES-256-GCM.
- GitHub tokens grant **repository-level**, not folder-level, access. Folder filtering, expiry, download controls, and per-link revocation are enforced by the app, not by GitHub. Use separate repositories for strict isolation, and revoke the token on GitHub to fully cut off API access.
- Receivers cannot write audit/login files through the app. Their local history and outbox
  remain on their device; your configured webhook is the remote collection path.
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
the storage check, and the batched grid. `tests/activity-webhooks.spec.cjs` covers receiver
events, pre-decryption attempts, payload redaction, persistent/offline retries, CORS and
HTTP/429 acknowledgement semantics, destination isolation, storage fallback, uncapped
archives/exports, conflict merges and provider payloads. No real data repository or
webhook endpoint is contacted or modified by the tests.
