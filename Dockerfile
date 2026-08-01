# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Install deps from the lockfile (reproducible)
COPY package.json package-lock.json ./
RUN npm ci

# Build the static site
COPY . .
RUN npm run build

# ---- serve stage ----
# Node serves BOTH the built SPA and the /api TMDB proxy, so the API key
# stays server-side (passed in as TMDB_API_KEY at runtime).
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Only the production deps needed to run the server.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The server and the built assets.
COPY server.js ./
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "server.js"]
