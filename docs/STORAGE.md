# Filesystem storage adapter

This slice adds a typed `SiteStorage` interface. Local tests and the default
server use the filesystem adapter (`SiteStore` / `createFilesystemStorage`).
The public folder-to-URL contract is unchanged:

- `/sites/{slug}/` serves the active release
- `/sites/{slug}/releases/{releaseId}/` serves an immutable permalink

Railway Bucket / S3 and Postgres metadata are **out of scope**.

## Layout

Under the data root:

- `sites/{slug}/current.json` — active-release pointer
- `sites/{slug}/releases/{releaseId}/` — immutable release objects
- `sites/{slug}/releases/.upload-{id}/` — upload staging (never public)
- `sites/{slug}/.current-{id}.json` — pointer staging before rename onto `current.json`

## Atomicity

1. Write objects into `.upload-{id}/`.
2. Rename the staging directory to `releases/{releaseId}/`.
3. Write pointer staging `.current-{id}.json`, then rename onto `current.json`.

A failed or interrupted upload must **not** swap `current.json`. The catch path
removes leftover upload staging and leftover pointer staging for that attempt.

## Orphan cleanup

`initialize()` calls `cleanupOrphans()`, which sweeps only:

- `releases/.upload-*` directories/files
- leftover `.current-*.json` pointer temps

It does **not** delete complete immutable releases or `current.json`.
Cross-site isolation is the `sites/{slug}/` prefix: cleanup of one slug cannot
mutate another site's pointer or objects.
