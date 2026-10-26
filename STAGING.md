# Test project (staging) — try changes before real shops see them

One-time setup (about 15 minutes):

1. Firebase Console → **Add project** → name it `taptayo-staging`
   (if Firebase gives a different Project ID, put that ID in `.firebaserc` under "staging").
2. Upgrade it to **Blaze** (same billing account) — needed for Cloud Functions. Add a $5 budget alert.
3. In the new project: Build → **Firestore** (asia-southeast1), **Storage**, **Authentication** (Anonymous, Google, Email).
4. Project settings → Your apps → **Web app** → copy the config values.
5. In `C:\projects\qr-saas`, copy `.env` as **`.env.staging`** and replace the `VITE_FIREBASE_…` values with the staging ones.
6. (Optional) copy `functions/.env` too — the same keys work, or leave Turnstile empty in staging.

Every time you want to test:

```
npm run deploy:staging
```

Then open `https://taptayo-staging.web.app` (shown at the end of the deploy). Make an admin account there the same way as live.
Only when it looks right: `npm run deploy:smart` for the real site.

Notes
- Staging has its own data — real shops and customers are never touched.
- `deploy:staging` also only sends the functions that changed (its own record in `.deploy/functions-staging.json`).
