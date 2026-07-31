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
FROM nginx:1.27-alpine AS runtime

# SPA-aware nginx config (routing fallback + asset caching)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Ship only the built output
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
