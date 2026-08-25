# Async route search — your two setup tasks (~5 minutes total)

The async lane ("we'll email you when your route is found") is deployed
and code-complete. It needs two things only you can click, because they
create accounts/stores under your ownership. Until you do them the site
quietly falls back to the old in-tab search, so nothing breaks meanwhile.

## 1. Vercel Blob (job + result storage) — ~2 min

1. Open https://vercel.com/dashboard → the **pace-casso** project.
2. **Storage** tab → **Create Database / Store** → choose **Blob**.
3. Accept the defaults (any store name). When it asks which project to
   connect: **pace-casso**, all environments.
4. That's it — Vercel automatically adds `BLOB_READ_WRITE_TOKEN` to the
   project. Trigger a redeploy (Deployments → ⋯ on the latest → Redeploy),
   or just wait for the next git push.

**Effect:** "Find my route" now answers instantly with "We'll email you /
you can close this page", and searches survive locked phones and closed
tabs. Results wait at the site whenever you come back.

## 2. Resend (the actual email) — ~3 min

1. Sign up at https://resend.com (free tier: 3,000 emails/month).
2. Dashboard → **API Keys** → create one.
3. Vercel → pace-casso → **Settings → Environment Variables** → add
   `RESEND_API_KEY` = the key (all environments) → redeploy.

**Effect:** finished searches email a link that opens the route.

Caveat until you verify a domain: Resend's shared onboarding sender only
delivers to **your own Resend account email** — perfect for testing solo.
When you want real users to get email: Resend → **Domains** → add
`pacecasso.com`, add the DNS records it shows, then also set the Vercel
env var `RESEND_FROM` = `PaceCasso <routes@pacecasso.com>`.

## What happens without each

| Configured | Behavior |
|---|---|
| Neither | Old in-tab search (exactly as today) |
| Blob only | Async search works; no email — "come back to this page" wording, result waits on the site |
| Blob + Resend | The full promise: submit, close the page, get the email |
