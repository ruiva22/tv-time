import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Tv, Clapperboard, Search, User, Bell, MoreHorizontal, ChevronRight, ChevronDown,
  Star, Plus, Minus, Check, X, Clock, ListPlus, Trash2, Film, ArrowLeft, Rss,
} from "lucide-react";
import { db, configured, signIn, logOut, watchAuth } from "./firebase";
import {
  doc, onSnapshot, setDoc, collection, addDoc, query, orderBy, limit, where, getCountFromServer,
  getDoc, getDocs, deleteDoc,
} from "firebase/firestore";

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
const catalogById = Object.fromEntries(CATALOG.map((t) => [t.id, t]));

/* Resolve a title id to its display fields. Seed catalog first, then the
   snapshot stored alongside the tracking entry (for titles added via search). */
function resolveTitle(id, data) {
  return catalogById[id] || data?.titles?.[id] || null;
}

/* deterministic poster gradient from title */
function gradient(str) {
  let h = 0;
  for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  const h2 = (h + 48) % 360;
  return `linear-gradient(150deg, hsl(${h} 42% 26%), hsl(${h2} 38% 14%))`;
}

/* Poster: real TMDB image when we have one, deterministic gradient otherwise.
   className extends .cs-poster (e.g. "sm"); children render on top (badges). */
function Poster({ title, poster, className = "", children }) {
  return (
    <div className={"cs-poster " + className} style={{ background: gradient(title) }}>
      {poster && <img className="cs-posterimg" src={poster} alt="" loading="lazy" />}
      <span>{title}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Persistence                                                        */
/* ------------------------------------------------------------------ */
const KEY = "cs_tracker_v1";
const defaultData = {
  tracking: {},            // id -> { status, rating, progress, addedAt, watchedAt, eps }
                            //   eps: { "season-episode" -> true } per-episode watched marks
                            //   (only populated for titles with a real TMDB id; progress is
                            //   kept in sync as eps.length so old UI reading it still works)
  titles: {},              // id -> { id, title, type, year, genre, poster, seasons, episodes, runtime, seasonList }  (snapshots for searched titles)
  lists: [],               // { id, name, itemIds: [] }
  notifications: [],       // { id, type: "follower"|"newSeason"|"upcoming", text, sub, ts, read, ...target }
  seenFollowers: {},        // uid -> true, so a follower is only ever notified once
  seenUpcoming: {},         // "titleId-airDate" -> true, so an air date is only ever notified once
};

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const [tab, setTab] = useState("shows");
  const [data, setData] = useState(defaultData);
  const [ready, setReady] = useState(false);
  const [openId, setOpenId] = useState(null);       // detail sheet
  const [showEpisodes, setShowEpisodes] = useState(false); // episode picker over the detail sheet
  const [toast, setToast] = useState(null);         // { text, kind }
  const [listPick, setListPick] = useState(null);   // id being added to a list
  const [user, setUser] = useState(null);           // signed-in Google user
  const [authReady, setAuthReady] = useState(false);
  const [viewUser, setViewUser] = useState(null);   // { uid, name, photo } — someone else's profile, opened from Feed/follow lists
  const [followList, setFollowList] = useState(null); // { uid, mode: "following" | "followers" }
  const [showNotifications, setShowNotifications] = useState(false);
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

  // Keep a small public directory entry (name + photo) up to date for this
  // user, so anyone who follows them — or sees them in the feed — can
  // resolve their uid to a display name even before they've posted any
  // activity themselves.
  useEffect(() => {
    if (!configured || !user) return;
    setDoc(doc(db, "users", user.uid), {
      uid: user.uid,
      name: user.displayName || user.email || "Someone",
      photo: user.photoURL || null,
      updatedAt: Date.now(),
    }, { merge: true }).catch(() => {});
  }, [user]);

  // Tap a name/avatar anywhere (feed, follow lists): jump to your own
  // Profile tab for yourself, otherwise open their public profile overlay.
  const openUserProfile = (u) => {
    if (u.uid === user.uid) { setViewUser(null); setTab("profile"); }
    else setViewUser(u);
  };

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

  // Prepend one notification (newest first), capped so the stored doc
  // doesn't grow forever.
  const pushNotification = (n) =>
    setData((d) => ({
      ...d,
      notifications: [{ id: n.id, read: false, ts: Date.now(), ...n }, ...d.notifications].slice(0, 30),
    }));

  // New-season detection + upcoming-episode reminders: once per session,
  // right after the library loads, re-check every tracked show with a real
  // TMDB id (watched or watching) against TMDB's next_episode_to_air.
  // - Watched shows whose next season is beyond what we knew about move
  //   back to Watching (past progress untouched) and get called out.
  // - Any show with an episode airing today/tomorrow gets a one-time
  //   reminder (deduped by title+air date, so it never repeats).
  useEffect(() => {
    if (!ready || !user) return;
    let cancelled = false;
    (async () => {
      const candidateIds = Object.entries(data.tracking)
        .filter(([id, e]) => (e.status === "watched" || e.status === "watching") && /^\d+$/.test(String(id)))
        .map(([id]) => id);
      const in2Days = new Date(); in2Days.setDate(in2Days.getDate() + 2);
      const in2DaysISO = in2Days.toISOString().slice(0, 10);
      const todayISO = new Date().toISOString().slice(0, 10);

      for (const id of candidateIds) {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/title/show/${id}`);
          if (!res.ok) continue;
          const full = await res.json();
          const next = full.nextEpisodeToAir;
          const wasWatched = data.tracking[id]?.status === "watched";
          const knownSeasons = resolveTitle(id, data)?.seasons || 0;

          if (wasWatched && next && next.season > knownSeasons) {
            setData((d) => {
              const cur = d.tracking[id];
              if (!cur || cur.status !== "watched") return d; // already moved elsewhere
              return {
                ...d,
                tracking: { ...d.tracking, [id]: { ...cur, status: "watching", newSeason: true } },
                titles: { ...d.titles, [id]: { ...resolveTitle(id, d), ...full } },
              };
            });
            notify(`${full.title} is back — Season ${next.season} just started. Moved to Watching.`);
            pushNotification({
              id: `newSeason-${id}-${next.season}`, type: "newSeason", titleId: id,
              text: `${full.title} is back`, sub: `Season ${next.season} just started`,
            });
          } else if (next) {
            // No season bump, but keep nextEpisodeToAir fresh so the
            // "Next episode" line stays accurate.
            setData((d) => ({ ...d, titles: { ...d.titles, [id]: { ...resolveTitle(id, d), ...full } } }));
          }

          if (next?.airDate && next.airDate >= todayISO && next.airDate <= in2DaysISO) {
            const seenKey = `${id}-${next.airDate}`;
            if (!data.seenUpcoming[seenKey]) {
              setData((d) => ({ ...d, seenUpcoming: { ...d.seenUpcoming, [seenKey]: true } }));
              pushNotification({
                id: `upcoming-${seenKey}`, type: "upcoming", titleId: id,
                text: `${full.title} — new episode ${next.airDate === todayISO ? "today" : "tomorrow"}`,
                sub: `Season ${next.season}, Episode ${next.episode}`,
              });
            }
          }
        } catch { /* skip this show; it's retried next session */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user]);

  // New-follower detection: once per session, compare who follows you now
  // against who you were last notified about.
  useEffect(() => {
    if (!ready || !user || !configured) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, "follows"), where("followeeUid", "==", user.uid)));
        const newFollowerUids = snap.docs
          .map((d) => d.data().followerUid)
          .filter((uid) => uid && !data.seenFollowers[uid]);
        if (!newFollowerUids.length) return;
        for (const uid of newFollowerUids) {
          if (cancelled) return;
          let profile = { uid, name: "Someone", photo: null };
          try {
            const udoc = await getDoc(doc(db, "users", uid));
            if (udoc.exists()) profile = { uid, ...udoc.data() };
          } catch { /* fall back to "Someone" */ }
          pushNotification({
            id: `follower-${uid}`, type: "follower", uid: profile.uid, name: profile.name, photo: profile.photo,
            text: `${profile.name} started following you`,
          });
        }
        setData((d) => {
          const seen = { ...d.seenFollowers };
          newFollowerUids.forEach((uid) => { seen[uid] = true; });
          return { ...d, seenFollowers: seen };
        });
      } catch { /* rules not deployed yet, or offline — retried next session */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user]);

  // Clear the "new season" callout once its show has actually been opened.
  const clearNewSeason = (id) =>
    setData((d) => {
      const cur = d.tracking[id];
      if (!cur?.newSeason) return d;
      const { newSeason, ...rest } = cur;
      return { ...d, tracking: { ...d.tracking, [id]: rest } };
    });

  const markNotificationsRead = () =>
    setData((d) => ({ ...d, notifications: d.notifications.map((n) => ({ ...n, read: true })) }));

  // Tap a notification: mark it read, close the panel, and jump to whatever
  // it's about.
  const openNotification = (n) => {
    setData((d) => ({ ...d, notifications: d.notifications.map((x) => x.id === n.id ? { ...x, read: true } : x) }));
    setShowNotifications(false);
    if (n.type === "follower") openUserProfile({ uid: n.uid, name: n.name, photo: n.photo });
    else if (n.titleId) openTitleId(n.titleId);
  };

  /* --- mutations --- */
  const setEntry = (id, patch) =>
    setData((d) => {
      const prev = d.tracking[id] || {};
      const next = { ...prev, ...patch };
      return { ...d, tracking: { ...d.tracking, [id]: next } };
    });

  // Post one event to the shared, cross-user activity feed. Best-effort:
  // if the `activity` collection's Firestore rules haven't been added yet
  // (see README.md), this just silently no-ops rather than breaking tracking.
  const logActivity = (status, title) => {
    if (!configured || !user || !title) return;
    addDoc(collection(db, "activity"), {
      uid: user.uid,
      name: user.displayName || user.email || "Someone",
      photo: user.photoURL || null,
      titleId: title.id,
      titleName: title.title,
      titleType: title.type,
      poster: title.poster || null,
      action: status, // "want" | "watching" | "watched"
      createdAt: Date.now(),
    }).catch(() => {});
  };

  const track = (id, status) => {
    const exists = data.tracking[id];
    const patch = {
      status,
      addedAt: exists?.addedAt || Date.now(),
      progress: exists?.progress || 0,
      rating: exists?.rating || 0,
    };
    // Only include watchedAt when it actually has a value — Firestore's
    // setDoc rejects an explicit `undefined` field and crashes the app.
    if (status === "watched") patch.watchedAt = Date.now();
    else if (exists?.watchedAt) patch.watchedAt = exists.watchedAt;
    setEntry(id, patch);
    logActivity(status, resolveTitle(id, data));
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
    const patch = {
      rating,
      status,
      addedAt: cur?.addedAt || Date.now(),
    };
    const watchedAt = cur?.watchedAt || (status === "watched" ? Date.now() : undefined);
    if (watchedAt) patch.watchedAt = watchedAt;
    setEntry(id, patch);
  };

  const setProgress = (id, val) => {
    const show = resolveTitle(id, data);
    const total = show?.episodes || 1;
    const p = Math.max(0, Math.min(total, val));
    const cur = data.tracking[id] || {};
    const patch = {
      progress: p,
      status: p >= total ? "watched" : p > 0 ? "watching" : cur.status || "want",
      addedAt: cur.addedAt || Date.now(),
    };
    const watchedAt = p >= total ? Date.now() : cur.watchedAt;
    if (watchedAt) patch.watchedAt = watchedAt;
    setEntry(id, patch);
  };

  // Toggle a single episode's watched mark and keep progress/status in sync.
  const toggleEpisode = (id, season, ep) =>
    setData((d) => {
      const cur = d.tracking[id] || {};
      const eps = { ...(cur.eps || {}) };
      const key = `${season}-${ep}`;
      if (eps[key]) delete eps[key]; else eps[key] = true;
      const patch = applyEpsPatch(d, id, cur, eps);
      return { ...d, tracking: { ...d.tracking, [id]: { ...cur, ...patch } } };
    });

  // Mark (or unmark) every episode of one season at once.
  const setSeasonWatched = (id, season, epNumbers, watched) =>
    setData((d) => {
      const cur = d.tracking[id] || {};
      const eps = { ...(cur.eps || {}) };
      for (const n of epNumbers) {
        const key = `${season}-${n}`;
        if (watched) eps[key] = true; else delete eps[key];
      }
      const patch = applyEpsPatch(d, id, cur, eps);
      return { ...d, tracking: { ...d.tracking, [id]: { ...cur, ...patch } } };
    });

  // Shared bookkeeping for both episode mutators above: recompute progress
  // from how many episodes are marked, and derive status/watchedAt from that.
  function applyEpsPatch(d, id, cur, eps) {
    const title = resolveTitle(id, d);
    const total = title?.episodes || 1;
    const count = Object.keys(eps).length;
    const patch = {
      eps,
      progress: count,
      status: count >= total ? "watched" : count > 0 ? "watching" : cur.status || "want",
      addedAt: cur.addedAt || Date.now(),
    };
    const watchedAt = count >= total ? Date.now() : cur.watchedAt;
    if (watchedAt) patch.watchedAt = watchedAt;
    return patch;
  }

  // Fetch (or refresh) a title's full TMDB detail — genre, counts, seasonList
  // — and snapshot it. Used both when adding a searched title and to backfill
  // seasonList on titles saved before that field existed.
  const refreshTitleDetail = async (t) => {
    try {
      const res = await fetch(`/api/title/${t.type}/${t.id}`);
      if (res.ok) {
        const full = await res.json();
        setData((d) => ({ ...d, titles: { ...d.titles, [full.id]: { ...t, ...full } } }));
      }
    } catch { /* keep whatever snapshot we already have */ }
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

  // Store a title's display snapshot so it renders everywhere without a
  // live lookup. Called when opening/adding a searched (TMDB) title.
  const saveTitleSnapshot = (t) =>
    setData((d) => (d.titles[t.id] ? d : { ...d, titles: { ...d.titles, [t.id]: t } }));

  // Tap a search result: fetch full detail (genre + counts), snapshot it,
  // then open the detail sheet.
  const openSearchResult = async (card) => {
    // Snapshot the light card immediately so the sheet can render at once.
    saveTitleSnapshot(card);
    setOpenId(card.id);
    refreshTitleDetail(card);
  };

  // Open an already-tracked title by id, dismissing its "new season" callout
  // (if any) now that it's actually been looked at.
  const openTitleId = (id) => { clearNewSeason(id); setOpenId(id); };

  if (!configured) return <Gate><Setup /></Gate>;
  if (!authReady) return <div className="cs-root cs-boot"><style>{CSS}</style>Loading…</div>;
  if (!user) return <Gate><SignIn onSignIn={() => signIn().catch(() => notify("Sign-in failed — try again", "err"))} /></Gate>;
  if (!ready) return <div className="cs-root cs-boot"><style>{CSS}</style>Loading your library…</div>;

  const openTitle = openId ? resolveTitle(openId, data) : null;
  const unreadCount = data.notifications.filter((n) => !n.read).length;

  return (
    <div className="cs-root">
      <style>{CSS}</style>

      <div className="cs-screen">
        {tab === "shows" && (
          <Library type="show" data={data} onOpen={openTitleId} goExplore={() => setTab("explore")}
            unread={unreadCount} onBell={() => setShowNotifications(true)} />
        )}
        {tab === "movies" && (
          <Library type="movie" data={data} onOpen={openTitleId} goExplore={() => setTab("explore")}
            unread={unreadCount} onBell={() => setShowNotifications(true)} />
        )}
        {tab === "feed" && (
          <Feed onOpenUser={openUserProfile} unread={unreadCount} onBell={() => setShowNotifications(true)} />
        )}
        {tab === "explore" && (
          <Explore data={data} onOpen={setOpenId} onOpenSearch={openSearchResult}
            unread={unreadCount} onBell={() => setShowNotifications(true)} />
        )}
        {tab === "profile" && (
          <Profile data={data} user={user} onOpen={openTitleId} onOpenSearch={openSearchResult}
            onCreateList={createList} onDeleteList={deleteList} notify={notify}
            onOpenFollowList={(mode) => setFollowList({ uid: user.uid, mode })}
            unread={unreadCount} onBell={() => setShowNotifications(true)}
            onSignOut={() => { logOut(); notify("Signed out"); }} />
        )}
      </div>

      {showNotifications && (
        <NotificationsPanel
          items={data.notifications}
          onClose={() => setShowNotifications(false)}
          onMarkAllRead={markNotificationsRead}
          onOpen={openNotification}
        />
      )}

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
          ["feed", Rss, "Feed"],
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
          onClose={() => { setOpenId(null); setShowEpisodes(false); }}
          onTrack={(s) => track(openTitle.id, s)}
          onUntrack={() => { untrack(openTitle.id); setOpenId(null); notify("Removed from your library"); }}
          onRate={(r) => rate(openTitle.id, r)}
          onProgress={(v) => setProgress(openTitle.id, v)}
          onOpenListPick={() => setListPick(openTitle.id)}
          onOpenEpisodes={() => setShowEpisodes(true)}
          onRefreshTitle={refreshTitleDetail}
        />
      )}

      {showEpisodes && openTitle && (
        <Episodes
          title={openTitle} entry={data.tracking[openTitle.id]}
          onClose={() => setShowEpisodes(false)}
          onToggle={(season, ep) => toggleEpisode(openTitle.id, season, ep)}
          onToggleSeason={(season, nums, watched) => setSeasonWatched(openTitle.id, season, nums, watched)}
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

      {viewUser && (
        <UserProfile
          uid={viewUser.uid} name={viewUser.name} photo={viewUser.photo} myUid={user.uid}
          onClose={() => setViewUser(null)}
          onOpenFollowList={(uid, mode) => setFollowList({ uid, mode })}
          onOpenUser={openUserProfile}
        />
      )}

      {followList && (
        <FollowList
          uid={followList.uid} mode={followList.mode} myUid={user.uid}
          onClose={() => setFollowList(null)}
          onOpenUser={(u) => { setFollowList(null); openUserProfile(u); }}
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

function Library({ type, data, onOpen, goExplore, unread, onBell }) {
  const filters = type === "show" ? SHOW_FILTERS : MOVIE_FILTERS;
  const [f, setF] = useState(filters[0][0]);

  const items = useMemo(() => {
    return Object.entries(data.tracking)
      .filter(([id, e]) => resolveTitle(id, data)?.type === type && e.status === f)
      .map(([id, e]) => ({ ...resolveTitle(id, data), ...e }))
      .sort((a, b) => (b.watchedAt || b.addedAt || 0) - (a.watchedAt || a.addedAt || 0));
  }, [data, type, f]);

  return (
    <>
      <Header title={type === "show" ? "Shows" : "Movies"} unread={unread} onBell={onBell} />
      <div className="cs-tabs">
        {filters.map(([id, label]) => {
          const n = Object.entries(data.tracking).filter(([tid, e]) => resolveTitle(tid, data)?.type === type && e.status === id).length;
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
  const nextAir = item.nextEpisodeToAir?.airDate;
  return (
    <button className="cs-row" onClick={onOpen}>
      <Poster title={item.title} poster={item.poster} className="sm">
        {item.newSeason && <div className="cs-newseasonpill">New</div>}
      </Poster>
      <div className="cs-rowmeta">
        <div className="cs-rowtitle">{item.title}</div>
        <div className="cs-rowsub">{item.genre} · {item.year}</div>
        {item.type === "show" && item.status !== "want" && (
          <div className="cs-prog">
            <div className="cs-progbar"><i style={{ width: pct + "%" }} /></div>
            <span>{item.progress || 0}/{total}</span>
          </div>
        )}
        {nextAir && <div className="cs-nextep">▸ Next episode {formatShortDate(nextAir)}</div>}
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
function Explore({ data, onOpen, onOpenSearch, unread, onBell }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const debounce = useRef(null);
  const seq = useRef(0);

  // Discover feed — an endless, shuffled wall of popular titles shown while
  // the search box is empty. Starts at a random "page" each time Explore
  // mounts (tab switch or reload), so it looks different every visit, and
  // grows forward from there as the user scrolls.
  const [feed, setFeed] = useState([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const pageRef = useRef(Math.floor(Math.random() * 450) + 1);
  const loadingRef = useRef(false);
  const bodyRef = useRef(null); // .cs-body — used to reach its scrolling ancestor (.cs-screen)

  const loadMoreFeed = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setFeedLoading(true);
    try {
      const res = await fetch(`/api/discover?page=${pageRef.current}`);
      const json = await res.json();
      pageRef.current += 1;
      setFeed((f) => [...f, ...(json.results || [])]);
    } catch { /* this batch silently drops; scrolling further down retries */ }
    finally { loadingRef.current = false; setFeedLoading(false); }
  };

  // First batch, once.
  useEffect(() => { loadMoreFeed(); }, []);

  // Infinite scroll: load the next batch once the user nears the bottom of
  // the (internally-scrolling) screen. Re-armed whenever the feed — vs.
  // search results — is what's showing, since .cs-body gets replaced around
  // a search. Explore renders as a Fragment, so .cs-body's own parent is the
  // actual scrolling element (.cs-screen, owned by the parent App).
  useEffect(() => {
    if (status !== "idle") return;
    const scrollEl = bodyRef.current?.parentElement;
    if (!scrollEl) return;
    const onScroll = () => {
      const distanceToBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      if (distanceToBottom < 800) loadMoreFeed();
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // covers the case where the first batch doesn't even fill the screen
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [status]);

  // Debounced live search against the backend TMDB proxy.
  useEffect(() => {
    const query = q.trim();
    clearTimeout(debounce.current);
    if (!query) { setResults([]); setStatus("idle"); return; }
    setStatus("loading");
    debounce.current = setTimeout(async () => {
      const mine = ++seq.current;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (mine !== seq.current) return; // a newer query superseded this one
        setResults(json.results || []);
        setStatus("done");
      } catch {
        if (mine !== seq.current) return;
        setStatus("error");
      }
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [q]);

  return (
    <>
      <Header title="Explore" unread={unread} onBell={onBell} />
      <div className="cs-searchwrap">
        <Search size={18} className="cs-dim" />
        <input className="cs-search" placeholder="Search any show or movie"
          value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {q && <button className="cs-clear" onClick={() => setQ("")}><X size={16} /></button>}
      </div>

      <div className="cs-body" ref={bodyRef}>
        {status === "loading" && <div className="cs-searchnote">Searching…</div>}
        {status === "error" && <div className="cs-searchnote">Search failed — check your connection.</div>}

        {status === "done" && results.length > 0 && (
          <div className="cs-grid">
            {results.map((t) => (
              <TitleCard key={t.type + t.id} t={t} tracked={data.tracking[t.id]} onOpen={onOpenSearch} />
            ))}
          </div>
        )}

        {status === "done" && results.length === 0 && (
          <Empty icon={<Search size={26} />} head="No matches" sub="Try a different title." />
        )}

        {status === "idle" && (
          <>
            {feed.length === 0 && feedLoading ? (
              <div className="cs-searchnote">Loading…</div>
            ) : (
              <div className="cs-grid">
                {feed.map((t, i) => (
                  <TitleCard key={t.type + t.id + "-" + i} t={t} tracked={data.tracking[t.id]} onOpen={onOpenSearch} />
                ))}
              </div>
            )}
            {feedLoading && feed.length > 0 && (
              <div className="cs-feedsentinel"><span>Loading more…</span></div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function TitleCard({ t, tracked, onOpen }) {
  return (
    <button className="cs-gcard" onClick={() => onOpen(t)}>
      <Poster title={t.title} poster={t.poster}>
        {tracked && <div className="cs-badge">{tracked.status === "watched" ? "✓" : tracked.status === "watching" ? "▸" : "+"}</div>}
      </Poster>
      <div className="cs-gtitle">{t.title}</div>
      <div className="cs-gsub">{t.type === "show" ? "TV" : "Film"}{t.year ? " · " + t.year : ""}</div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Feed — live cross-user activity: everyone's status changes         */
/* ------------------------------------------------------------------ */
const ACTION_VERB = { watched: "finished", watching: "started watching", want: "added to their watchlist" };

function Feed({ onOpenUser, unread, onBell }) {
  const [items, setItems] = useState([]);
  const [ready, setReady] = useState(false);
  const [errored, setErrored] = useState(false);

  // Shared collection, not per-user — every signed-in user's Watching/
  // Watchlist/Watched taps land here, and everyone subscribes to the same
  // live query, newest first.
  useEffect(() => {
    if (!configured) { setReady(true); return; }
    const q = query(collection(db, "activity"), orderBy("createdAt", "desc"), limit(50));
    const unsub = onSnapshot(
      q,
      (snap) => { setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); setReady(true); setErrored(false); },
      () => { setErrored(true); setReady(true); }
    );
    return unsub;
  }, []);

  return (
    <>
      <Header title="Feed" unread={unread} onBell={onBell} />
      <div className="cs-body">
        {!ready && <div className="cs-searchnote">Loading…</div>}
        {ready && errored && (
          <Empty icon={<Rss size={26} />} head="Feed unavailable"
            sub="The activity collection needs its own Firestore rules — see README.md." />
        )}
        {ready && !errored && items.length === 0 && (
          <Empty icon={<Rss size={26} />} head="No activity yet"
            sub="Once people track shows and movies, updates show up here in real time." />
        )}
        {ready && !errored && items.length > 0 && (
          <div className="cs-feedlist">
            {items.map((it) => <FeedRow key={it.id} item={it} onOpenUser={onOpenUser} />)}
          </div>
        )}
      </div>
    </>
  );
}

function FeedRow({ item, onOpenUser }) {
  const verb = ACTION_VERB[item.action] || "updated";
  const who = () => onOpenUser?.({ uid: item.uid, name: item.name, photo: item.photo });
  return (
    <div className="cs-feedrow">
      <button className="cs-feedavatarbtn" onClick={who} disabled={!onOpenUser}>
        {item.photo
          ? <img className="cs-favatar" src={item.photo} alt="" referrerPolicy="no-referrer" />
          : <div className="cs-favatar">{(item.name || "?").slice(0, 1).toUpperCase()}</div>}
      </button>
      <div className="cs-feedmeta">
        <div className="cs-feedtext">
          <button className="cs-feednamebtn" onClick={who} disabled={!onOpenUser}>{item.name}</button>
          {" "}{verb}{" "}<b>{item.titleName}</b>
        </div>
        <div className="cs-feedtime">{timeAgo(item.createdAt)}</div>
      </div>
      <Poster title={item.titleName} poster={item.poster} className="sm" />
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

// "2026-03-12" -> "Mar 12" — used for upcoming/next-episode air dates.
function formatShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ */
/*  Public profile — someone else's, opened from Feed or a follow list */
/* ------------------------------------------------------------------ */
function UserProfile({ uid, name, photo, myUid, onClose, onOpenFollowList, onOpenUser }) {
  const isSelf = uid === myUid;
  const [counts, setCounts] = useState({ following: null, followers: null });
  const [following, setFollowing] = useState(null); // null = unknown yet, else boolean
  const [activity, setActivity] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const followsCol = collection(db, "follows");
        const [followingSnap, followersSnap, meFollowsDoc, activitySnap] = await Promise.all([
          getCountFromServer(query(followsCol, where("followerUid", "==", uid))),
          getCountFromServer(query(followsCol, where("followeeUid", "==", uid))),
          isSelf ? Promise.resolve(null) : getDoc(doc(db, "follows", `${myUid}_${uid}`)),
          getDocs(query(collection(db, "activity"), where("uid", "==", uid), orderBy("createdAt", "desc"), limit(20))),
        ]);
        if (cancelled) return;
        setCounts({ following: followingSnap.data().count, followers: followersSnap.data().count });
        if (!isSelf) setFollowing(meFollowsDoc.exists());
        setActivity(activitySnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      } catch { /* leave dashes / empty on failure */ }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [uid]);

  const toggleFollow = async () => {
    const ref = doc(db, "follows", `${myUid}_${uid}`);
    try {
      if (following) {
        await deleteDoc(ref);
        setFollowing(false);
        setCounts((c) => ({ ...c, followers: Math.max(0, (c.followers || 1) - 1) }));
      } else {
        await setDoc(ref, { followerUid: myUid, followeeUid: uid, createdAt: Date.now() });
        setFollowing(true);
        setCounts((c) => ({ ...c, followers: (c.followers || 0) + 1 }));
      }
    } catch { /* rules not deployed yet, or offline — button just stays as-is */ }
  };

  return (
    <div className="cs-modal" onClick={onClose}>
      <div className="cs-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cs-grab" />
        <button className="cs-close" onClick={onClose}><X size={20} /></button>

        <div className="cs-pid" style={{ padding: "6px 0 18px" }}>
          {photo
            ? <img className="cs-avatar" src={photo} alt="" referrerPolicy="no-referrer" />
            : <div className="cs-avatar">{(name || "?").slice(0, 1).toUpperCase()}</div>}
          <div className="cs-uname">{name || "Someone"}</div>
        </div>

        <div className="cs-social">
          <button className="cs-socell div" onClick={() => onOpenFollowList(uid, "following")}>
            <b>{counts.following ?? "—"}</b><span>following</span>
          </button>
          <button className="cs-socell" onClick={() => onOpenFollowList(uid, "followers")}>
            <b>{counts.followers ?? "—"}</b><span>followers</span>
          </button>
        </div>

        {!isSelf && (
          <button className={"cs-pill full" + (following ? " active" : "")} style={{ marginTop: 18 }}
            onClick={toggleFollow} disabled={following === null}>
            {following ? "Following" : "Follow"}
          </button>
        )}

        <div style={{ marginTop: 26 }}>
          <div className="cs-blabel">Recent activity</div>
          {!ready && <div className="cs-searchnote">Loading…</div>}
          {ready && activity.length === 0 && (
            <div className="cs-rowsub" style={{ padding: "8px 2px" }}>No activity yet.</div>
          )}
          {ready && activity.length > 0 && (
            <div className="cs-feedlist">
              {activity.map((it) => <FeedRow key={it.id} item={it} onOpenUser={onOpenUser} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Follow / follower list                                             */
/* ------------------------------------------------------------------ */
function FollowList({ uid, mode, myUid, onClose, onOpenUser }) {
  const [people, setPeople] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const field = mode === "following" ? "followerUid" : "followeeUid";
        const otherField = mode === "following" ? "followeeUid" : "followerUid";
        const snap = await getDocs(query(collection(db, "follows"), where(field, "==", uid)));
        const otherUids = snap.docs.map((d) => d.data()[otherField]);
        const profiles = await Promise.all(otherUids.map(async (ouid) => {
          try {
            const udoc = await getDoc(doc(db, "users", ouid));
            return udoc.exists() ? { uid: ouid, ...udoc.data() } : { uid: ouid, name: "Someone" };
          } catch { return { uid: ouid, name: "Someone" }; }
        }));
        if (!cancelled) setPeople(profiles);
      } catch { if (!cancelled) setPeople([]); }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [uid, mode]);

  const head = mode === "following" ? "Following" : "Followers";
  const emptyHead = mode === "following" ? "Not following anyone yet" : "No followers yet";
  const emptySub = mode === "following" ? "People followed show up here." : "People who follow show up here.";

  return (
    <div className="cs-modal" onClick={onClose}>
      <div className="cs-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cs-grab" />
        <button className="cs-close" onClick={onClose}><X size={20} /></button>
        <div className="cs-dtitle sm">{head}</div>

        {!ready && <div className="cs-searchnote">Loading…</div>}
        {ready && people.length === 0 && (
          <Empty icon={<User size={26} />} head={emptyHead} sub={emptySub} />
        )}
        {ready && people.length > 0 && (
          <div className="cs-followlist">
            {people.map((p) => (
              <button key={p.uid} className="cs-followrow" onClick={() => onOpenUser(p)}>
                {p.photo
                  ? <img className="cs-favatar" src={p.photo} alt="" referrerPolicy="no-referrer" />
                  : <div className="cs-favatar">{(p.name || "?").slice(0, 1).toUpperCase()}</div>}
                <span className="cs-followname">{p.name || "Someone"}</span>
                <ChevronRight size={18} className="cs-dim" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Notifications — new followers, new seasons, upcoming episodes      */
/* ------------------------------------------------------------------ */
const NOTIF_ICON = { follower: User, newSeason: Tv, upcoming: Clock };

function NotificationsPanel({ items, onClose, onMarkAllRead, onOpen }) {
  const hasUnread = items.some((n) => !n.read);
  return (
    <div className="cs-modal" onClick={onClose}>
      <div className="cs-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cs-grab" />
        <button className="cs-close" onClick={onClose}><X size={20} /></button>
        <div className="cs-notifhead">
          <div className="cs-dtitle sm">Notifications</div>
          {hasUnread && <button className="cs-notifclear" onClick={onMarkAllRead}>Mark all read</button>}
        </div>

        {items.length === 0 && (
          <Empty icon={<Bell size={26} />} head="Nothing yet"
            sub="New followers, new seasons, and upcoming episodes will show up here." />
        )}

        {items.length > 0 && (
          <div className="cs-notiflist">
            {items.map((n) => {
              const Icon = NOTIF_ICON[n.type] || Bell;
              return (
                <button key={n.id} className={"cs-notifrow" + (n.read ? "" : " unread")} onClick={() => onOpen(n)}>
                  <div className="cs-notificon"><Icon size={17} /></div>
                  <div className="cs-notifmeta">
                    <div className="cs-notiftext">{n.text}</div>
                    {n.sub && <div className="cs-notifsub">{n.sub}</div>}
                    <div className="cs-notiftime">{timeAgo(n.ts)}</div>
                  </div>
                  {!n.read && <div className="cs-notifdot" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shelf — horizontal scroll row of posters (Profile's taste sections) */
/* ------------------------------------------------------------------ */
function Shelf({ label, note, sub, items, onOpen, rated }) {
  if (!items.length) return null;
  return (
    <section className="cs-sec">
      <div className="cs-sechead"><h3>{label}</h3>{note && <span className="cs-shelfnote">{note}</span>}</div>
      {sub && <div className="cs-shelfsubline">{sub}</div>}
      <div className="cs-shelf">
        {items.map((it) => (
          <button key={it.type + it.id} className="cs-shelfcard" onClick={() => onOpen(it)}>
            <Poster title={it.title} poster={it.poster} className="shelf">
              {rated && <div className="cs-ratebadge">★ 5</div>}
            </Poster>
            <div className="cs-shelftitle">{it.title}</div>
            <div className="cs-shelfsub">{it.year || (it.type === "show" ? "TV" : "Film")}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile  (closely mirrors the reference screen)                    */
/* ------------------------------------------------------------------ */
function Profile({ data, user, onOpen, onOpenSearch, onCreateList, onDeleteList, notify, onOpenFollowList, unread, onBell, onSignOut }) {
  const [showNew, setShowNew] = useState(false);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState("");

  const stats = useMemo(() => {
    const entries = Object.entries(data.tracking).map(([id, e]) => ({ ...resolveTitle(id, data), ...e }));
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

  // Taste summary: top-rated titles, recently watched, and a genre
  // breakdown — all derived from data already stored per tracked title, no
  // extra reads needed.
  const insights = useMemo(() => {
    const entries = Object.entries(data.tracking).map(([id, e]) => ({ ...resolveTitle(id, data), ...e }));
    const watched = entries.filter((e) => e.status === "watched");
    const topShows = entries.filter((e) => e.type === "show" && e.rating === 5)
      .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
    const topMovies = entries.filter((e) => e.type === "movie" && e.rating === 5)
      .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
    const recent = watched.filter((e) => e.watchedAt).sort((a, b) => b.watchedAt - a.watchedAt).slice(0, 5);
    const genreCounts = {};
    watched.forEach((e) => { if (e.genre) genreCounts[e.genre] = (genreCounts[e.genre] || 0) + 1; });
    const genres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([genre, count]) => ({ genre, count }));
    return { topShows, topMovies, recent, genres, topGenre: genres[0]?.genre || null };
  }, [data]);

  // Recommendations: popular titles in your #1 genre, fetched fresh from
  // TMDB and filtered down to ones you haven't already tracked. Silently
  // empty (section just doesn't render) if the genre has no TMDB mapping,
  // TMDB isn't configured, or the request fails.
  const [recs, setRecs] = useState([]);
  useEffect(() => {
    if (!insights.topGenre) { setRecs([]); return; }
    let cancelled = false;
    const page = Math.floor(Math.random() * 450) + 1;
    fetch(`/api/discover?genre=${encodeURIComponent(insights.topGenre)}&page=${page}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setRecs((json.results || []).filter((t) => !data.tracking[t.id]).slice(0, 12));
      })
      .catch(() => { if (!cancelled) setRecs([]); });
    return () => { cancelled = true; };
  }, [insights.topGenre]);

  // Real numbers, in place of the old hardcoded placeholders: how many of
  // your own status changes are in the shared feed, plus real follow counts
  // from the follows collection. Cheap server-side counts, not full document
  // reads. Left as "—" if a query fails (e.g. rules not deployed yet).
  const [community, setCommunity] = useState({ yours: null, following: null, followers: null });
  useEffect(() => {
    if (!configured || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const activityCol = collection(db, "activity");
        const followsCol = collection(db, "follows");
        const [yoursSnap, followingSnap, followersSnap] = await Promise.all([
          getCountFromServer(query(activityCol, where("uid", "==", user.uid))),
          getCountFromServer(query(followsCol, where("followerUid", "==", user.uid))),
          getCountFromServer(query(followsCol, where("followeeUid", "==", user.uid))),
        ]);
        if (cancelled) return;
        setCommunity({ yours: yoursSnap.data().count, following: followingSnap.data().count, followers: followersSnap.data().count });
      } catch { /* leave as dashes */ }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return (
    <div className="cs-profile">
      <div className="cs-phead">
        <button className="cs-bell" onClick={onBell}>
          <Bell size={20} fill="#000" color="#000" />
          {unread > 0 && <span className="cs-bellbadge">{unread > 9 ? "9+" : unread}</span>}
        </button>
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
        <div className="cs-socell div"><b>{community.yours ?? "—"}</b><span>yours</span></div>
        <button className="cs-socell div" onClick={() => onOpenFollowList("following")}>
          <b>{community.following ?? "—"}</b><span>following</span>
        </button>
        <button className="cs-socell" onClick={() => onOpenFollowList("followers")}>
          <b>{community.followers ?? "—"}</b><span>followers</span>
        </button>
      </div>

      <Shelf label="Top rated shows" note="5 ★ only" items={insights.topShows} onOpen={(it) => onOpen(it.id)} rated />
      <Shelf label="Top rated movies" note="5 ★ only" items={insights.topMovies} onOpen={(it) => onOpen(it.id)} rated />
      <Shelf label="Recently watched" note="last 5" items={insights.recent} onOpen={(it) => onOpen(it.id)} />

      {insights.genres.length > 0 && (
        <section className="cs-sec">
          <div className="cs-sechead"><h3>Your genres</h3><span className="cs-shelfnote">by titles watched</span></div>
          <div className="cs-genrelist">
            {insights.genres.map((g) => (
              <div key={g.genre} className="cs-genrerow">
                <span className="cs-genrename">{g.genre}</span>
                <div className="cs-genrebar"><i style={{ width: (g.count / insights.genres[0].count) * 100 + "%" }} /></div>
                <span className="cs-genren">{g.count}</span>
              </div>
            ))}
          </div>
          <div className="cs-genrecallout">
            Your favorite genre is <b>{insights.topGenre}</b>.
          </div>
        </section>
      )}

      <Shelf label="Recommended for you" sub={insights.topGenre ? `Because you watch a lot of ${insights.topGenre}` : ""}
        items={recs} onOpen={onOpenSearch} />

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
                    <span key={id} style={{ background: gradient(resolveTitle(id, data)?.title || id) }} />
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
function Detail({ title, entry, lists, onClose, onTrack, onUntrack, onRate, onProgress, onOpenListPick, onOpenEpisodes, onRefreshTitle }) {
  // Prefer the season-list sum (excludes specials) so this matches the
  // episode picker's total exactly; fall back to the flat episode count.
  const total = title.seasonList?.length
    ? title.seasonList.reduce((a, s) => a + (s.episodeCount || 0), 0) || title.episodes || 1
    : title.episodes || 1;
  const inList = lists.some((l) => l.itemIds.includes(title.id));
  // Only titles added via search carry a real numeric TMDB id — that's what
  // lets us fetch a per-episode list. Seed/demo titles fall back to the
  // plain +/- stepper below.
  const hasTmdbId = title.type === "show" && /^\d+$/.test(String(title.id));

  // Snapshots saved before seasonList existed won't have it yet — backfill
  // once so the episode picker knows how episodes split across seasons.
  useEffect(() => {
    if (hasTmdbId && !title.seasonList) onRefreshTitle(title);
  }, [hasTmdbId, title.id, title.seasonList]);
  return (
    <div className="cs-modal" onClick={onClose}>
      <div className="cs-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cs-grab" />
        <button className="cs-close" onClick={onClose}><X size={20} /></button>

        <div className="cs-dhero" style={{ background: gradient(title.title) }}>
          {title.poster && <img className="cs-posterimg" src={title.poster} alt="" />}
          <span>{title.title}</span>
        </div>

        <div className="cs-dtitle">{title.title}</div>
        <div className="cs-dmeta">
          {title.type === "show" ? "TV Series" : "Film"}
          {title.genre ? ` · ${title.genre}` : ""}
          {title.year ? ` · ${title.year}` : ""}
          {title.type === "show"
            ? (title.episodes ? ` · ${title.seasons || 1} ${title.seasons === 1 ? "season" : "seasons"}, ${title.episodes} eps` : "")
            : (title.runtime ? ` · ${title.runtime} min` : "")}
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

        {/* episode picker — the second most important action after status,
            so it gets primary-card weight right under the status row rather
            than a quiet text link buried further down */}
        {title.type === "show" && hasTmdbId && (
          <button className="cs-epcta" onClick={onOpenEpisodes}>
            <div className="cs-epcta-badge"><Tv size={22} /></div>
            <div className="cs-epcta-body">
              <div className="cs-epcta-count">{entry?.progress || 0} of {total} episodes watched</div>
              <div className="cs-progbar big"><i style={{ width: ((entry?.progress || 0) / total) * 100 + "%" }} /></div>
              <div className="cs-epcta-sub">Tap to pick which episodes</div>
            </div>
            <ChevronRight size={20} className="cs-epcta-chev" />
          </button>
        )}

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

        {title.type === "show" && !hasTmdbId && (
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
/*  Episode picker — per-episode watched marks with image/desc/rating */
/* ------------------------------------------------------------------ */
function Episodes({ title, entry, onClose, onToggle, onToggleSeason }) {
  const seasons = title.seasonList?.length
    ? title.seasonList
    : [{ number: 1, name: "Season 1", episodeCount: title.episodes || 0 }];
  const [season, setSeason] = useState(seasons[0]?.number || 1);
  const [eps, setEps] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | done | error

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetch(`/api/title/show/${title.id}/season/${season}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.episodes) { setEps(json.episodes); setStatus("done"); }
        else setStatus("error");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [title.id, season]);

  const watched = entry?.eps || {};
  const watchedCount = Object.keys(watched).length;
  const total = seasons.reduce((a, s) => a + (s.episodeCount || 0), 0) || title.episodes || 1;

  // Split out episodes that haven't aired yet (or have no date at all —
  // TMDB often lists a placeholder episode before a date is announced).
  // Only released episodes count toward "mark season watched" / progress —
  // there's nothing to mark on one that hasn't aired.
  const todayISO = new Date().toISOString().slice(0, 10);
  const released = eps.filter((e) => e.airDate && e.airDate <= todayISO);
  const upcoming = eps.filter((e) => !e.airDate || e.airDate > todayISO);
  const seasonNums = released.map((e) => e.number);
  const seasonAllWatched = released.length > 0 && seasonNums.every((n) => watched[`${season}-${n}`]);

  return (
    <div className="cs-modal" onClick={onClose}>
      <div className="cs-sheet tall" onClick={(e) => e.stopPropagation()}>
        <div className="cs-grab" />
        <button className="cs-close" onClick={onClose}><X size={20} /></button>

        <div className="cs-dtitle sm">{title.title}</div>
        <div className="cs-epprogwrap">
          <div className="cs-progbar big"><i style={{ width: (watchedCount / total) * 100 + "%" }} /></div>
          <span className="cs-blabel">{watchedCount} of {total} episodes watched</span>
        </div>

        <div className="cs-seasonrow">
          {seasons.length > 1 ? (
            <div className="cs-seasonselect">
              <select value={season} onChange={(e) => setSeason(Number(e.target.value))}>
                {seasons.map((s) => (
                  <option key={s.number} value={s.number}>{s.name || `Season ${s.number}`}</option>
                ))}
              </select>
              <ChevronDown size={16} />
            </div>
          ) : (
            <div className="cs-seasonlabel">{seasons[0]?.name || "Season 1"}</div>
          )}
          {status === "done" && released.length > 0 && (
            <button className="cs-pill sm" onClick={() => onToggleSeason(season, seasonNums, !seasonAllWatched)}>
              {seasonAllWatched ? "Unmark season" : "Mark season watched"}
            </button>
          )}
        </div>

        {status === "loading" && <div className="cs-searchnote">Loading episodes…</div>}
        {status === "error" && <div className="cs-searchnote">Couldn't load episodes — check your connection.</div>}

        {status === "done" && (
          <div className="cs-eplist">
            {released.map((e) => {
              const key = `${season}-${e.number}`;
              const on = !!watched[key];
              return (
                <button key={key} className={"cs-eprow" + (on ? " on" : "")} onClick={() => onToggle(season, e.number)}>
                  <div className="cs-epimg">
                    {e.still ? <img src={e.still} alt="" loading="lazy" /> : <div className="cs-epimg-ph" />}
                  </div>
                  <div className="cs-epmeta">
                    <div className="cs-eptop">
                      <span className="cs-epnum">{e.number}.</span>
                      <span className="cs-epname">{e.name}</span>
                    </div>
                    {e.overview && <p className="cs-epoverview">{e.overview}</p>}
                    <div className="cs-epfoot">
                      {e.rating > 0 && (
                        <span className="cs-eprating"><Star size={12} fill="#FFD426" color="#FFD426" strokeWidth={1.5} /> {e.rating}</span>
                      )}
                      {e.airDate && <span>{e.airDate}</span>}
                    </div>
                  </div>
                  <div className={"cs-check" + (on ? " on" : "")}>{on && <Check size={15} />}</div>
                </button>
              );
            })}

            {upcoming.length > 0 && (
              <>
                <div className="cs-epsechd">Upcoming</div>
                {upcoming.map((e) => (
                  <div key={`${season}-${e.number}`} className="cs-eprow upcoming">
                    <div className="cs-epimg">
                      {e.still ? <img src={e.still} alt="" loading="lazy" /> : <div className="cs-epimg-ph" />}
                    </div>
                    <div className="cs-epmeta">
                      <div className="cs-eptop">
                        <span className="cs-epnum">{e.number}.</span>
                        <span className="cs-epname">{e.name}</span>
                      </div>
                      <div className="cs-epfoot"><span>Not yet aired</span></div>
                    </div>
                    <span className="cs-epairdate">{e.airDate ? formatShortDate(e.airDate) : "TBA"}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
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
const Header = ({ title, unread, onBell }) => (
  <div className="cs-header">
    <button className="cs-bell sm" onClick={onBell}>
      <Bell size={17} fill="#000" color="#000" />
      {unread > 0 && <span className="cs-bellbadge">{unread > 9 ? "9+" : unread}</span>}
    </button>
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
.cs-boot{ align-items:center; justify-content:center; color:var(--mut); font-size:14px; padding-top:env(safe-area-inset-top); }
/* viewport-fit=cover lets the black background run edge-to-edge under the
   notch/Dynamic Island/status bar; env(safe-area-inset-*) (0 on devices
   without one) keeps actual content clear of it. */
.cs-screen{ flex:1; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; padding-top:env(safe-area-inset-top); }
.cs-dim{ color:var(--dim); }

/* header */
.cs-header{ display:flex; align-items:center; gap:14px; padding:18px 20px 8px; }
.cs-header h1{ flex:1; margin:0; font-size:26px; font-weight:700; letter-spacing:-.02em; }
.cs-bell{ width:34px; height:34px; border-radius:50%; background:var(--acc); display:flex; align-items:center; justify-content:center;
  border:none; padding:0; position:relative; flex:0 0 auto; }
button.cs-bell{ cursor:pointer; }
.cs-bell.sm{ width:30px; height:30px; }
.cs-bellbadge{ position:absolute; top:-3px; right:-3px; min-width:16px; height:16px; padding:0 3px; border-radius:99px;
  background:#e24b4a; color:#fff; font-size:9.5px; font-weight:700; display:flex; align-items:center; justify-content:center;
  border:2px solid var(--bg); line-height:1; }

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
.cs-nextep{ font-size:11.5px; color:#FFD426; margin-top:6px; }
.cs-newseasonpill{ position:absolute; top:4px; left:4px; background:var(--acc); color:#3a2e00; font-size:8.5px;
  font-weight:700; letter-spacing:.02em; text-transform:uppercase; padding:2px 5px; border-radius:99px; white-space:nowrap; }
.cs-stars{ display:flex; gap:3px; }
.cs-stars.sm{ margin-top:6px; }

/* posters */
.cs-poster{ position:relative; border-radius:12px; display:flex; align-items:flex-end; overflow:hidden; }
.cs-poster span{ padding:8px; font-size:12px; font-weight:600; line-height:1.15; text-shadow:0 1px 4px rgba(0,0,0,.5); }
.cs-poster.sm{ width:52px; height:70px; flex:0 0 52px; }
.cs-poster.sm span{ display:none; }
.cs-posterimg{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.cs-poster img + span{ position:relative; z-index:1; }
.cs-searchnote{ padding:24px 4px; text-align:center; color:#8e8e93; font-size:14px; }
.cs-badge{ position:absolute; top:5px; right:5px; width:20px; height:20px; border-radius:50%;
  background:var(--acc); color:#000; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.cs-ratebadge{ position:absolute; top:5px; right:5px; background:var(--acc); color:#3a2e00; font-size:9.5px; font-weight:700;
  padding:2px 6px; border-radius:99px; }

/* profile taste shelves */
.cs-shelfnote{ font-size:11.5px; color:var(--mut); flex:0 0 auto; margin-left:8px; }
.cs-shelfsubline{ font-size:11.5px; color:var(--mut); margin:-8px 0 12px; }
.cs-shelf{ display:flex; gap:10px; overflow-x:auto; padding-bottom:2px; scrollbar-width:none; }
.cs-shelf::-webkit-scrollbar{ display:none; }
.cs-shelfcard{ flex:0 0 auto; width:78px; background:none; border:none; padding:0; text-align:left; font-family:inherit; color:var(--txt); cursor:pointer; }
.cs-poster.shelf{ width:78px; height:110px; flex:0 0 78px; }
.cs-poster.shelf span{ display:none; }
.cs-shelftitle{ font-size:11px; font-weight:600; margin-top:6px; line-height:1.25;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.cs-shelfsub{ font-size:10px; color:var(--mut); margin-top:1px; }

.cs-genrelist{ display:flex; flex-direction:column; gap:9px; }
.cs-genrerow{ display:flex; align-items:center; gap:10px; }
.cs-genrename{ width:88px; flex:0 0 auto; font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cs-genrebar{ flex:1; height:8px; border-radius:5px; background:var(--card); overflow:hidden; }
.cs-genrebar i{ display:block; height:100%; background:var(--acc); border-radius:5px; }
.cs-genren{ width:22px; flex:0 0 auto; text-align:right; font-size:11.5px; color:var(--mut); font-variant-numeric:tabular-nums; }
.cs-genrecallout{ margin-top:12px; background:#242408; border:1.5px solid #4a4210; border-radius:12px; padding:11px 13px; font-size:12px; color:#e8dfa8; }
.cs-genrecallout b{ color:#FFD426; }

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
.cs-feedsentinel{ text-align:center; padding:18px 4px 8px; font-size:12.5px; color:var(--mut); }

/* live activity feed */
.cs-feedlist{ display:flex; flex-direction:column; gap:10px; }
.cs-feedrow{ display:flex; align-items:center; gap:12px; background:var(--card); border-radius:16px; padding:12px; }
.cs-favatar{ flex:0 0 38px; width:38px; height:38px; border-radius:50%; background:var(--card2);
  display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:700; color:var(--acc); object-fit:cover; }
.cs-feedavatarbtn{ flex:0 0 auto; background:none; border:none; padding:0; cursor:pointer; display:flex; }
.cs-feedavatarbtn:disabled{ cursor:default; }
.cs-feedmeta{ flex:1; min-width:0; }
.cs-feedtext{ font-size:13.5px; line-height:1.4; color:var(--txt); }
.cs-feedtext b{ font-weight:600; }
.cs-feednamebtn{ background:none; border:none; padding:0; margin:0; color:inherit; font:inherit; font-weight:600; cursor:pointer; }
.cs-feednamebtn:disabled{ cursor:default; }
.cs-feedtime{ font-size:11.5px; color:var(--mut); margin-top:3px; }

/* follow / follower list */
.cs-followlist{ display:flex; flex-direction:column; margin-top:6px; }
.cs-followrow{ display:flex; align-items:center; gap:13px; width:100%; text-align:left; background:none; border:none;
  color:var(--txt); padding:12px 2px; font-size:15px; font-family:inherit; cursor:pointer; border-bottom:1px solid var(--line); }
.cs-followrow:last-child{ border-bottom:none; }
.cs-followname{ flex:1; font-weight:600; }

/* notifications */
.cs-notifhead{ display:flex; align-items:baseline; justify-content:space-between; margin-bottom:8px; padding-right:42px; }
.cs-notifclear{ background:none; border:none; color:var(--acc); font-size:12.5px; font-weight:600; cursor:pointer; font-family:inherit; padding:0; }
.cs-notiflist{ display:flex; flex-direction:column; gap:9px; margin-top:6px; padding-bottom:10px; }
.cs-notifrow{ display:flex; align-items:flex-start; gap:12px; width:100%; text-align:left; background:var(--card);
  border:none; border-radius:14px; padding:12px; cursor:pointer; font-family:inherit; color:var(--txt); }
.cs-notifrow.unread{ background:#20240f; }
.cs-notificon{ flex:0 0 34px; width:34px; height:34px; border-radius:50%; background:var(--card2);
  display:flex; align-items:center; justify-content:center; color:var(--acc); }
.cs-notifmeta{ flex:1; min-width:0; }
.cs-notiftext{ font-size:13.5px; font-weight:600; line-height:1.35; }
.cs-notifsub{ font-size:12px; color:var(--mut); margin-top:2px; }
.cs-notiftime{ font-size:11px; color:var(--mut); margin-top:5px; }
.cs-notifdot{ flex:0 0 auto; width:8px; height:8px; border-radius:50%; background:var(--acc); margin-top:4px; }

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
.cs-pill:disabled{ opacity:.5; cursor:default; }

/* profile */
.cs-profile{ padding-bottom:24px; }
.cs-phead{ display:flex; align-items:center; justify-content:space-between; padding:18px 20px 10px; }
.cs-pid{ display:flex; align-items:center; gap:14px; padding:6px 20px 18px; }
.cs-avatar{ width:56px; height:56px; border-radius:50%; background:var(--card2);
  display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700; color:var(--acc); }
.cs-uname{ font-size:18px; font-weight:700; }
.cs-usub{ font-size:12.5px; color:var(--mut); margin-top:1px; }
.cs-social{ display:flex; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
.cs-socell{ flex:1; text-align:center; padding:16px 4px; background:none; border:none; color:inherit; font-family:inherit; cursor:default; }
button.cs-socell{ cursor:pointer; }
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
  z-index:40; animation:fade .18s ease; padding-top:env(safe-area-inset-top); }
@keyframes fade{ from{opacity:0} to{opacity:1} }
.cs-sheet{ width:100%; max-height:90%; overflow-y:auto; background:#141416; border-radius:24px 24px 0 0;
  padding:10px 20px 30px; position:relative; animation:rise .26s cubic-bezier(.2,.8,.2,1); }
.cs-sheet.short{ padding-bottom:24px; }
.cs-sheet.tall{ max-height:96%; height:96%; display:flex; flex-direction:column; }
.cs-sheet.tall .cs-eplist{ flex:1; }
@keyframes rise{ from{transform:translateY(30px)} to{transform:translateY(0)} }
.cs-grab{ width:38px; height:4px; border-radius:3px; background:#48484a; margin:2px auto 14px; }
.cs-close{ position:absolute; top:14px; right:16px; background:var(--card2); border:none; color:var(--txt);
  width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:2; }
.cs-dhero{ position:relative; overflow:hidden; height:180px; border-radius:16px; display:flex; align-items:flex-end; padding:16px; margin-bottom:16px; }
.cs-dhero span{ position:relative; z-index:1; font-size:20px; font-weight:700; text-shadow:0 2px 8px rgba(0,0,0,.5); }
.cs-dhero .cs-posterimg{ object-position:center 20%; }
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

/* episode-picker CTA — primary-card weight, tinted to pair with the active status pill */
.cs-epcta{ display:flex; align-items:center; gap:13px; width:100%; text-align:left; margin:20px 0 0;
  background:#242408; border:1.5px solid #4a4210; border-radius:18px; padding:16px; cursor:pointer; font-family:inherit; color:var(--txt); }
.cs-epcta-badge{ flex:0 0 44px; width:44px; height:44px; border-radius:50%; background:var(--acc);
  display:flex; align-items:center; justify-content:center; color:#3a2e00; }
.cs-epcta-body{ flex:1; min-width:0; }
.cs-epcta-count{ font-size:16px; font-weight:700; letter-spacing:-.01em; }
.cs-epcta-body .cs-progbar{ margin-top:9px; }
.cs-epcta-sub{ font-size:12px; color:#c9c095; margin-top:7px; }
.cs-epcta-chev{ flex:0 0 auto; color:var(--mut); }

/* episode picker */
.cs-epprogwrap{ margin:14px 0 4px; }
.cs-epprogwrap .cs-blabel{ margin:8px 0 0; }
.cs-seasonrow{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin:14px 0 10px; flex-wrap:wrap; }
.cs-seasonrow .cs-pill.sm{ flex:0 0 auto; }
.cs-seasonselect{ position:relative; flex:0 1 auto; min-width:0; display:flex; align-items:center; }
.cs-seasonselect select{ appearance:none; -webkit-appearance:none; background:var(--card); color:var(--txt);
  border:1.5px solid rgba(255,255,255,.55); border-radius:999px; padding:8px 34px 8px 16px;
  font-size:14px; font-weight:600; font-family:inherit; cursor:pointer; max-width:100%; }
.cs-seasonselect select:focus{ outline:none; }
.cs-seasonselect svg{ position:absolute; right:12px; pointer-events:none; color:var(--mut); }
.cs-seasonlabel{ font-size:14px; font-weight:600; color:var(--mut); }
.cs-eplist{ display:flex; flex-direction:column; gap:10px; padding-bottom:10px; }
.cs-eprow{ display:flex; align-items:flex-start; gap:12px; width:100%; text-align:left;
  background:var(--card); border:none; border-radius:14px; padding:10px; cursor:pointer; font-family:inherit; color:var(--txt); }
.cs-eprow.on{ background:#20240f; }
.cs-eprow.upcoming{ background:#161615; opacity:.7; cursor:default; }
.cs-epsechd{ font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--mut); margin:4px 2px 0; }
.cs-epairdate{ flex:0 0 auto; font-size:11px; font-weight:600; color:#FFD426; white-space:nowrap; align-self:center; }
.cs-epimg{ flex:0 0 100px; width:100px; height:60px; border-radius:9px; overflow:hidden; background:var(--card2); }
.cs-epimg img{ width:100%; height:100%; object-fit:cover; display:block; }
.cs-epimg-ph{ width:100%; height:100%; background:var(--card2); }
.cs-epmeta{ flex:1; min-width:0; }
.cs-eptop{ display:flex; gap:6px; align-items:baseline; }
.cs-epnum{ font-size:13px; color:var(--mut); font-weight:600; flex:0 0 auto; }
.cs-epname{ font-size:14px; font-weight:600; line-height:1.25; }
.cs-epoverview{ margin:4px 0 0; font-size:12px; color:var(--mut); line-height:1.4;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.cs-epfoot{ display:flex; gap:10px; margin-top:6px; font-size:11px; color:var(--dim); }
.cs-eprating{ display:flex; align-items:center; gap:3px; color:var(--mut); }
.cs-eprow .cs-check{ flex:0 0 auto; margin-top:2px; }

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
.cs-nav{ display:flex; border-top:1px solid var(--line); background:#050505; padding:8px 4px calc(10px + env(safe-area-inset-bottom)); }
.cs-navbtn{ flex:1; background:none; border:none; color:var(--dim); display:flex; flex-direction:column;
  align-items:center; gap:4px; padding:4px; cursor:pointer; font-family:inherit; }
.cs-navbtn span{ font-size:11px; }
.cs-navbtn.on{ color:var(--txt); }

/* gate screens (sign-in / setup) */
.cs-gate{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  padding:max(32px, env(safe-area-inset-top)) 32px max(32px, env(safe-area-inset-bottom)); }
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
