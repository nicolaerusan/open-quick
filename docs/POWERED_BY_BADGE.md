# Powered-by OpenQuick badge

Hosted HTML under `/sites/{slug}/` and immutable permalinks under
`/sites/{slug}/releases/{releaseId}/` receive a small first-party badge at
**serve time**. Stored files are not rewritten. Default is **on** for every
HTML response, including sites published before this feature.

The chip sits bottom-left. It expands into a compact popover with links to the
OpenQuick homepage (`{origin}/`) and `{origin}/agent.md`. Dismiss remembers the
choice per origin in `localStorage`.

## Opt out

Add this meta tag in the page `<head>` (name is case-insensitive):

```html
<meta name="openquick-badge" content="off">
```

For tests and debugging, send `X-OpenQuick-Badge: off`. The meta tag is the
public, documented opt-out. JSON, JavaScript, and other non-HTML assets are
never injected. 404 plain-text responses are never injected.

## localStorage

| Key | Value |
| --- | --- |
| `openquick-badge-dismissed` | `"1"` after the visitor dismisses the chip |

The key is origin-scoped by the browser (the hosted site origin). Clearing
site data restores the badge.

## Accessibility

- The chip is a real `<button>` with keyboard focus and `aria-expanded`.
- Escape closes the popover.
- `prefers-reduced-motion: reduce` disables the first-paint animation.
- Contrast is lime (`#c9ff38`) on black, matching the OpenQuick landing page.
- On small screens the chip collapses to the mark only so it does not cover
  primary content.
- The overlay uses `pointer-events` only on the chip and popover.

The mark is an inline SVG (black Q ring + lime bolt). The snippet does not
fetch remote images and does not include tokens or other secrets.
