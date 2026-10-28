[![LIVE](https://img.shields.io/badge/▶_LIVE-verified_working-00d4aa?style=for-the-badge&logo=googlechrome&logoColor=white)](https://sourabh7300.github.io)
[![PROFILE](https://img.shields.io/badge/GITHUB-sourabh7300-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/sourabh7300)

# Sourabh Singh — live app portfolio

**B.Tech CSE (AI, DevOps & Cloud Automation) · JECRC University · Jaipur**

A dozen hand-written, single-file products. No frameworks, no build step — open a file and it runs.
Every project below has a **live deployment**; the links are the demo.

| | Product | Live | What it is |
|---|---|---|---|
| 🧬 | **AURA** | **[aura-live-81185.web.app](https://aura-live-81185.web.app)** | Holographic AI assistant — 3D particle core, voice in/out, Hindi · Hinglish · English, vision, document RAG, long-term memory, thread-aware chat that keeps its topic across follow-ups, 24/7 autopilot squad |
| 🎨 | **Lucid** | **[lucid-app-preview.web.app](https://lucid-app-preview.web.app)** | Desktop-class photo studio in one file — WebGL curves, HSL mixer, clarity, bloom, bokeh, halation, grain, layers, masks, batch export, **48-template library** with live previews on your own photo, and an **AI studio** (key server-side, zero setup for visitors) |
| 💡 | **IdeaVeda** | **[ideaveda-live-app.web.app](https://ideaveda-live-app.web.app)** | Startup decision engine — 40 India business ideas, city-fit scores, unit-economics calculators, 14 funding schemes, stress-test, plan + pitch generator, Hinglish AI Guru |
| 🌌 | **Quantum Circuit Simulator** | [run](https://sourabh7300.github.io/quantum.html) | Build a circuit, watch amplitudes collapse — state-vector simulator in one page |
| 🍔 | **Foodora** | [run](https://sourabh7300.github.io/foodora.html) | Food-delivery platform — 12 restaurants, 48 dishes with recipes in 3 languages, live maps, cart and checkout |
| 🚗 | **Mercedes-Benz** | [run](https://sourabh7300.github.io/mercedes.html) | Cinematic luxury brand showcase, pure CSS + canvas |
| 🌱 | **Groundwork** | [run](https://sourabh7300.github.io/groundwork.html) | Learn AI from zero — eight interactive lessons |
| 🔬 | **Autonomous SRE** | [run](https://sourabh7300.github.io/sre.html) | Multi-agent incident responder: detect → triage → remediate → verify |
| ☁️ | **CloudPilot** | [run](https://sourabh7300.github.io/cloudpilot.html) | Infrastructure that plans and ships itself |
| 🖼️ | **Project Web** | [open](https://sourabh7300.github.io/project-web.html) | Every app in one gallery, with filters and live badges |
| 📄 | **Résumé** | [read](https://sourabh7300.github.io/resume.html) | One-page, printable, same design language as the site |
| 🪪 | **Provenance** | [verify](https://sourabh7300.github.io/provenance.html) | Checks a running AURA build against its creator's records |

---

## 📁 Repo map

| File | Role |
|---|---|
| `index.html` / `portfolio.html` / `project-web.html` | The homepage — boot sequence, live embeds of every project, guided tour, Gia (AI guide) |
| `aura.html` · `aura/` | AURA, the full assistant (mirrored from its own repo; also deployed standalone on Firebase) |
| `lucid.html` | Lucid photo studio (also deployed standalone on Firebase) |
| `ideaveda.html` · `ideaveda-app.html` | IdeaVeda landing + app |
| `quantum.html` · `foodora.html` · `mercedes.html` · `groundwork.html` · `sre.html` · `cloudpilot.html` | Project files the homepage embeds and GitHub Pages serves |
| `resume.html` · `provenance.html` | Printable résumé, authorship verification |
| `aura-backend/` | AURA's secure Node proxy — AI keys live only in the host's private env |
| `.github/workflows/` | The AURA mirror + keepalive automation |

## 🛠️ Stack

Plain **HTML · CSS · JavaScript**. WebGL and Canvas 2D for the pixel engines, Leaflet / OpenStreetMap for maps,
Web Speech for voice, Firebase Hosting for the three product domains, Render for the AI backend, GitHub Actions for automation.

```
zero frameworks  ·  one file per product  ·  keys stay server-side  ·  works offline
```

## ✅ Status

Every link above was opened and verified returning **HTTP 200** on **28 October 2026**.
The three Firebase products are separate deployments with their own domains; the rest are served by GitHub Pages from this repo.

**Portfolio:** https://sourabh7300.github.io · **Profile:** https://github.com/sourabh7300
