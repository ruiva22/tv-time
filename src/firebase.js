// Firebase setup for cross-device sync.
//
// FILL THIS IN, then the app will use Firestore behind a Google login.
// Until you replace the placeholders below, the app shows a setup screen
// instead of crashing.
//
//   1) Firebase console → create a Web app → copy its config here.
//   2) Authentication → Sign-in method → enable Google.
//   3) Firestore Database → create (production mode; rules in README.md).

import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// True once real values have been pasted in.
export const configured = !firebaseConfig.apiKey.startsWith("YOUR_");

let db = null;
let auth = null;
const provider = new GoogleAuthProvider();

if (configured) {
  const app = initializeApp(firebaseConfig);
  // Offline cache keeps the library readable without a connection and
  // syncs writes when it returns; multi-tab manager avoids conflicts.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  auth = getAuth(app);
}

export { db };
export const signIn = () => signInWithPopup(auth, provider);
export const logOut = () => signOut(auth);
export const watchAuth = (cb) => onAuthStateChanged(auth, cb);
