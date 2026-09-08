export const commonsSpaceUrl = "https://commons.diy/s/open-quick";

// Keep the badge self-contained so it works without a remote image request.
export const commonsBadgeHtml = `<a class="commons-badge" href="${commonsSpaceUrl}">Built on <strong>Commons</strong><span aria-hidden="true">↗</span></a>`;

export const projectLinksStyles = `
.project-links{display:flex;align-items:center;flex-wrap:wrap;gap:20px;font:700 11px/1.2 ui-monospace,monospace}
.project-links a{color:var(--ink,#f5f2e9);text-decoration:none}
.project-links a:hover{color:var(--lime,#c9ff38)}
.project-links a:focus-visible{outline:2px solid var(--lime,#c9ff38);outline-offset:5px}
.project-links .commons-badge{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:9px 12px;border:1px solid var(--line,#343431);border-radius:6px;background:#191918;color:var(--muted,#a8a59d)}
.commons-badge strong{color:var(--ink,#f5f2e9);font-weight:800}
.project-links .commons-badge:hover{border-color:var(--lime,#c9ff38);color:var(--ink,#f5f2e9)}
.commons-badge span{color:var(--lime,#c9ff38);margin-left:4px}
`;

export function projectLinks(): string {
  return `<nav class="project-links" aria-label="Project links"><a href="https://github.com/nicolaerusan/open-quick">GitHub <span aria-hidden="true">↗</span></a>${commonsBadgeHtml}</nav>`;
}
