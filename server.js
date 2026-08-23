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
//   GET /api/title/show/:id/season/:season -> episode list for one season
//                                              (name/still/overview/airDate/rating)
//   GET /api/discover?page=N  -> shuffled batch of popular movies+shows, for
//                                 the Explore tab's infinite poster feed. `page`
//                                 is just a client-side counter, not a raw TMDB
//                                 page — see mapping below.

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
        // Per-season episode counts, so the client can build an episode
        // picker without guessing how episodes divide across seasons.
        seasonList: (r.seasons || [])
          .filter((s) => s.season_number > 0) // skip "Specials"
          .map((s) => ({
            number: s.season_number,
            name: s.name,
            episodeCount: s.episode_count || 0,
          })),
      });
    } else {
      res.json({ ...card, genre, runtime: r.runtime || 0 });
    }
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// One season's episode list — name, still image, overview, air date, rating.
app.get("/api/title/show/:id/season/:season", async (req, res) => {
  const { id, season } = req.params;
  if (!KEY) return res.status(503).json({ error: "TMDB key not configured" });
  try {
    const r = await tmdb(`/tv/${id}/season/${season}`);
    const episodes = (r.episodes || []).map((e) => ({
      number: e.episode_number,
      name: e.name || `Episode ${e.episode_number}`,
      overview: e.overview || "",
      still: e.still_path ? IMG + e.still_path : null,
      airDate: e.air_date || null,
      rating: e.vote_average ? Math.round(e.vote_average * 10) / 10 : null,
    }));
    res.json({ season: Number(season), episodes });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Genre display name -> TMDB genre id, for movies and tv separately (TMDB
// uses different id spaces, and sometimes different names, for the two).
// Covers both TMDB's own official names (what a searched/added title's
// genre field holds) and this app's seed-catalog's casual names, so genre
// recommendations work for titles from either source.
const GENRE_IDS = {
  "Action": { movie: 28, tv: 10759 },
  "Action & Adventure": { movie: 28, tv: 10759 },
  "Adventure": { movie: 12, tv: 10759 },
  "Animation": { movie: 16, tv: 16 },
  "Comedy": { movie: 35, tv: 35 },
  "Crime": { movie: 80, tv: 80 },
  "Documentary": { movie: 99, tv: 99 },
  "Drama": { movie: 18, tv: 18 },
  "Family": { movie: 10751, tv: 10751 },
  "Fantasy": { movie: 14, tv: 10765 },
  "History": { movie: 36, tv: null },
  "Horror": { movie: 27, tv: null },
  "Music": { movie: 10402, tv: null },
  "Musical": { movie: 10402, tv: null },
  "Mystery": { movie: 9648, tv: 9648 },
  "Romance": { movie: 10749, tv: null },
  "Science Fiction": { movie: 878, tv: 10765 },
  "Sci-Fi": { movie: 878, tv: 10765 },
  "Sci-Fi & Fantasy": { movie: 878, tv: 10765 },
  "Thriller": { movie: 53, tv: null },
  "War": { movie: 10752, tv: 10768 },
  "War & Politics": { movie: 10752, tv: 10768 },
  "Western": { movie: 37, tv: 37 },
};

// A batch of popular movies + shows for the Explore feed, or (with `genre`)
// for Profile's "Recommended for you". `page` is an arbitrary counter from
// the client (it picks a random start, then increments as the user scrolls)
// — we spread it across TMDB's discover page range so different counters
// land on different, still-popular pages, and offset tv from movie so the
// two don't move in lockstep.
app.get("/api/discover", async (req, res) => {
  if (!KEY) return res.status(503).json({ error: "TMDB key not configured" });
  const n = Math.max(1, parseInt(req.query.page, 10) || 1);
  const moviePage = ((n - 1) % 500) + 1;
  const tvPage = ((n - 1 + 250) % 500) + 1;

  const genreName = (req.query.genre || "").toString();
  const g = genreName ? GENRE_IDS[genreName] : null;
  if (genreName && !g) return res.json({ results: [] }); // unmapped genre name — nothing to recommend

  const movieParams = { sort_by: "popularity.desc", page: moviePage, "vote_count.gte": 50 };
  const tvParams = { sort_by: "popularity.desc", page: tvPage, "vote_count.gte": 50 };
  if (g?.movie) movieParams.with_genres = g.movie;
  if (g?.tv) tvParams.with_genres = g.tv;

  try {
    const [movies, shows] = await Promise.all([
      g && !g.movie ? Promise.resolve({ results: [] }) : tmdb("/discover/movie", movieParams),
      g && !g.tv ? Promise.resolve({ results: [] }) : tmdb("/discover/tv", tvParams),
    ]);
    const cards = [
      ...(movies.results || []).map((r) => toCard({ ...r, media_type: "movie" })),
      ...(shows.results || []).map((r) => toCard({ ...r, media_type: "tv" })),
    ].filter((c) => c.poster); // skip posterless titles — they'd render as bare gradient tiles
    res.json({ results: shuffle(cards) });
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
