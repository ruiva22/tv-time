// Tiny production server: serves the built React app AND proxies TMDB.
//
// Why a server at all? So the TMDB API key stays on the box and never ships
// to the browser. The browser calls /api/*, this server adds the key and
// talks to TMDB, then returns a slimmed-down result.
//
// Env:
//   TMDB_API_KEY   (required)  — your TMDB v3 API key
//   PORT           (optional)  — defaults to 3000
//
// Endpoints:
//   GET /api/health          -> { ok, tmdb: bool }
//   GET /api/search?q=...     -> { results: [ {id,type,title,year,poster,overview} ] }
//   GET /api/title/:type/:id  -> single title with extra detail (seasons/eps/runtime/genre)

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.TMDB_API_KEY || "";
const IMG = "https://image.tmdb.org/t/p/w500";
const TMDB = "https://api.themoviedb.org/3";

// Map a TMDB record (movie or tv) to the shape the app understands.
function toCard(r) {
  const isTv = r.media_type === "tv" || (!r.media_type && r.name);
  const date = isTv ? r.first_air_date : r.release_date;
  return {
    id: String(r.id),
    type: isTv ? "show" : "movie",
    title: isTv ? r.name : r.title,
    year: date ? Number(date.slice(0, 4)) : null,
    poster: r.poster_path ? IMG + r.poster_path : null,
    overview: r.overview || "",
    popularity: r.popularity || 0,
  };
}

async function tmdb(endpoint, params = {}) {
  const url = new URL(TMDB + endpoint);
  url.searchParams.set("api_key", KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, tmdb: Boolean(KEY) });
});

// Multi-search (movies + tv), filtered to those two media types.
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ results: [] });
  if (!KEY) return res.status(503).json({ error: "TMDB key not configured" });
  try {
    const data = await tmdb("/search/multi", { query: q, include_adult: "false" });
    const results = (data.results || [])
      .filter((r) => r.media_type === "movie" || r.media_type === "tv")
      .map(toCard)
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 30);
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Full detail for one title — used when adding, to capture genre + counts.
app.get("/api/title/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!KEY) return res.status(503).json({ error: "TMDB key not configured" });
  const kind = type === "show" ? "tv" : "movie";
  try {
    const r = await tmdb(`/${kind}/${id}`);
    const card = toCard({ ...r, media_type: kind });
    const genre = r.genres?.[0]?.name || "—";
    if (kind === "tv") {
      res.json({
        ...card, genre,
        seasons: r.number_of_seasons || 1,
        episodes: r.number_of_episodes || 1,
      });
    } else {
      res.json({ ...card, genre, runtime: r.runtime || 0 });
    }
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// --- static SPA ---
const dist = path.join(__dirname, "dist");
app.use(express.static(dist));
// SPA fallback: any non-API route returns index.html so client routing works.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(dist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`tv-time listening on :${PORT} (tmdb ${KEY ? "on" : "OFF"})`);
});
