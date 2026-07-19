# Docs Site

`bd-console` ships a static documentation site from the `site/` directory.

## Local preview

```bash
npm run docs:serve
```

This starts a tiny built-in Node static server at `http://127.0.0.1:4179`.

## GitHub Pages

The repo includes [`.github/workflows/docs-site.yml`](../.github/workflows/docs-site.yml),
which deploys the `site/` directory to GitHub Pages on pushes to `main`.

Expected repo settings:

- Pages source: GitHub Actions
- default branch: `main`

## Cloudflare Pages

This same `site/` directory can be deployed to Cloudflare Pages with:

- Framework preset: none
- Build command: none
- Build output directory: `site`

## Content source of truth

Keep the runtime docs aligned across:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `site/index.html`
- `docs/upgrading.md`

If defaults or setup guidance change, update all of them in the same change.
