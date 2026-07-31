# TV Time

A dark, mobile-first tracker for shows and films. Track watch status, rate titles,
log episode progress, and build custom lists. Built with Vite + React.

Data syncs across all your devices via **Firebase (Google Sign-in + Firestore)**.
Sign in on your phone and your laptop and you'll see the same library on both,
updating live. An offline cache keeps everything readable without a connection and
writes back once you're online again.

## 1. Create a Firebase project

In the [Firebase console](https://console.firebase.google.com):

1. Create a project, then add a **Web app** and copy its config object.
2. **Authentication -> Sign-in method ->** enable **Google**.
3. **Firestore Database ->** create a database (production mode).
4. Paste your config into `src/firebase.js` (replace the `YOUR_...` placeholders).

Set these Firestore security rules so each person can only read and write their own
library:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /trackers/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

> Until you paste a real config in, the app shows a one-time setup screen instead of
> a blank page.

## 2. Run locally

```bash
npm install
npm run dev        # http://localhost:5173
```

Add `localhost` under **Authentication -> Settings -> Authorized domains** if the
Google popup is blocked during local development.

## 3. Deploy to Firebase Hosting

Needs the Firebase CLI (`npm install -g firebase-tools`).

```bash
npm run build
firebase login
firebase use --add            # pick your project (or edit .firebaserc)
firebase deploy --only hosting
```

Live at `https://YOUR_PROJECT_ID.web.app`. That domain is authorized for Google
Sign-in automatically. `firebase.json` already serves `dist/` as a single-page app.

## How sync works

- Each signed-in user has one Firestore document: `trackers/{uid}`, holding their
  tracking map, lists, and profile.
- The app subscribes to that document with `onSnapshot`, so an edit on one device
  appears on the others without a refresh.
- Local edits write straight back to the same document; echoes of remote updates are
  ignored to prevent write loops.

## Project structure

```
index.html          # app shell (mobile viewport, full-height root)
firebase.json       # Hosting config -> serves dist/ as an SPA
.firebaserc         # your Firebase project alias
src/
  main.jsx          # React entry
  App.jsx           # tracker UI, catalog, state, sign-in gate, sync logic
  firebase.js       # Firebase init, auth helpers, Firestore (with offline cache)
```

## Notes

- Titles come from a built-in catalog in `App.jsx` (20 shows, 20 films). Add or edit
  entries in the `rawShows` / `rawMovies` arrays.
- The following / followers / comments counts on the profile are placeholders -- there's
  no social backend.
