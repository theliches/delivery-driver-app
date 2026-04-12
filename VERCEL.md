# Deploy på Vercel

1. Push repo til GitHub/GitLab/Bitbucket (uden `.env.local` med hemmeligheder).
2. I [Vercel](https://vercel.com): **Add New Project** → import repo.
3. Vercel finder **Vite** og bruger `npm run build` + output **`dist`** (styres også af `vercel.json`).
4. Under **Settings → Environment Variables** tilføj alle `VITE_FIREBASE_*` fra `.env.example` med samme navne som i Firebase-konsollen. Vælg **Production** og **Preview**.
5. **Redeploy** efter du har sat variabler.

Geokodning (Nominatim/OSRM) kører direkte fra browseren i produktion — ingen Vite-proxy. Sørg for at Firestore **regler** er deployet (`firebase deploy --only firestore:rules`).
