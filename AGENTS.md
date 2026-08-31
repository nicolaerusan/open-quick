# OpenQuick agent guide

OpenQuick recreates the smallest useful part of Shopify Quick: deploy a folder of
static assets and receive a shareable URL. Keep the product deliberately small.

## Commands

- `npm install`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `OPENQUICK_ADMIN_TOKEN=dev-token npm run dev`

## Boundaries

- TypeScript and Node.js 22 are the default stack.
- Never log deploy tokens or uploaded file contents.
- Validate slugs, paths, counts, and byte limits before writing assets.
- Keep deployments atomic: a failed upload must not change the current release.
- The first Railway topology is one service and one mounted volume. Do not add a
  queue, database, object store, or second service without an accepted task that
  explains why.
- Add tests for every security boundary and user-visible deployment behavior.
