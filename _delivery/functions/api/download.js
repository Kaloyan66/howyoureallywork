// Delivery for the book: a Cloudflare Pages Function served at /api/download.
//
//   GET /api/download?session_id=cs_...
//       Stripe sends buyers to thank-you.html with this. It asks Stripe whether the
//       Checkout Session is paid and, if it is, returns the buyer's personal token.
//       One token per purchase, created the first time and kept in KV.
//   GET /api/download?t=TOKEN
//       The same answer for a saved link, from KV alone.
//   GET /api/download?t=TOKEN&f=pdf   (or f=epub)
//       Redirects to a signed R2 link that expires after LINK_SECONDS. The bucket
//       itself is private, so the files never have a public URL.
//
// Settings (wrangler.toml for the bindings and plain values, secrets in the dashboard):
//   PURCHASES             KV namespace: token:<token> -> purchase, session:<id> -> token
//   STRIPE_SECRET_KEY     secret, a restricted key that can read Checkout Sessions
//   STRIPE_PAYMENT_LINK   optional plink_... id; when set, only that link's sessions count
//   R2_ACCOUNT_ID, R2_BUCKET
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   secrets, an R2 API token with read access
//
// To take a purchase's access away (a refund, a chargeback), delete its two KV keys.

const FILES = {
  pdf: { key: "how-your-body-really-works.pdf", name: "How Your Body Really Works.pdf" },
  epub: { key: "how-your-body-really-works.epub", name: "How Your Body Really Works.epub" },
};
const LINK_SECONDS = 300;

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const session = params.get("session_id");
  const token = params.get("t");
  const format = params.get("f");
  try {
    if (session) return await fromSession(session, env);
    if (token && format) return await download(token, format, env);
    if (token) return await fromToken(token, env);
    return reply(400, { status: "invalid" });
  } catch (err) {
    console.error(err);
    return reply(500, { status: "error" });
  }
}

async function fromSession(id, env) {
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return reply(400, { status: "invalid" });

  const known = await env.PURCHASES.get(`session:${id}`);
  if (known) return ready(known);

  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (res.status === 404) return reply(404, { status: "invalid" });
  if (!res.ok) {
    console.error("Stripe", res.status, await res.text());
    return reply(502, { status: "error" });
  }
  const checkout = await res.json();
  if (env.STRIPE_PAYMENT_LINK && checkout.payment_link !== env.STRIPE_PAYMENT_LINK) {
    return reply(404, { status: "invalid" });
  }
  // A completed session can still be unpaid while a bank payment clears.
  if (checkout.status === "complete" && checkout.payment_status === "unpaid") {
    return reply(409, { status: "processing" });
  }
  if (checkout.payment_status !== "paid") return reply(402, { status: "unpaid" });

  const token = newToken();
  await env.PURCHASES.put(`token:${token}`, JSON.stringify({ session: id, created: new Date().toISOString() }));
  await env.PURCHASES.put(`session:${id}`, token);
  return ready(token);
}

async function fromToken(token, env) {
  if (!(await known(token, env))) return reply(404, { status: "invalid" });
  return ready(token);
}

async function download(token, format, env) {
  const file = FILES[format];
  if (!file || !(await known(token, env))) return reply(404, { status: "invalid" });
  const location = await presign({
    host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    path: `/${env.R2_BUCKET}/${file.key}`,
    region: "auto",
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    seconds: LINK_SECONDS,
    params: { "response-content-disposition": `attachment; filename="${file.name}"` },
  });
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

async function known(token, env) {
  return /^[A-Za-z0-9_-]{43}$/.test(token) && (await env.PURCHASES.get(`token:${token}`)) !== null;
}

function ready(token) {
  const files = Object.keys(FILES).map((f) => ({ format: f, href: `/api/download?t=${token}&f=${f}` }));
  return reply(200, { status: "ready", token, files });
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------------------------------------
// AWS Signature Version 4 query-string signing, which is what R2's S3 API uses for
// presigned URLs. Written against WebCrypto so the Function has no dependencies.

const encoder = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const uriEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmac(key, data) {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

export async function presign({ host, path, region, accessKeyId, secretAccessKey, seconds, params = {}, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = {
    ...params,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(seconds),
    "X-Amz-SignedHeaders": "host",
  };
  const search = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
  const uri = path.split("/").map(uriEncode).join("/");
  const canonical = ["GET", uri, search, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))].join("\n");
  let key = await hmac("AWS4" + secretAccessKey, day);
  for (const part of [region, "s3", "aws4_request"]) key = await hmac(key, part);
  return `https://${host}${uri}?${search}&X-Amz-Signature=${hex(await hmac(key, toSign))}`;
}
