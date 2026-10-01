# My Visuals

A static, installable visual library backed by a private GitHub data repository.
The app is in `index.html`; no runtime build or backend is required.

## Connect and share

1. Create a private data repository (for example, `visuals-data`) and initialize it with a README.
2. In the app's **Settings**, save your GitHub username, repository, and a token with **Contents → Read and write** for editing on this device.
3. In the same Settings panel, optionally save a **separate fine-grained token** with **Contents → Read-only**, limited to the same data repository. Confirm its read-only permission and select **Save and connect**. This token is reused for all folders; tokens are no longer entered in individual folder forms.
4. Open a folder and choose **Share folder**. Use the HTTPS address where this app is deployed, not a localhost address. Password protection is enabled by default; send the password separately.

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

Tests use mocked GitHub responses and fake credentials. They cover plaintext and
encrypted links, legacy formats, permissions, expiry/revocation, failed and timed-out
requests, cancellation, repository-wide token settings, and device-lock encryption.
No real data repository is contacted or modified by the tests.
