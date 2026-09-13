# README images

The gallery shows the actual CodexNest UI with an offline, English-language
Launchpad demo. Project names, messages, paths and report content are fixtures;
the screenshots do not use an owner's sessions. Mobile images show the responsive
web interface, without native Android controls.

From the repository root, after the normal development dependencies are installed:

```bash
npm exec -w @codexnest/client -- playwright install chromium
npm run docs:images -w @codexnest/client
```

The command starts the client on `127.0.0.1:4173`, mocks HTTP and WebSocket data,
and captures seven PNGs in `docs/assets`, including the open mobile session list.
It uses fixed time, loaded fonts, reduced motion and a fresh browser context for
every screen. It does not start the API server or invoke Codex. Unmatched network
requests fail the capture.

The separate documentation suite lives in `apps/client/e2e/docs`. It reuses the
visual fixture infrastructure without updating visual regression snapshots and
does not run as part of `npm test` or `test:visual`.

`cover.html` composes the desktop and mobile screenshots with the existing CN
logo and Onest font. The same command renders two layouts:

- `docs/assets/cover.png` — 1600 × 900, used by both READMEs.
- `docs/assets/social-preview.png` — 1280 × 640, prepared for the repository's
  Social preview setting on GitHub. Generating it does not change that setting.

Review all images after capture, especially wording, clipped content and loading
states. Keep screenshot captions in both READMEs in sync. The PNGs are intentional
documentation assets and should be committed alongside the README changes when
publishing an update.
