# README images

The gallery shows the actual CodexNest UI with an offline, English-language
Launchpad demo. Project names, messages, paths and report content are fixtures;
the screenshots do not use an owner's sessions. Mobile images show the responsive
web interface, without native Android controls.

The activity scene shows the request, result, command output and patch without
the plan cards. The question scene focuses on the clarification and queued
follow-up. These shorter fixtures keep the relevant content fully in view at
the application's default font sizes.

From the repository root, after the normal development dependencies are installed:

```bash
npm exec -w @codexnest/client -- playwright install chromium
npm run docs:images -w @codexnest/client -- images.spec.ts
```

The command starts the client on `127.0.0.1:4173`, mocks HTTP and WebSocket data,
and captures seven PNGs in `docs/assets`, including the open mobile session list.
It uses fixed time, loaded fonts, reduced motion and a fresh browser context for
every screen. It does not start the API server or invoke Codex. Unmatched network
requests fail the capture.

The separate documentation suite lives in `apps/client/e2e/docs`. It reuses the
visual fixture infrastructure without updating visual regression snapshots and
does not run as part of `npm test` or `test:visual`. The filename filter above
captures only the README gallery and covers; omit it to also refresh the separate
font-settings documentation images.

`cover.html` composes the dark desktop and light mobile screenshots of the same
session with the existing CN logo and Onest font. Its neutral colors, rounded
surfaces and shadows follow the [design kit](../design-kit.md). The same command
renders two layouts:

- `docs/assets/cover.png` — 1600 × 900, used by both READMEs.
- `docs/assets/social-preview.png` — 1280 × 640, prepared for the repository's
  Social preview setting on GitHub. Generating it does not change that setting.

To install the social preview, upload `docs/assets/social-preview.png` through
the repository's **Settings → Social preview → Edit → Upload an image**. Keep
the PNG under 1 MB. See [GitHub's social preview instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

Review all images after capture, especially wording, clipped content and loading
states. Keep screenshot captions in both READMEs in sync. The PNGs are intentional
documentation assets and should be committed alongside the README changes when
publishing an update.
