# Parked: paid delivery — not wired up yet

Nothing in this folder is used by the site. The leading underscore keeps GitHub Pages
from publishing it. It is kept for when the book is finished.

- `functions/api/download.js` — Cloudflare Pages Function: checks a Stripe Checkout
  Session is paid, keeps one token per purchase in KV, redirects to short-lived signed
  links into a private R2 bucket. Tested only against mocks.
- `wrangler.toml` — KV binding and R2 settings, with placeholder ids.
- `thank-you.wired.html` — a thank-you page that calls the Function and shows the
  downloads plus a personal link back.
- `terms-withdrawal-consent.diff` — drafted terms wording for the express-consent
  checkbox on Stripe checkout (EU/UK 14-day withdrawal right).

To use it later: host on Cloudflare Pages (the site is on GitHub Pages today), move
`functions/` and `wrangler.toml` to the repo root, create the KV namespace and R2
bucket, set the secrets, and point the Payment Link's redirect at
`/thank-you.html?session_id={CHECKOUT_SESSION_ID}`. None of that has been done.
