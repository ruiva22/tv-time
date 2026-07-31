# Deployment workflow (GitHub -> Dokploy)

The flow, top to bottom:

```
you push  ->  GitHub  ->  GitHub Actions builds it  ->  (build OK)  ->  Dokploy pulls & deploys
```

GitHub is the source of truth. Every push is built by GitHub Actions, so a broken
build never reaches your server. Only a green build on `main` triggers the deploy.

---

## One-time: Firebase config

Fill your Firebase web config into `src/firebase.js` and commit it. **The web config is
not a secret** — it's meant to ship in the browser bundle, and access is controlled by
your Firestore security rules (see `README.md`), not by hiding these values. So it's
safe to commit.

Then add your production domain (e.g. `tracker.yourdomain.com`) under
**Firebase console -> Authentication -> Settings -> Authorized domains**, or Google
Sign-in will be blocked on the live site.

---

## Step 1 — Put the code on GitHub

From the project folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main

# create an EMPTY repo on github.com first (no README), then:
git remote add origin https://github.com/ruiva22/tv-time.git
git push -u origin main
```

(If you've already run `git init` from the provided archive, skip that first line.)

---

## Step 2 — Create the app in Dokploy

On your Dokploy dashboard:

1. **Create Application** in a project.
2. **Source: GitHub** — connect your GitHub account (Dokploy installs a GitHub App),
   pick this repo, branch `main`.
3. **Build type: Dockerfile** (the included `Dockerfile` builds the site and serves it
   with nginx on port **80**).
4. **Domain:** add your domain and enable **HTTPS / Let's Encrypt**.
5. Point your domain's DNS `A` record at the server's IP.
6. Deploy once manually to confirm it builds and comes up.

> Turn **off** Dokploy's "auto deploy on push" for this app. We let GitHub Actions be
> the gate instead (Step 3), so deploys only happen after a successful build.

---

## Step 3 — Wire the deploy trigger

1. In the Dokploy application, find its **Deploy Webhook** URL (a POST endpoint that
   makes Dokploy pull + rebuild).
2. In GitHub: **repo -> Settings -> Secrets and variables -> Actions -> New repository
   secret**:
   - Name: `DOKPLOY_DEPLOY_WEBHOOK`
   - Value: the webhook URL from Dokploy
3. Done. `.github/workflows/deploy.yml` calls that webhook after a successful build on
   `main`.

---

## From now on

```bash
git add .
git commit -m "your change"
git push
```

Push -> GitHub builds -> if green, Dokploy redeploys. Watch progress in the repo's
**Actions** tab and in Dokploy's deploy logs. Roll back from Dokploy if a deploy
misbehaves.

---

## Server sizing (Dokploy on a VPS)

A small VPS (2 CPU / 4 GB, e.g. Hetzner or DigitalOcean) comfortably runs Dokploy plus
this app. Confirm current minimums on Dokploy's site. Configure and **test** Dokploy's
backups before you rely on them.

---

## If you later migrate to Next.js

Only the container changes — the GitHub -> Dokploy pipeline stays identical. Swap the
`Dockerfile` for a Node runtime using Next's standalone output, and set
`output: 'standalone'` in `next.config.js`:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

Then set the app's port to **3000** in Dokploy, and drop `nginx.conf` (Next serves
itself). Everything else — GitHub, Actions, the deploy webhook — is unchanged.
