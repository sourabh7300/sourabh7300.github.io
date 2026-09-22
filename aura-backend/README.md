# AURA Secure Backend (Groq key proxy)

The Groq API key lives **only** on this server (as the `GROQ_API_KEY` environment
variable). Browsers, the portfolio code and git history never see it. Visitors of
sourabh7300.github.io get working AI **without ever entering a key**.

## Deploy on Render (~5 minutes)

1. Push this folder to your GitHub repo (already done by Codebuff).
2. On [render.com](https://render.com) → **New → Blueprint**, pick the repo —
   it reads `render.yaml` and pre-fills everything.
3. When it asks for `GROQ_API_KEY`, paste the key. Render stores it encrypted.
4. Deploy. Your URL will be `https://aura-secure-backend.onrender.com`
   (or similar — copy the exact one from the dashboard).

## Verify (30 seconds)

```bash
curl https://YOUR-URL.onrender.com/health
# → {"ok":true,...}

curl -X POST https://YOUR-URL.onrender.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"say BACKEND ONLINE"}],"max_tokens":10}'
```

## What AURA does automatically

- The portfolio ships with this URL **baked in** — visitors need zero setup.
- If the backend is asleep (Render free tier sleeps after 15 min idle),
  AURA auto-wakes it and falls back to local keys in the meantime.
- Tier order: **your backend → local key bank → OpenRouter**.

## Keep it private

- The key is in Render's encrypted env store, not in code.
- `.env` is gitignored — it exists only on your laptop for local testing.
- Optional: set `SECRET` + `REQUIRE_SECRET=1` in Render, then tell AURA
  `set backend secret <same-token>` so only your site can call the proxy.

## Free-tier notes

- Sleeps after ~15 min idle; first request wakes it (~50 s). AURA's
  keep-alive pings (`/health` every 10 min while the tab is open) prevent
  this during normal use.
- 750 free instance-hours/month ≈ always-on for one service.
