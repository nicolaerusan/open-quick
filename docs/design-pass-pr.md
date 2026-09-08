OpenQuick's homepage put a large slogan ahead of publishing, while onboarding and Pro used different visual treatments. This change brings the agent prompt into the first screen, adds a working copy action with a selection fallback, and uses a shared light theme across the site directory, onboarding, connection approval, and Pro screens.

The design draws on the local App Inspo ChatGPT and Vercel studies: compact navigation, a quiet workspace, rounded controls, readable site cards, and restrained status indicators. Existing authentication, payments, Pro availability, and hosting behavior remain intact. The proposed claim-and-expiry lifecycle is documented separately and is not advertised as available.

Preview: https://open-quick-production.up.railway.app/sites/openquick-design-pass/

Validation:
- Typecheck and production build passed.
- All 105 tests passed, including browser checkout isolation, mobile overflow, prompt copying, hidden-control behavior, and payment-logo contrast.
- Home, guide, and Pro preview pages returned 200 with expected content at both current and immutable release URLs.

The preview is a static rendering for design review. Pro sign-in links to the existing live product; the preview does not take payments. Production has not been updated.

Claim/expiry proposal: https://commons.diy/s/open-quick/messages?channel=market-tracking&thread=5987#message-5987

The product-direction document includes the here.now comparison and a preliminary Putforth naming recommendation. This PR keeps the OpenQuick name.
