import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Tv, Clapperboard, Search, User, Bell, MoreHorizontal, ChevronRight,
  Star, Plus, Minus, Check, X, Clock, ListPlus, Trash2, Film, ArrowLeft,
} from "lucide-react";
import { db, configured, signIn, logOut, watchAuth } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

/* ------------------------------------------------------------------ */
/*  Seed catalog                                                       */
/* ------------------------------------------------------------------ */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const rawShows = [
  ["Breaking Bad", "Crime", 2008, 5, 62],
  ["The Bear", "Comedy", 2022, 3, 28],
  ["Severance", "Sci-Fi", 2022, 2, 19],
  ["Succession", "Drama", 2018, 4, 39],
  ["The Last of Us", "Drama", 2023, 1, 9],
  ["Fleabag", "Comedy", 2016, 2, 12],
  ["Chernobyl", "Drama", 2019, 1, 5],
  ["Dark", "Sci-Fi", 2017, 3, 26],
  ["Ted Lasso", "Comedy", 2020, 3, 34],
  ["Better Call Saul", "Crime", 2015, 6, 63],
  ["Arcane", "Animation", 2021, 2, 18],
  ["The Crown", "Drama", 2016, 6, 60],
  ["Stranger Things", "Sci-Fi", 2016, 4, 34],
  ["True Detective", "Crime", 2014, 4, 30],
  ["Andor", "Sci-Fi", 2022, 2, 24],
  ["Peaky Blinders", "Crime", 2013, 6, 36],
  ["The Wire", "Crime", 2002, 5, 60],
  ["Mad Men", "Drama", 2007, 7, 92],
  ["Shogun", "Drama", 2024, 1, 10],
  ["Ripley", "Thriller", 2024, 1, 8],
];

const rawMovies = [
  ["Parasite", "Thriller", 2019, 132],
  ["Everything Everywhere All at Once", "Sci-Fi", 2022, 139],
  ["Dune: Part Two", "Sci-Fi", 2024, 166],
  ["Oppenheimer", "Drama", 2023, 180],
  ["Past Lives", "Drama", 2023, 106],
  ["The Grand Budapest Hotel", "Comedy", 2014, 99],
  ["Whiplash", "Drama", 2014, 106],
  ["Blade Runner 2049", "Sci-Fi", 2017, 164],
  ["Portrait of a Lady on Fire", "Drama", 2019, 122],
  ["Mad Max: Fury Road", "Action", 2015, 120],
  ["Spirited Away", "Animation", 2001, 125],
  ["La La Land", "Musical", 2016, 128],
  ["Arrival", "Sci-Fi", 2016, 116],
  ["Moonlight", "Drama", 2016, 111],
  ["The Social Network", "Drama", 2010, 120],
  ["Get Out", "Horror", 2017, 104],
  ["Anatomy of a Fall", "Thriller", 2023, 152],
  ["Poor Things", "Comedy", 2023, 141],
  ["Aftersun", "Drama", 2022, 101],
  ["Into the Spider-Verse", "Animation", 2018, 117],
];

const EP_MIN = 45;

const CATALOG = [
  ...rawShows.map(([title, genre, year, seasons, episodes]) => ({
    id: slug(title), title, genre, year, type: "show", seasons, episodes,
  })),
  ...rawMovies.map(([title, genre, year, runtime]) => ({
    id: slug(title), title, genre, year, type: "movie", runtime,
  })),
];
const byId = Object.fromEntries(CATALOG.map((t) => [t.id, t]));

/* deterministic poster gradient from title */
function gradient(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  const h2 = (h + 48) % 360;
  return `linear-gradient(150deg, hsl(${h} 42% 26%), hsl(${h2} 38% 14%))`;
}

/* ------------------------------------------------------------------ */
/*  Persistence                                                        */
/* ------------------------------------------------------------------ */
const KEY = "cs_tracker_v1";
const defaultData = {
  tracking: {},            // id -> { status, rating, progress, addedAt, watchedAt }
  lists: [],               // { id, name, itemIds: [] }
  profile: { username: "you", following: 42, followers: 128, comments: 17 },
};

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const [tab, setTab] = useState("shows");
  const [data, setData] = useState(defaultData);
  const [ready, setReady] = useState(false);
  const [openId, setOpenId] = useState(null);       // detail sheet
  const [toast, setToast] = useState(null);         // { text, kind }
  const [listPick, setListPick] = useState(null);   // id being added to a list
  const [user, setUser] = useState(null);           // signed-in Google user
  const [authReady, setAuthReady] = useState(false);
  const toastTimer = useRef(null);
  const isRemote = useRef(false);                    // guards write-back on remote updates

  const notify = (text, kind = "ok") => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  // Track Google sign-in state.
  useEffect(() => {
    if (!configured) { setAuthReady(true); return; }
    return watchAuth((u) => { setUser(u); setAuthReady(true); });
  }, []);

  // Subscribe to this user's document — live updates from any device.
  useEffect(() => {
    if (!user) { setReady(false); return; }
    setReady(false);
    const ref = doc(db, "trackers", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          isRemote.current = true;
          setData({ ...defaultData, ...snap.data() });
        } else {
          setDoc(ref, defaultData);   // seed on first sign-in
          setData(defaultData);
        }
        setReady(true);
      },
      () => { setReady(true); notify("Sync paused — you're offline", "err"); }
    );
    return unsub;
  }, [user]);

  // Persist local edits. Skip echoes of remote updates to avoid a write loop.
  useEffect(() => {
    if (!ready || !user) return;
    if (isRemote.current) { isRemote.current = false; return; }
    setDoc(doc(db, "trackers", user.uid), data).catch(() => {});
  }, [data, ready, user]);

  /* --- mutations --- */
  const setEntry = (id, patch) =>
    setData((d) => {
      const prev = d.tracking[id] || {};
      const next = { ...prev, ...patch };
      return { ...d, tracking: { ...d.tracking, [id]: next } };
    });

  const track = (id, status) => {
    const exists = data.tracking[id];
    setEntry(id, {
      status,
      addedAt: exists?.addedAt || Date.now(),
      progress: exists?.progress || 0,
      rating: exists?.rating || 0,
      watchedAt: status === "watched" ? Date.now() : exists?.watchedAt,
    });
    const label = status === "want" ? "Added to your watchlist"
      : status === "watching" ? "Marked as watching" : "Marked as watched";
    notify(label);
  };

  const untrack = (id) =>
    setData((d) => {
      const t = { ...d.tracking }; delete t[id];
      const lists = d.lists.map((l) => ({ ...l, itemIds: l.itemIds.filter((x) => x !== id) }));
      return { ...d, tracking: t, lists };
    });

  const rate = (id, rating) => {
    const cur = data.tracking[id];
    const status = cur?.status || "watched";
    setEntry(id, {
      rating,
      status,
      addedAt: cur?.addedAt || Date.now(),
      watchedAt: cur?.watchedAt || (status === "watched" ? Date.now() : undefined),
    });
  };

  const setProgress = (id, val) => {
    const show = byId[id];
    const total = show?.episodes || 1;
    const p = Math.max(0, Math.min(total, val));
    const cur = data.tracking[id] || {};
    setEntry(id, {
      progress: p,
      status: p >= total ? "watched" : p > 0 ? "watching" : cur.status || "want",
      addedAt: cur.addedAt || Date.now(),
      watchedAt: p >= total ? Date.now() : cur.watchedAt,
    });
  };

  const createList = (name) =>
    setData((d) => ({ ...d, lists: [...d.lists, { id: "l_" + Date.now(), name, itemIds: [] }] }));
  const deleteList = (lid) =>
    setData((d) => ({ ...d, lists: d.lists.filter((l) => l.id !== lid) }));
  const toggleInList = (lid, itemId) =>
    setData((d) => ({
      ...d,
      lists: d.lists.map((l) =>
        l.id !== lid ? l
          : { ...l, itemIds: l.itemIds.includes(itemId) ? l.itemIds.filter((x) => x !== itemId) : [...l.itemIds, itemId] }),
    }));

  if (!configured) return <Gate><Setup /></Gate>;
  if (!authReady) return <div className="cs-root cs-boot"><style>{CSS}</style>Loading…</div>;
  if (!user) return <Gate><SignIn onSignIn={() => signIn().catch(() => notify("Sign-in failed — try again", "err"))} /></Gate>;
  if (!ready) return <div className="cs-root cs-boot"><style>{CSS}</style>Loading your library…</div>;

  const openTitle = openId ? byId[openId] : null;

  return (
    <div className="cs-root">
      <style>{CSS}</style>

      <div className="cs-screen">
        {tab === "shows" && (
          <Library type="show" data={data} onOpen={setOpenId} goExplore={() => setTab("explore")} />
        )}
        {tab === "movies" && (
          <Library type="movie" data={data} onOpen={setOpenId} goExplore={() => setTab("explore")} />
        )}
        {tab === "explore" && <Explore data={data} onOpen={setOpenId} />}
        {tab === "profile" && (
          <Profile data={data} user={user} onOpen={setOpenId} onCreateList={createList}
            onDeleteList={deleteList} notify={notify}
            onSignOut={() => { logOut(); notify("Signed out"); }} />
        )}
      </div>

      {/* toast — styled after the app's inline banner */}
      {toast && (
        <div className={"cs-toast " + (toast.kind === "err" ? "err" : "ok")}>
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)}>DISMISS</button>
        </div>
      )}

      <nav className="cs-nav">
        {[
          ["shows", Tv, "Shows"],
          ["movies", Clapperboard, "Movies"],
          ["explore", Search, "Explore"],
          ["profile", User, "Profile"],
        ].map(([id, Icon, label]) => (
          <button key={id} className={"cs-navbtn" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>
            <Icon size={24} strokeWidth={1.9} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {openTitle && (
        <Detail
          title={openTitle} entry={data.tracking[openTitle.id]} lists={data.lists}
          onClose={() => setOpenId(null)}
          onTrack={(s) => track(openTitle.id, s)}
          onUntrack={() => { untrack(openTitle.id); setOpenId(null); notify("Removed from your library"); }}
          onRate={(r) => rate(openTitle.id, r)}
          onProgress={(v) => setProgress(openTitle.id, v)}
          onOpenListPick={() => setListPick(openTitle.id)}
        />
      )}

      {listPick && (
        <ListPicker
          itemId={listPick} lists={data.lists}
          onToggle={(lid) => toggleInList(lid, listPick)}
          onCreate={(name) => createList(name)}
          onClose={() => setListPick(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Library (Shows / Movies)                                           */
/* ------------------------------------------------------------------ */
const SHOW_FILTERS = [["watching", "Watching"], ["want", "Watchlist"], ["watched", "Watched"]];
const MOVIE_FILTERS = [["want", "Watchlist"], ["watched", "Watched"]];

function Library({ type, data, onOpen, goExplore }) {
  const filters = type === "show" ? SHOW_FILTERS : MOVIE_FILTERS;
  const [f, setF] = useState(filters[0][0]);

  const items = useMemo(() => {
    return Object.entries(data.tracking)
      .filter(([id, e]) => byId[id]?.type === type && e.status === f)
      .map(([id, e]) => ({ ...byId[id], ...e }))
      .sort((a, b) => (b.watchedAt || b.addedAt || 0) - (a.watchedAt || a.addedAt || 0));
  }, [data, type, f]);

  return (
    <>
      <Header title={type === "show" ? "Shows" : "Movies"} />
      <div className="cs-tabs">
        {filters.map(([id, label]) => {
          const n = Object.entries(data.tracking).filter(([tid, e]) => byId[tid]?.type === type && e.status === id).length;
          return (
            <button key={id} className={"cs-chip" + (f === id ? " on" : "")} onClick={() => setF(id)}>
              {label} <em>{n}</em>
            </button>
          );
        })}
      </div>

      <div className="cs-body">
        {items.length === 0 ? (
          <Empty
            icon={type === "show" ? <Tv size={26} /> : <Film size={26} />}
            head={f === "watched" ? "Nothing logged here yet" : "This shelf is empty"}
            sub={type === "show" ? "Find something worth your evening in Explore." : "Line up a film to watch next in Explore."}
            cta="Go to Explore" onCta={goExplore}
          />
        ) : (
          <div className="cs-list">
            {items.map((it) => <Row key={it.id} item={it} onOpen={() => onOpen(it.id)} />)}
          </div>
        )}
      </div>
    </>
  );
}

function Row({ item, onOpen }) {
  const total = item.episodes || 1;
  const pct = item.type === "show" ? Math.round(((item.progress || 0) / total) * 100) : null;
  return (
    <button className="cs-row" onClick={onOpen}>
      <div className="cs-poster sm" style={{ background: gradient(item.title) }}>
        <span>{item.title}</span>
      </div>
      <div className="cs-rowmeta">
        <div className="cs-rowtitle">{item.title}</div>
        <div className="cs-rowsub">{item.genre} · {item.year}</div>
        {item.type === "show" && item.status !== "want" && (
          <div className="cs-prog">
            <div className="cs-progbar"><i style={{ width: pct + "%" }} /></div>
            <span>{item.progress || 0}/{total}</span>
          </div>
        )}
        {item.rating > 0 && (
          <div className="cs-stars sm">
            {[1, 2, 3, 4, 5].map((s) => (
              <Star key={s} size={13} fill={s <= item.rating ? "#FFD426" : "none"}
                color={s <= item.rating ? "#FFD426" : "#48484a"} strokeWidth={1.5} />
            ))}
          </div>
        )}
      </div>
      <ChevronRight size={20} className="cs-dim" />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Explore                                                            */
/* ------------------------------------------------------------------ */
function Explore({ data, onOpen }) {
  const [q, setQ] = useState("");
  const [g, setG] = useState("All");
  const genres = useMemo(() => ["All", ...Array.from(new Set(CATALOG.map((t) => t.genre))).sort()], []);
  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    return CATALOG.filter((t) =>
      (g === "All" || t.genre === g) &&
      (!query || t.title.toLowerCase().includes(query))
    );
  }, [q, g]);

  return (
    <>
      <Header title="Explore" />
      <div className="cs-searchwrap">
        <Search size={18} className="cs-dim" />
        <input className="cs-search" placeholder="Search shows and movies"
          value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="cs-clear" onClick={() => setQ("")}><X size={16} /></button>}
      </div>
      <div className="cs-tabs">
        {genres.map((gn) => (
          <button key={gn} className={"cs-chip" + (g === gn ? " on" : "")} onClick={() => setG(gn)}>{gn}</button>
        ))}
      </div>
      <div className="cs-body">
        <div className="cs-grid">
          {results.map((t) => {
            const tracked = data.tracking[t.id];
            return (
              <button key={t.id} className="cs-gcard" onClick={() => onOpen(t.id)}>
                <div className="cs-poster" style={{ background: gradient(t.title) }}>
                  <span>{t.title}</span>
                  {tracked && <div className="cs-badge">{tracked.status === "watched" ? "✓" : tracked.status === "watching" ? "▸" : "+"}</div>}
                </div>
                <div className="cs-gtitle">{t.title}</div>
                <div className="cs-gsub">{t.type === "show" ? "TV" : "Film"} · {t.year}</div>
              </button>
            );
          })}
        </div>
        {results.length === 0 && (
          <Empty icon={<Search size={26} />} head="No matches" sub="Try a different title or genre." />
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile  (closely mirrors the reference screen)                    */
/* ------------------------------------------------------------------ */
function Profile({ data, user, onOpen, onCreateList, onDeleteList, notify, onSignOut }) {
  const [showNew, setShowNew] = useState(false);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState("");

  const stats = useMemo(() => {
    const entries = Object.entries(data.tracking).map(([id, e]) => ({ ...byId[id], ...e }));
    const showsWatched = entries.filter((e) => e.type === "show" && e.status === "watched").length;
    const showsWatching = entries.filter((e) => e.type === "show" && e.status === "watching").length;
    const moviesWatched = entries.filter((e) => e.type === "movie" && e.status === "watched").length;
    const eps = entries.filter((e) => e.type === "show").reduce((a, e) => a + (e.progress || 0), 0);
    const showMins = eps * EP_MIN;
    const movieMins = entries.filter((e) => e.type === "movie" && e.status === "watched")
      .reduce((a, e) => a + (e.runtime || 0), 0);
    const hours = Math.round((showMins + movieMins) / 60);
    const rated = entries.filter((e) => e.rating > 0);
    const avg = rated.length ? (rated.reduce((a, e) => a + e.rating, 0) / rated.length).toFixed(1) : "—";
    return { showsWatched, showsWatching, moviesWatched, eps, hours, avg };
  }, [data]);

  const create = () => {
    const n = name.trim();
    if (!n) return;
    onCreateList(n); setName(""); setShowNew(false); notify("List created");
  };

  return (
    <div className="cs-profile">
      <div className="cs-phead">
        <div className="cs-bell"><Bell size={20} fill="#000" color="#000" /></div>
        <div className="cs-menuwrap">
          <button className="cs-iconbtn" onClick={() => setMenu((v) => !v)}>
            <MoreHorizontal size={22} className="cs-dim" />
          </button>
          {menu && (
            <div className="cs-menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); onSignOut(); }}>Sign out</button>
            </div>
          )}
        </div>
      </div>

      <div className="cs-pid">
        {user?.photoURL
          ? <img className="cs-avatar" src={user.photoURL} alt="" referrerPolicy="no-referrer" />
          : <div className="cs-avatar">{(user?.displayName || user?.email || "?").slice(0, 1).toUpperCase()}</div>}
        <div>
          <div className="cs-uname">{user?.displayName || "Your library"}</div>
          <div className="cs-usub">{user?.email || "Synced across your devices"}</div>
        </div>
      </div>

      <div className="cs-social">
        {[["following", data.profile.following], ["followers", data.profile.followers], ["comments", data.profile.comments]]
          .map(([label, n], i) => (
            <div key={label} className={"cs-socell" + (i < 2 ? " div" : "")}>
              <b>{n}</b><span>{label}</span>
            </div>
          ))}
      </div>

      <section className="cs-sec">
        <div className="cs-sechead"><h3>Stats</h3><ChevronRight size={22} className="cs-dim" /></div>
        <div className="cs-card">
          <div className="cs-statgrid">
            <Stat n={stats.showsWatched} l="Shows finished" />
            <Stat n={stats.showsWatching} l="In progress" />
            <Stat n={stats.moviesWatched} l="Films watched" />
            <Stat n={stats.eps} l="Episodes" />
            <Stat n={stats.hours} l="Hours" />
            <Stat n={stats.avg} l="Avg rating" />
          </div>
        </div>
      </section>

      <section className="cs-sec">
        <div className="cs-sechead">
          <h3>Lists</h3>
          <button className="cs-plus" onClick={() => setShowNew((v) => !v)}><Plus size={20} /></button>
        </div>
        <div className="cs-card">
          {showNew && (
            <div className="cs-newlist">
              <input autoFocus placeholder="Name your list" value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()} />
              <button className="cs-pill sm" onClick={create}>Create</button>
            </div>
          )}
          {data.lists.length === 0 && !showNew ? (
            <div className="cs-listempty">
              <p>No lists yet.</p>
              <span>Group films and shows however you like — a rewatch pile, a date-night queue, a best-of.</span>
              <button className="cs-pill" onClick={() => setShowNew(true)}>New list</button>
            </div>
          ) : (
            data.lists.map((l) => (
              <div key={l.id} className="cs-listrow">
                <div className="cs-listmini">
                  {l.itemIds.slice(0, 3).map((id) => (
                    <span key={id} style={{ background: gradient(byId[id]?.title || id) }} />
                  ))}
                  {l.itemIds.length === 0 && <span className="cs-listminiempty" />}
                </div>
                <div className="cs-listmeta">
                  <div className="cs-listname">{l.name}</div>
                  <div className="cs-rowsub">{l.itemIds.length} {l.itemIds.length === 1 ? "title" : "titles"}</div>
                </div>
                <button className="cs-icon" onClick={() => onDeleteList(l.id)}><Trash2 size={17} /></button>
              </div>
            ))
          )}
        </div>
      </section>
      <div style={{ height: 20 }} />
    </div>
  );
}
const Stat = ({ n, l }) => (<div className="cs-stat"><b>{n}</b><span>{l}</span></div>);

/* ------------------------------------------------------------------ */
/*  Detail sheet                                                       */
/* ------------------------------------------------------------------ */
function Detail({ title, entry, lists, onClose, onTrack, onUntrack, onRate, onProgress, onOpenListPick }) {
  const total = title.episodes || 1;
  const inList = lists.some((l) => l.itemIds.includes(title.id));
  return (
    <div className="cs-modal" onClick={onClose}>
      <div className="cs-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cs-grab" />
        <button className="cs-close" onClick={onClose}><X size={20} /></button>

        <div className="cs-dhero" style={{ background: gradient(title.title) }}>
          <span>{title.title}</span>
        </div>

        <div className="cs-dtitle">{title.title}</div>
        <div className="cs-dmeta">
          {title.type === "show" ? "TV Series" : "Film"} · {title.genre} · {title.year}
          {title.type === "show" ? ` · ${title.seasons} ${title.seasons === 1 ? "season" : "seasons"}, ${title.episodes} eps`
            : ` · ${title.runtime} min`}
        </div>

        {/* status buttons */}
        <div className="cs-statusrow">
          {title.type === "show" && (
            <button className={"cs-pill full" + (entry?.status === "watching" ? " active" : "")}
              onClick={() => onTrack("watching")}>Watching</button>
          )}
          <button className={"cs-pill full" + (entry?.status === "want" ? " active" : "")}
            onClick={() => onTrack("want")}>Watchlist</button>
          <button className={"cs-pill full" + (entry?.status === "watched" ? " active" : "")}
            onClick={() => onTrack("watched")}>Watched</button>
        </div>

        {/* rating */}
        <div className="cs-block">
          <div className="cs-blabel">Your rating</div>
          <div className="cs-stars">
            {[1, 2, 3, 4, 5].map((s) => (
              <button key={s} onClick={() => onRate(entry?.rating === s ? 0 : s)}>
                <Star size={30} fill={s <= (entry?.rating || 0) ? "#FFD426" : "none"}
                  color={s <= (entry?.rating || 0) ? "#FFD426" : "#48484a"} strokeWidth={1.5} />
              </button>
            ))}
          </div>
        </div>

        {/* progress (shows only) */}
        {title.type === "show" && (
          <div className="cs-block">
            <div className="cs-blabel">Episodes watched</div>
            <div className="cs-stepper">
              <button onClick={() => onProgress((entry?.progress || 0) - 1)}><Minus size={18} /></button>
              <div className="cs-stepval">
                <b>{entry?.progress || 0}</b><span>of {total}</span>
              </div>
              <button onClick={() => onProgress((entry?.progress || 0) + 1)}><Plus size={18} /></button>
            </div>
            <div className="cs-progbar big"><i style={{ width: ((entry?.progress || 0) / total) * 100 + "%" }} /></div>
          </div>
        )}

        {/* actions */}
        <div className="cs-actions">
          <button className="cs-line" onClick={onOpenListPick}>
            <ListPlus size={19} /> {inList ? "In a list · edit" : "Add to a list"}
          </button>
          {entry && (
            <button className="cs-line danger" onClick={onUntrack}>
              <Trash2 size={19} /> Remove from library
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  List picker                                                        */
/* ------------------------------------------------------------------ */
function ListPicker({ itemId, lists, onToggle, onCreate, onClose }) {
  const [name, setName] = useState("");
  return (
    <div className="cs-modal" onClick={onClose}>
      <div className="cs-sheet short" onClick={(e) => e.stopPropagation()}>
        <div className="cs-grab" />
        <div className="cs-dtitle sm">Add to list</div>
        <div className="cs-newlist tight">
          <input placeholder="New list name" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { onCreate(name.trim()); setName(""); } }} />
          <button className="cs-pill sm" onClick={() => { if (name.trim()) { onCreate(name.trim()); setName(""); } }}>Create</button>
        </div>
        <div className="cs-picklist">
          {lists.length === 0 && <div className="cs-rowsub" style={{ padding: "8px 2px" }}>No lists yet — create one above.</div>}
          {lists.map((l) => {
            const on = l.itemIds.includes(itemId);
            return (
              <button key={l.id} className="cs-pickrow" onClick={() => onToggle(l.id)}>
                <span>{l.name}</span>
                <div className={"cs-check" + (on ? " on" : "")}>{on && <Check size={15} />}</div>
              </button>
            );
          })}
        </div>
        <button className="cs-pill full" onClick={onClose} style={{ marginTop: 8 }}>Done</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared bits                                                        */
/* ------------------------------------------------------------------ */
const Header = ({ title }) => (
  <div className="cs-header">
    <div className="cs-bell sm"><Bell size={17} fill="#000" color="#000" /></div>
    <h1>{title}</h1>
    <MoreHorizontal size={22} className="cs-dim" />
  </div>
);

const Empty = ({ icon, head, sub, cta, onCta }) => (
  <div className="cs-empty">
    <div className="cs-emptyicon">{icon}</div>
    <h4>{head}</h4>
    <p>{sub}</p>
    {cta && <button className="cs-pill" onClick={onCta}>{cta}</button>}
  </div>
);

/* full-screen wrapper for pre-app states */
const Gate = ({ children }) => (
  <div className="cs-root"><style>{CSS}</style><div className="cs-gate">{children}</div></div>
);

function SignIn({ onSignIn }) {
  return (
    <div className="cs-signin">
      <div className="cs-bell lg"><Bell size={26} fill="#000" color="#000" /></div>
      <h1>Your watchlist,<br />on every screen</h1>
      <p>Sign in to track shows and films and keep them in sync across your devices.</p>
      <button className="cs-google" onClick={onSignIn}>
        <GoogleMark /> Continue with Google
      </button>
    </div>
  );
}

const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
    <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
  </svg>
);

function Setup() {
  return (
    <div className="cs-setup">
      <h1>One-time setup</h1>
      <p>Cross-device sync needs a Firebase project. Add your web config to
        <code>src/firebase.js</code>, then reload.</p>
      <ol>
        <li>In the Firebase console, create a <b>Web app</b> and copy its config.</li>
        <li>Enable <b>Authentication → Google</b>.</li>
        <li>Enable <b>Firestore Database</b>.</li>
        <li>Paste the config into <code>src/firebase.js</code>.</li>
      </ol>
      <p className="cs-setupnote">Full steps are in <code>README.md</code>.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.cs-root {
  --bg:#000; --card:#1c1c1e; --card2:#2c2c2e; --line:rgba(255,255,255,.10);
  --txt:#fff; --mut:#8e8e93; --dim:#5a5a5e; --acc:#FFD426;
  position:absolute; inset:0; background:var(--bg); color:var(--txt);
  font-family:'Poppins', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  display:flex; flex-direction:column; overflow:hidden;
}
.cs-boot{ align-items:center; justify-content:center; color:var(--mut); font-size:14px; }
.cs-screen{ flex:1; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; }
.cs-dim{ color:var(--dim); }

/* header */
.cs-header{ display:flex; align-items:center; gap:14px; padding:18px 20px 8px; }
.cs-header h1{ flex:1; margin:0; font-size:26px; font-weight:700; letter-spacing:-.02em; }
.cs-bell{ width:34px; height:34px; border-radius:50%; background:var(--acc); display:flex; align-items:center; justify-content:center; }
.cs-bell.sm{ width:30px; height:30px; }

/* filter chips */
.cs-tabs{ display:flex; gap:8px; padding:6px 20px 12px; overflow-x:auto; scrollbar-width:none; }
.cs-tabs::-webkit-scrollbar{ display:none; }
.cs-chip{ flex:0 0 auto; background:var(--card); border:1px solid transparent; color:var(--mut);
  padding:8px 14px; border-radius:999px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; }
.cs-chip em{ font-style:normal; opacity:.55; margin-left:4px; }
.cs-chip.on{ background:var(--txt); color:#000; }
.cs-chip.on em{ opacity:.5; }

.cs-body{ padding:4px 20px 24px; }

/* list rows */
.cs-list{ display:flex; flex-direction:column; gap:10px; }
.cs-row{ display:flex; align-items:center; gap:14px; width:100%; text-align:left;
  background:var(--card); border:none; border-radius:16px; padding:12px; cursor:pointer; font-family:inherit; color:var(--txt); }
.cs-rowmeta{ flex:1; min-width:0; }
.cs-rowtitle{ font-size:15px; font-weight:600; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cs-rowsub{ font-size:12.5px; color:var(--mut); margin-top:2px; }
.cs-prog{ display:flex; align-items:center; gap:8px; margin-top:7px; }
.cs-progbar{ flex:1; height:4px; background:#3a3a3c; border-radius:3px; overflow:hidden; }
.cs-progbar i{ display:block; height:100%; background:var(--acc); border-radius:3px; }
.cs-progbar.big{ height:6px; margin-top:12px; }
.cs-prog span{ font-size:11px; color:var(--mut); font-variant-numeric:tabular-nums; }
.cs-stars{ display:flex; gap:3px; }
.cs-stars.sm{ margin-top:6px; }

/* posters */
.cs-poster{ position:relative; border-radius:12px; display:flex; align-items:flex-end; overflow:hidden; }
.cs-poster span{ padding:8px; font-size:12px; font-weight:600; line-height:1.15; text-shadow:0 1px 4px rgba(0,0,0,.5); }
.cs-poster.sm{ width:52px; height:70px; flex:0 0 52px; }
.cs-poster.sm span{ display:none; }
.cs-badge{ position:absolute; top:5px; right:5px; width:20px; height:20px; border-radius:50%;
  background:var(--acc); color:#000; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }

/* explore grid */
.cs-searchwrap{ display:flex; align-items:center; gap:10px; margin:6px 20px 0; background:var(--card);
  border-radius:12px; padding:11px 14px; }
.cs-search{ flex:1; background:none; border:none; outline:none; color:var(--txt); font-size:15px; font-family:inherit; }
.cs-search::placeholder{ color:var(--dim); }
.cs-clear{ background:none; border:none; color:var(--mut); cursor:pointer; display:flex; padding:0; }
.cs-grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px 12px; }
.cs-gcard{ background:none; border:none; padding:0; cursor:pointer; text-align:left; font-family:inherit; color:var(--txt); }
.cs-gcard .cs-poster{ aspect-ratio:2/3; width:100%; }
.cs-gcard .cs-poster span{ font-size:11px; }
.cs-gtitle{ font-size:12.5px; font-weight:600; margin-top:7px; line-height:1.25;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.cs-gsub{ font-size:11px; color:var(--mut); margin-top:1px; }

/* empty */
.cs-empty{ text-align:center; padding:48px 24px; }
.cs-emptyicon{ width:60px; height:60px; margin:0 auto 16px; border-radius:50%; background:var(--card);
  display:flex; align-items:center; justify-content:center; color:var(--mut); }
.cs-empty h4{ margin:0 0 6px; font-size:17px; font-weight:600; }
.cs-empty p{ margin:0 0 18px; font-size:13.5px; color:var(--mut); line-height:1.5; max-width:260px; margin-left:auto; margin-right:auto; }

/* pills / buttons */
.cs-pill{ background:none; color:var(--txt); border:1.5px solid rgba(255,255,255,.55);
  padding:11px 22px; border-radius:999px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
.cs-pill.sm{ padding:8px 16px; font-size:13px; }
.cs-pill.full{ flex:1; text-align:center; padding:12px 8px; }
.cs-pill.active{ background:var(--acc); color:#000; border-color:var(--acc); }

/* profile */
.cs-profile{ padding-bottom:24px; }
.cs-phead{ display:flex; align-items:center; justify-content:space-between; padding:18px 20px 10px; }
.cs-pid{ display:flex; align-items:center; gap:14px; padding:6px 20px 18px; }
.cs-avatar{ width:56px; height:56px; border-radius:50%; background:var(--card2);
  display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700; color:var(--acc); }
.cs-uname{ font-size:18px; font-weight:700; }
.cs-usub{ font-size:12.5px; color:var(--mut); margin-top:1px; }
.cs-social{ display:flex; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
.cs-socell{ flex:1; text-align:center; padding:16px 4px; }
.cs-socell.div{ border-right:1px solid var(--line); }
.cs-socell b{ display:block; font-size:20px; font-weight:700; }
.cs-socell span{ font-size:13px; color:var(--mut); }

.cs-sec{ padding:26px 20px 0; }
.cs-sechead{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.cs-sechead h3{ margin:0; font-size:22px; font-weight:700; letter-spacing:-.02em; }
.cs-plus{ background:var(--card); border:none; color:var(--txt); width:34px; height:34px; border-radius:50%;
  display:flex; align-items:center; justify-content:center; cursor:pointer; }
.cs-card{ background:var(--card); border-radius:18px; padding:18px; }
.cs-statgrid{ display:grid; grid-template-columns:repeat(3,1fr); gap:20px 8px; }
.cs-stat{ text-align:center; }
.cs-stat b{ display:block; font-size:24px; font-weight:700; letter-spacing:-.02em; }
.cs-stat span{ font-size:11.5px; color:var(--mut); }

.cs-listempty{ text-align:center; padding:14px 8px 8px; }
.cs-listempty p{ margin:0 0 4px; font-weight:600; }
.cs-listempty span{ display:block; font-size:12.5px; color:var(--mut); line-height:1.5; margin-bottom:16px; }
.cs-newlist{ display:flex; gap:8px; margin-bottom:6px; }
.cs-newlist.tight{ margin:8px 0 4px; }
.cs-newlist input{ flex:1; background:var(--card2); border:none; border-radius:10px; padding:11px 13px;
  color:var(--txt); font-size:14px; outline:none; font-family:inherit; }
.cs-newlist input::placeholder{ color:var(--dim); }
.cs-listrow{ display:flex; align-items:center; gap:13px; padding:11px 0; border-bottom:1px solid var(--line); }
.cs-listrow:last-child{ border-bottom:none; }
.cs-listmini{ display:flex; width:46px; height:46px; border-radius:10px; overflow:hidden; }
.cs-listmini span{ flex:1; }
.cs-listminiempty{ background:var(--card2); }
.cs-listmeta{ flex:1; }
.cs-listname{ font-size:15px; font-weight:600; }
.cs-icon{ background:none; border:none; color:var(--dim); cursor:pointer; padding:6px; display:flex; }

/* modal + sheet */
.cs-modal{ position:absolute; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:flex-end;
  z-index:40; animation:fade .18s ease; }
@keyframes fade{ from{opacity:0} to{opacity:1} }
.cs-sheet{ width:100%; max-height:90%; overflow-y:auto; background:#141416; border-radius:24px 24px 0 0;
  padding:10px 20px 30px; position:relative; animation:rise .26s cubic-bezier(.2,.8,.2,1); }
.cs-sheet.short{ padding-bottom:24px; }
@keyframes rise{ from{transform:translateY(30px)} to{transform:translateY(0)} }
.cs-grab{ width:38px; height:4px; border-radius:3px; background:#48484a; margin:2px auto 14px; }
.cs-close{ position:absolute; top:14px; right:16px; background:var(--card2); border:none; color:var(--txt);
  width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:2; }
.cs-dhero{ height:150px; border-radius:16px; display:flex; align-items:flex-end; padding:16px; margin-bottom:16px; }
.cs-dhero span{ font-size:20px; font-weight:700; text-shadow:0 2px 8px rgba(0,0,0,.5); }
.cs-dtitle{ font-size:22px; font-weight:700; letter-spacing:-.02em; line-height:1.15; }
.cs-dtitle.sm{ font-size:19px; margin-bottom:4px; }
.cs-dmeta{ font-size:13px; color:var(--mut); margin-top:5px; }
.cs-statusrow{ display:flex; gap:8px; margin:20px 0 6px; }
.cs-block{ margin-top:22px; }
.cs-blabel{ font-size:13px; color:var(--mut); margin-bottom:10px; font-weight:500; }
.cs-block .cs-stars{ gap:8px; }
.cs-block .cs-stars button{ background:none; border:none; padding:0; cursor:pointer; display:flex; }
.cs-stepper{ display:flex; align-items:center; gap:18px; }
.cs-stepper button{ width:44px; height:44px; border-radius:50%; background:var(--card2); border:none; color:var(--txt);
  display:flex; align-items:center; justify-content:center; cursor:pointer; }
.cs-stepval{ text-align:center; min-width:60px; }
.cs-stepval b{ font-size:26px; font-weight:700; }
.cs-stepval span{ display:block; font-size:11px; color:var(--mut); }
.cs-actions{ margin-top:26px; display:flex; flex-direction:column; gap:2px; }
.cs-line{ display:flex; align-items:center; gap:12px; width:100%; background:none; border:none; color:var(--txt);
  padding:15px 4px; font-size:15px; cursor:pointer; font-family:inherit; border-top:1px solid var(--line); text-align:left; }
.cs-line.danger{ color:#ff6b6b; }

/* list picker */
.cs-picklist{ margin:12px 0 4px; display:flex; flex-direction:column; }
.cs-pickrow{ display:flex; align-items:center; justify-content:space-between; background:none; border:none;
  color:var(--txt); padding:14px 2px; font-size:15px; cursor:pointer; font-family:inherit;
  border-bottom:1px solid var(--line); }
.cs-check{ width:24px; height:24px; border-radius:50%; border:1.5px solid var(--dim); display:flex;
  align-items:center; justify-content:center; color:#000; }
.cs-check.on{ background:var(--acc); border-color:var(--acc); }

/* toast (mirrors the app banner) */
.cs-toast{ position:absolute; left:16px; right:16px; bottom:88px; z-index:50; border-radius:14px;
  padding:16px 18px; display:flex; align-items:center; justify-content:space-between; gap:12px;
  font-size:14.5px; animation:rise .22s ease; box-shadow:0 8px 24px rgba(0,0,0,.4); }
.cs-toast.ok{ background:#e9f7ef; color:#0d2818; }
.cs-toast.err{ background:#f8d3d6; color:#3a1114; }
.cs-toast button{ background:none; border:none; font-size:13px; font-weight:700; letter-spacing:.04em;
  color:inherit; cursor:pointer; font-family:inherit; }

/* bottom nav */
.cs-nav{ display:flex; border-top:1px solid var(--line); background:#050505; padding:8px 4px 10px; }
.cs-navbtn{ flex:1; background:none; border:none; color:var(--dim); display:flex; flex-direction:column;
  align-items:center; gap:4px; padding:4px; cursor:pointer; font-family:inherit; }
.cs-navbtn span{ font-size:11px; }
.cs-navbtn.on{ color:var(--txt); }

/* gate screens (sign-in / setup) */
.cs-gate{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:32px; }
.cs-signin{ max-width:340px; text-align:center; }
.cs-bell.lg{ width:56px; height:56px; margin:0 auto 26px; }
.cs-signin h1{ font-size:30px; font-weight:700; letter-spacing:-.03em; line-height:1.12; margin:0 0 14px; }
.cs-signin p{ font-size:14.5px; color:var(--mut); line-height:1.55; margin:0 0 30px; }
.cs-google{ display:inline-flex; align-items:center; gap:11px; background:#fff; color:#1a1a1a;
  border:none; border-radius:999px; padding:14px 26px; font-size:15px; font-weight:600;
  cursor:pointer; font-family:inherit; }
.cs-google:active{ transform:scale(.98); }
.cs-setup{ max-width:360px; }
.cs-setup h1{ font-size:26px; font-weight:700; letter-spacing:-.02em; margin:0 0 12px; }
.cs-setup p{ font-size:14px; color:var(--mut); line-height:1.6; margin:0 0 16px; }
.cs-setup ol{ margin:0 0 8px; padding-left:20px; }
.cs-setup li{ font-size:14px; color:#d8d8dc; line-height:1.5; margin-bottom:9px; }
.cs-setup code{ background:var(--card2); padding:2px 6px; border-radius:5px; font-size:12.5px; }
.cs-setupnote{ margin-top:8px; }

/* profile menu + avatar image */
.cs-menuwrap{ position:relative; }
.cs-iconbtn{ background:none; border:none; padding:2px; cursor:pointer; display:flex; }
.cs-menu{ position:absolute; top:34px; right:0; background:var(--card2); border-radius:12px;
  padding:5px; min-width:140px; box-shadow:0 10px 30px rgba(0,0,0,.5); z-index:20; }
.cs-menu button{ width:100%; text-align:left; background:none; border:none; color:var(--txt);
  padding:11px 12px; font-size:14px; border-radius:8px; cursor:pointer; font-family:inherit; }
.cs-menu button:hover{ background:rgba(255,255,255,.06); }
img.cs-avatar{ object-fit:cover; }
`;
