# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## Deploying a change to Replit preview after merging to `main`

This app is developed by Claude Code sessions that push to feature branches and
merge Pull Requests into `main` on GitHub. The **Replit workspace does not
auto-sync with GitHub** — merging a PR only updates GitHub's copy of `main`.
Getting a change to actually show up in the Replit preview requires manual
steps *inside the Replit workspace's Shell*, which a GitHub-side Claude Code
session cannot run directly. Walk the user (or whoever has the Replit Shell
open) through the following, in order, every time:

### 1. Pull the latest `main` into the Replit workspace

```
git checkout main
git pull origin main --no-rebase
```

Watch for these snags:
- **"Committer identity unknown"** — the workspace has never had git identity
  configured. Fix once with:
  ```
  git config --global user.email "you@example.com"
  git config --global user.name "Your Name"
  ```
  then re-run the `git pull`.
- **A `MERGE_MSG` editor tab opens** — this is just the merge commit message,
  already pre-filled. No typing needed — just close the tab (click its X) and
  the merge completes automatically in the Shell.
- **"Please tell me how to reconcile divergent branches"** — use
  `git pull origin main --no-rebase` (not a bare `git pull`) so Replit's own
  auto-commits (e.g. "Published your App") get merged in rather than blocking.
- **After a pull that reports success, always double-check it actually
  landed** — `git log --oneline -3` should show the expected merge commit at
  HEAD, and/or `grep` for a string you know is in the new code. Do not trust a
  clean-looking git panel alone; in one real incident here, an earlier pull
  silently aborted (identity error) and everyone believed a later screenshot
  of GitHub's incoming commit list was proof of a completed local merge, when
  it wasn't. Verify against actual `git log` / `grep` output, not UI vibes.

### 2. Restart the actual running server — do not trust Stop/Run alone

This project's dev server (`npm run dev` → `tsx server/index.ts`) does **not**
file-watch or hot-reload itself. If the old process doesn't fully die before a
new one starts, the new one fails silently underneath, or Replit's Stop/Run
button leaves a zombie process holding the port — and you keep serving stale
code indefinitely with no visible error, while every subsequent `git pull` /
build looks like it "did nothing."

The reliable fix is to force-kill whatever is actually bound to port 5000
(not by process name, which can miss it) and start fresh directly in the
Shell so you can watch it happen:

```
fuser -k 5000/tcp
npm run dev
```

(If `fuser` isn't installed, Replit will offer to fetch it via Nix — accept
that, it's a harmless one-time addition to `replit.nix`.)

Confirm a clean start: the log should show `[express] serving on port 5000`
with **no** `EADDRINUSE` error. If `EADDRINUSE` appears, something is still
holding the port — re-run `fuser -k 5000/tcp` and try again.

### 3. Know which preview URL is actually this app

This workspace has at least one unrelated side-project running in it:
`mockup-sandbox` (its own Vite dev server, on port 23636 → external port
3000). **That is not this app.** The real app is on port 5000 → external
port 80 (the plain `https://<id>.replit.dev` URL, no port suffix, or the
Preview tab). If changes never seem to show up no matter what, check that
whoever is looking is on the port-5000 URL, not the mockup-sandbox one.

Separately, Replit's **Publish/Republish** button controls a distinct,
frozen deployment that does NOT auto-update — a bookmarked `.replit.app`-style
link needs an explicit Republish click after the workspace itself is updated,
if that's the link being used to check the result.

### 4. After confirming a fix in the Replit dev preview, verify against a
fresh extraction/action, not stale on-screen state

This is a client-side single-page app — re-running `npm run dev` doesn't
change what's already rendered in an open browser tab. Always do a real
reload of the page (not just "restart the repl") and re-run whatever action
is being tested (e.g. a fresh Schedule Converter extraction) before judging
whether a fix worked.
