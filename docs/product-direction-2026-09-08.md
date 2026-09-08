# OpenQuick: publishing lifecycle, capabilities, and naming

Checked September 8, 2026. Recommendations below are proposals, not shipped features.

## Product direction

Make the first useful link immediate, then make ownership explicit. The Space's [publishing-contract research](https://commons.diy/s/open-quick/resources/res_571d5218edfa43eba9371c8e858de755) already compares authentication-first publishing with temporary previews that can be claimed. The [artifact market map](https://commons.diy/s/open-quick/resources/res_1a98ab97ea3743eab3b8d55617527afe) identifies reports, documentation, interactive analysis, and evaluation evidence as useful output. The core job is to give agent-created work a usable address.

### Proposed 24-hour preview lifecycle

1. An agent publishes a bounded static bundle without creating an account. The response returns a public preview URL, fixed release URL, exact `expiresAt`, and a separate private ownership capability. Start the clock only after a successful atomic publish.
2. The agent shares the preview and clearly says when it expires. The intended owner receives the private claim flow. Keep ownership authority out of public site HTML, discovery lists, analytics, and public conversations.
3. Claiming requires an authenticated owner and valid one-use capability. Preserve the public URL and content, remove the preview expiry, and issue separately authorized, scoped credentials for subsequent updates. Claiming must not silently grant the original agent permanent access.
4. Unclaimed previews stop serving at expiry, including immutable release URLs. Return a useful expired state and remove retained bytes through a bounded cleanup process. A worker delay must not keep expired content public. Do not reuse an expired random hostname for unrelated content.
5. Cap anonymous creation rate, active previews, file count, bytes, and bandwidth. Redepublishing must not reset the clock. Keep the existing authenticated publishing path available.

Initial scope should remain static hosting. Exclude paid hosting, secret proxies, and shared data from anonymous previews. Add those after ownership is established. Launch tests should cover claim replay, cross-owner access, expired mutable and immutable URLs, cleanup, failed upload atomicity, and preserved URLs after claiming.

This extends existing task #64 and onboarding work in #72. It is not implemented by this design pass, and the current interface continues to explain the existing credential requirement.

## What can the hosts run?

Both can serve interactive browser applications. Charts, calculators, games, and prebuilt React applications can be static files; static hosting does not mean an unchanging page. Neither is a replacement for a general server runtime.

| Capability | here.now, documented | OpenQuick, live service and source |
| --- | --- | --- |
| First publish | Anonymous, 24-hour claim window | Approved credential required |
| Client-side apps | HTML/JS plus optional SPA fallback | HTML/JS; nested file paths, no documented SPA fallback |
| Shared application data | Site Data collections on claimed sites | Database and realtime capabilities remain proposals |
| Secret-bearing API calls | Proxy routes with server-side secret injection | Guardrailed AI proxy remains proposed |
| Addressing | Site subdomains and custom domains | Public `/sites/{slug}/` prefixes; dedicated private Pro addresses |
| Private viewing | Password, verified email/domain rules, workspaces | Pro beta with owner/approved-viewer access through Commons |
| Files and collaboration | File viewers, directories, Drives, workspaces | Public bundle requires `index.html`; site/release hosting |
| History and analytics | Version tools and analytics; some require paid plans | Immutable public releases and rollback; no comparable analytics console found |

here.now explicitly excludes server-side compute, long-running processes, general databases, and backend code execution. Its richer apps combine static files with managed data and proxy capabilities. Sources: [here.now documentation](https://here.now/docs), [capability summary](https://here.now/llms.txt).

OpenQuick's [live agent guide](https://open-quick-production.up.railway.app/agent.md) specifies a 25 MB public release limit. Its [Pro entry](https://open-quick-production.up.railway.app/pro) currently offers 30-day private static hosting, up to 50 files and 1 MB, paid through MPP/Tempo. The entry was read; no purchase was made. The live [revision attestation](https://open-quick-production.up.railway.app/.well-known/openquick-release.json) matches source commit `c093b7668cab91f3378378b358ee5e5701dfc2cf` used for this design pass.

Priority after the first-link workflow: isolated site subdomains and SPA routing, then clearer owner/site management and file viewers. Shared data and secret proxies are valuable later additions, with their own operational and access-control requirements. Avoid expanding into arbitrary backend hosting merely to match a feature list.

## Naming recommendation

**Explore Putforth**, with the descriptor **“A home for work made with agents.”** It describes the action and leaves room for sites, reports, tools, and files. OpenQuick describes speed and its Shopify inspiration; the broader market opportunity is durable, portable work that survives a conversation.

Alternative directions are **Put Forth** as a two-word presentation, or keeping **OpenQuick** while using clearer positioning. A rename is optional; the publishing experience matters more than changing the wordmark.

Preliminary screen, not registration or trademark clearance:

- `putforth.com`: registered; registry creation November 1, 2005, expiry November 1, 2027.
- `putforth.dev` and `putforth.app`: RDAP returned 404. Confirm registration and pricing at a registrar before choosing either.
- Exact-name web searches found no obvious competing publishing product called Putforth.
- Ruled out **Pageport** (existing video/marketing product), **OffChat** (multiple messaging/AI apps), **SharePlane** (an existing AI-assisted publishing system), and **PageHaven** (multiple existing products).

Sources: [Pageport](https://pageport.com/), [OffChat](https://apps.apple.com/us/app/offchat-ai/id6759080666), [SharePlane](https://shareplane.malott.ai/about/), [PageHaven](https://pagehaven.dev/), [Putforth .com registry](https://rdap.verisign.com/com/v1/domain/putforth.com).

## Design pass

The implementation keeps the OpenQuick name pending a naming decision. It draws on the local App Inspo ChatGPT and Vercel studies: generous white space, a compact rail, a capped prompt surface, 44 px controls, thin borders, readable typography, and restrained status treatments. No captured artwork, account content, or reference bundles are published.

Changed surfaces: homepage, agent guide, connection approval, private hosting entry/checkout, and legacy pilot checkout. The homepage exposes the real agent publishing prompt immediately, includes a copy fallback, and keeps the existing site directory and conditional Pro entry. Credential, payment, ownership, and hosting behavior are unchanged. Claim/expiry language is kept in this proposal until the backend supports it.
