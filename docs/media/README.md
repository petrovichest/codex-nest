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
captures only the README gallery, architecture infographics and covers; omit it
to also refresh the separate font-settings documentation images.

To regenerate only the architecture infographics and covers, leaving the actual
UI screenshots unchanged:

```bash
npm run docs:images -w @codexnest/client -- images.spec.ts -g 'render the architecture'
```

`architecture-illustration.png` is the selected artwork from the built-in
`imagegen` tool; its [final prompt](./illustration-prompt.md) is preserved alongside
it. The illustration shows a compact headless Linux host and four examples of
thin clients. The infinity symbol means any number of the owner's devices, not
four clients or four accounts. Client screens contain abstract conversation
marks, not application screenshots. Codex, the CodexNest backend, ChatGPT sign-in
and the working development environment belong on the host.

`how-it-works.html` and `architecture-cover.html` compose this artwork with the
existing CN logo and the real Onest font. `cover.html` keeps the original desktop
and mobile screenshot composition at the top of both READMEs. Labels, colors and
layout are rendered deterministically; generation is not invoked by the capture
command. The architecture artwork follows the
[design kit](../design-kit.md): white canvas, `#f8f9f6` surfaces, graphite text and
neutral gray connectors, without decorative green accents. Translations are in
`apps/client/e2e/docs/images.spec.ts`. The command renders five layouts:

- `docs/assets/how-it-works.png` — 1200 × 880, English architecture infographic.
- `docs/assets/how-it-works-ru.png` — 1200 × 880, Russian architecture infographic.
- [docs/assets/cover.png](../assets/cover.png) — 1600 × 900, the original screenshot
  cover used by both READMEs.
- [docs/assets/architecture-cover.png](../assets/architecture-cover.png) — 1600 × 900,
  the alternative architecture cover, kept as a separate asset.
- `docs/assets/social-preview.png` — 1280 × 640, prepared for the repository's
  Social preview setting on GitHub. Generating it does not change that setting.

To install the social preview, upload `docs/assets/social-preview.png` through
the repository's **Settings → Social preview → Edit → Upload an image**. Keep
the PNG under 1 MB. See [GitHub's social preview instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

Review all images after capture, especially wording, clipped content and loading
states. Check the architecture labels at full size and at README display width;
both languages must describe the same headless host, account and shared state.
Local client settings, credentials and caches are not the development environment,
so avoid claiming that clients store literally nothing. Keep screenshot captions
in both READMEs in sync. The PNGs are intentional
documentation assets and should be committed alongside the README changes when
publishing an update.
