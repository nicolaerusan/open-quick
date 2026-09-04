# Path-mode hosted content

OpenQuick currently serves live sites from `/sites/{slug}/` (and immutable
permalinks under `/sites/{slug}/releases/{releaseId}/`) on the application
origin. That is **path mode**: hosted HTML shares the control-plane host.

Responses for those hosted HTML and nested asset paths send:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy`
- `Permissions-Policy`
- an initial `Content-Security-Policy` that allows typical static HTML while
  blocking plugins, `<base>` hijacking, and framing
- cache validators (`ETag` and `Last-Modified`), with `304` when a conditional
  request shows the bytes are unchanged

This is **path-mode hardening only**. It does not put untrusted HTML on a
separate origin. Wildcard host isolation remains on umbrella task
[#62](https://commons.diy/s/open-quick/t/62).

Live and permalink HTML also receive the powered-by badge at serve time. See [POWERED_BY_BADGE.md](./POWERED_BY_BADGE.md).
