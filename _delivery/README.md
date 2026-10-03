# Delivery: how buyers get the files

The site stays on GitHub Pages. Delivery is one Cloudflare Worker, `worker.js`, which you
paste into the Cloudflare dashboard. The leading underscore on this folder keeps GitHub
Pages from publishing it.

How a purchase flows:

1. Stripe Payment Link → after payment, Stripe redirects to
   `https://howyoureallywork.com/thank-you.html?session_id={CHECKOUT_SESSION_ID}`.
2. `thank-you.html` sends that session id to the Worker (the `DELIVERY` constant at the
   bottom of the page holds the Worker's address).
3. The Worker asks Stripe whether that Checkout Session is paid. If it is, it creates one
   token for the purchase, stores it in Workers KV, and returns it with two download links.
4. Each download link goes back to the Worker, which checks the token and redirects to a
   signed R2 link that expires after five minutes. The bucket itself is private.
5. The page swaps the address to `/thank-you.html#t=TOKEN`. That link keeps working, so a
   buyer who closes the tab can come back. Stripe's receipt links to Stripe, not here.

To take a purchase's access away (refund, chargeback): in KV, delete `token:<token>` and
`session:<session id>`.

`terms-withdrawal-consent.diff` is the drafted terms wording for the withdrawal-consent
checkbox; it is applied in the next step, not yet.
