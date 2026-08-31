# OpenQuick

OpenQuick is an open-source, agent-friendly static hosting service inspired by
[Shopify Quick](https://shopify.engineering/quick). Point the TypeScript CLI at a
folder and receive a shareable URL.

**Live MVP:** [open-quick-production.up.railway.app](https://open-quick-production.up.railway.app) ·
**Example site:** [hello](https://open-quick-production.up.railway.app/sites/hello/)

```bash
openquick init my-site
OPENQUICK_HOST=https://your-openquick.example \
OPENQUICK_TOKEN=... \
openquick deploy my-site
```

## First-pass architecture

- One Node.js 22 + TypeScript service built with Hono.
- One TypeScript CLI shipped from the same package.
- Immutable release folders and an atomic `current.json` pointer.
- A mounted Railway volume at `/data` for durable assets.
- Path-based URLs (`/sites/{slug}/`) until wildcard-domain routing is justified.
- One deploy token, strict path validation, and bounded upload size/count.

This is deliberately narrower than Shopify's internal platform. Database, AI,
file uploads, realtime, identity, and data warehouse APIs are roadmap work. The
first milestone proves the product loop: **folder → deploy → URL**.

## Local development

```bash
npm install
OPENQUICK_ADMIN_TOKEN=dev-token npm run dev

# In another terminal
npm run build
OPENQUICK_HOST=http://localhost:3000 \
OPENQUICK_TOKEN=dev-token \
node dist/cli.js deploy examples/hello
```

Run the checks:

```bash
npm run typecheck
npm test
npm run build
```

## Railway

1. Create a service from this repository.
2. Add a volume mounted at `/data`.
3. Set `DATA_DIR=/data` and a long random `OPENQUICK_ADMIN_TOKEN`.
4. Optionally set `BASE_URL` to the service's public HTTPS origin.
5. Generate a Railway domain. The service health check is `/healthz`.

The initial topology is intentionally a single service and volume, matching the
constraint-driven spirit of Quick. Before using OpenQuick for untrusted public
uploads, add per-user authentication, quotas, malware/content controls, and a
stronger isolation model.

## API

`POST /api/v1/sites/{slug}/deploy`

```json
{
  "files": [
    { "path": "index.html", "content": "PGgxPkhlbGxvPC9oMT4=" }
  ]
}
```

Authenticate with `Authorization: Bearer $OPENQUICK_ADMIN_TOKEN`. A successful
response includes the site record, immutable release identifier, and public URL.

## License

MIT
