# AURA Secure Backend

The AI keys live **only** on this server, as private environment variables set in
the hosting dashboard. Browsers, the portfolio code and git history never see them.
Visitors of the site get working AI **without ever entering a key**.

## Deploy (~5 minutes)

1. This folder ships with the repository (already pushed).
2. On the hosting dashboard → **New → Blueprint**, pick the repo —
   it reads `render.yaml` and pre-fills everything.
3. When prompted, paste the private key values. The dashboard stores them encrypted.
4. Deploy and copy the service URL.

## Verify (30 seconds)

```bash
curl https://YOUR-SERVICE-URL/health
# → {"ok":true,...}
```

The health endpoint reports how many key slots are armed — never their values.
