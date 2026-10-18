# Firebase Hosting — 3 alag project deploy plan

Har app ka **apna Firebase project** = apna public URL, apna deployment, apna traffic.

## Setup (one-time, tumhe karna hai — browser me 2 min)

1. https://console.firebase.google.com → "Add project"
2. Naam: `aura-live` (ya jaise chaho) → Create
3. Console left menu → **Hosting** → Get started → hosting only setup skip (CLI se karenge)

Tumhe jis email se Firebase account bana **wahi email** ka baad me CLI login hoga.

> NOTE: AURA ka pehle se hi ek Firebase project hai — `aura-live-81185` (auth + Firestore usi me hai). **AURA ko usi me host karo**, naya project banane ki zaroorat nahi — aur ek project me Firestore+Auth ready hai.

## 3 projects ek account me

| Project | Firebase project name | Public URL |
|---|---|---|
| **AURA** | `aura-live-81185` (existing) | `aura-live-81185.web.app` |
| **Lucid** | `lucid-app-preview` (naya) | `lucid-app-preview.web.app` |
| **IdeaVeda** | `ideaveda-app-preview` (naya) | `ideaveda-app-preview.web.app` |

## Deploy commands (jaise hi tum login kar doge, main ye chala dunga)

```bash
# AURA (existing project — sirf hosting add hoga, auth/firestore safe)
cd "C:/Users/asus/Downloads/portfolio-mirror"
npx firebase-tools deploy --only hosting \
  --project aura-live-81185 \
  --public . \
  --token <FIREBASE_TOKEN>

# Lucid
npx firebase-tools deploy --only hosting \
  --project lucid-app-preview \
  --public . \
  --token <FIREBASE_TOKEN>

# IdeaVeda
npx firebase-tools deploy --only hosting \
  --project ideaveda-app-preview \
  --public . \
  --token <FIREBASE_TOKEN>
```

## Token kahan se milega

1. Browser me https://console.firebase.google.com kholo (tumhara Google account)
2. Terminal: `npx firebase-tools login:ci` — browser popup aayega, login karo, token terminal me milega

Ya directly: **Firebase Console → Project Settings → Service accounts → Generate new private key** ( Lowell se deploy hota hai, hosting ke liye nahi — **login:ci hi sahi method hai**).

## Deploy ke liye jo chahiye

- **FIREBASE_TOKEN** (from `login:ci`) — bas itna.
- Iske baad main 3 projects deploy karke live URLs verify karta hoon.
