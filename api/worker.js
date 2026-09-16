/**
 * nik-extras: a tiny Cloudflare Worker that keeps your Yahoo + Spotify keys secret
 * and gives extras.html two clean JSON endpoints:
 *   GET /fantasy   → team, record, this week's score, starting lineup
 *   GET /spotify   → now playing + recently played
 *
 * One-time setup routes (to get your refresh tokens):
 *   /yahoo/login   → sign in with Yahoo, then copy the refresh token it shows
 *   /spotify/login → sign in with Spotify, then copy the refresh token it shows
 *   /fantasy/teams → lists your Yahoo team keys (to pick YAHOO_TEAM_KEY)
 *
 * Secrets / variables to set in Cloudflare (Settings → Variables and Secrets):
 *   YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH_TOKEN, YAHOO_TEAM_KEY (optional)
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
 *   ALLOWED_ORIGIN   e.g. https://nikhilprabh32.github.io
 *   SETUP_ENABLED    "true" while setting up; delete it afterwards to switch the login routes off
 */

const YAHOO_AUTH = "https://api.login.yahoo.com/oauth2/request_auth";
const YAHOO_TOKEN = "https://api.login.yahoo.com/oauth2/get_token";
const YAHOO_API = "https://fantasysports.yahooapis.com/fantasy/v2";
const SPOTIFY_AUTH = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);

    try {
      switch (url.pathname) {
        case "/fantasy":       return cors(await cached(request, ctx, 120, () => fantasy(env)), env);
        case "/spotify":       return cors(await cached(request, ctx, 20, () => spotify(env)), env);
        case "/fantasy/teams": return setupOnly(env, () => fantasyTeams(env));
        case "/yahoo/login":   return setupOnly(env, () => Response.redirect(`${YAHOO_AUTH}?${qs({ client_id: env.YAHOO_CLIENT_ID, redirect_uri: origin + "/yahoo/callback", response_type: "code", language: "en-us" })}`, 302));
        case "/yahoo/callback":   return setupOnly(env, () => exchange(YAHOO_TOKEN, env.YAHOO_CLIENT_ID, env.YAHOO_CLIENT_SECRET, url.searchParams.get("code"), origin + "/yahoo/callback", "YAHOO_REFRESH_TOKEN"));
        case "/spotify/login": return setupOnly(env, () => Response.redirect(`${SPOTIFY_AUTH}?${qs({ client_id: env.SPOTIFY_CLIENT_ID, redirect_uri: origin + "/spotify/callback", response_type: "code", scope: "user-read-currently-playing user-read-recently-played" })}`, 302));
        case "/spotify/callback": return setupOnly(env, () => exchange(SPOTIFY_TOKEN, env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, url.searchParams.get("code"), origin + "/spotify/callback", "SPOTIFY_REFRESH_TOKEN"));
        default: return new Response("nik-extras worker is running", { status: 200 });
      }
    } catch (err) {
      return cors(json({ error: String(err.message || err) }, 502), env);
    }
  },
};

/* ---------------- helpers ---------------- */
const qs = (o) => new URLSearchParams(o).toString();
const basic = (id, secret) => "Basic " + btoa(`${id}:${secret}`);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function cors(res, env) {
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  r.headers.set("Vary", "Origin");
  return r;
}
function setupOnly(env, fn) {
  if (String(env.SETUP_ENABLED).toLowerCase() !== "true") return new Response("Setup routes are off.", { status: 404 });
  return fn();
}
async function cached(request, ctx, seconds, build) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + new URL(request.url).pathname, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", `public, max-age=${seconds}`);
  if (out.ok) ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}
async function refresh(tokenUrl, id, secret, refreshToken) {
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: basic(id, secret), "Content-Type": "application/x-www-form-urlencoded" },
    body: qs({ grant_type: "refresh_token", refresh_token: refreshToken, redirect_uri: "oob" }),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error("token refresh failed: " + (d.error_description || d.error || r.status));
  return d.access_token;
}
async function exchange(tokenUrl, id, secret, code, redirectUri, name) {
  if (!code) return new Response("Missing ?code. Start from the /login route.", { status: 400 });
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: basic(id, secret), "Content-Type": "application/x-www-form-urlencoded" },
    body: qs({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  const d = await r.json();
  if (!d.refresh_token) return new Response("No refresh token returned:\n" + JSON.stringify(d, null, 2), { status: 400 });
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;background:#000;color:#fff;padding:32px;max-width:720px">
    <h1 style="color:#4fa3dc">Connected ✔</h1><p>Copy this and save it in Cloudflare as a secret named <b>${name}</b>:</p>
    <textarea readonly style="width:100%;height:140px;background:#0d1a26;color:#fff;border:1px solid #4fa3dc;padding:12px;font:13px monospace">${d.refresh_token}</textarea>
    <p style="color:#aab4be">Don’t share this token. After saving it, you can close this tab.</p></body>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/* Yahoo's JSON nests data in arrays of one-key objects; these two helpers dig values out safely */
function dig(node, key) {
  if (node == null || typeof node !== "object") return undefined;
  if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  for (const v of Object.values(node)) {
    const found = dig(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
const items = (obj, key) => obj ? Object.keys(obj).filter((k) => /^\d+$/.test(k)).map((k) => obj[k][key]) : [];

async function yahoo(env, path) {
  const token = await refresh(YAHOO_TOKEN, env.YAHOO_CLIENT_ID, env.YAHOO_CLIENT_SECRET, env.YAHOO_REFRESH_TOKEN);
  const r = await fetch(`${YAHOO_API}/${path}${path.includes("?") ? "&" : "?"}format=json`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).fantasy_content;
}

async function fantasyTeams(env) {
  const fc = await yahoo(env, "users;use_login=1/games;game_keys=nfl/teams");
  const teams = [];
  const walk = (n) => { if (n && typeof n === "object") { if (n.team_key) teams.push(n.team_key); Object.values(n).forEach(walk); } };
  walk(fc);
  const list = await Promise.all([...new Set(teams)].map(async (key) => {
    const t = await yahoo(env, `team/${key}`);
    return { team_key: key, name: dig(t, "name") };
  }));
  return json({ note: "Copy the team_key you want into YAHOO_TEAM_KEY (the last one is usually this season).", teams: list });
}

async function fantasy(env) {
  let teamKey = env.YAHOO_TEAM_KEY;
  if (!teamKey) {
    const fc = await yahoo(env, "users;use_login=1/games;game_keys=nfl/teams");
    const keys = []; const walk = (n) => { if (n && typeof n === "object") { if (n.team_key) keys.push(n.team_key); Object.values(n).forEach(walk); } };
    walk(fc); teamKey = keys[keys.length - 1];
    if (!teamKey) throw new Error("No NFL fantasy team found on this Yahoo account");
  }
  const leagueKey = teamKey.split(".t.")[0];
  const league = await yahoo(env, `league/${leagueKey}`);
  const week = Number(dig(league, "current_week")) || 1;

  const [standing, matchups, roster] = await Promise.all([
    yahoo(env, `team/${teamKey}/standings`),
    yahoo(env, `team/${teamKey}/matchups;weeks=${week}`),
    yahoo(env, `team/${teamKey}/roster;week=${week}/players/stats;type=week;week=${week}`),
  ]);

  const outcome = dig(standing, "outcome_totals") || {};
  const team = {
    name: dig(standing.team?.[0], "name"),
    logo: dig(dig(standing.team?.[0], "team_logos"), "url"),
    league: dig(league, "name"),
  };

  // matchup: my side + opponent
  const mTeams = items(dig(matchups, "teams"), "team");
  const side = (t) => ({
    key: dig(t, "team_key"),
    name: dig(t?.[0], "name"),
    points: dig(dig(t, "team_points"), "total"),
    projected: dig(dig(t, "team_projected_points"), "total"),
  });
  const sides = mTeams.map(side);
  const me = sides.find((s) => s.key === teamKey) || {};
  const opp = sides.find((s) => s.key !== teamKey) || {};

  // lineup: everyone not on the bench / IR
  const players = items(dig(roster, "players"), "player").map((p) => ({
    pos: dig(dig(p, "selected_position"), "position"),
    name: dig(p, "full"),
    team: dig(p, "editorial_team_abbr"),
    status: dig(p, "status") || "",
    points: dig(dig(p, "player_points"), "total"),
  }));
  const ORDER = ["QB", "WR", "RB", "TE", "W/R/T", "W/R", "W/T", "Q/W/R/T", "K", "DEF"];
  const starters = players.filter((p) => !["BN", "IR", "IR+", "NA"].includes(p.pos))
    .sort((a, b) => (ORDER.indexOf(a.pos) + 99) % 99 - (ORDER.indexOf(b.pos) + 99) % 99);

  return json({
    team,
    record: { wins: Number(outcome.wins) || 0, losses: Number(outcome.losses) || 0, ties: Number(outcome.ties) || 0, rank: dig(dig(standing, "team_standings"), "rank") },
    week,
    matchup: { me: { points: me.points, projected: me.projected }, opp: { name: opp.name, points: opp.points, projected: opp.projected } },
    lineup: starters,
    updatedAt: new Date().toISOString(),
  });
}

async function spotify(env) {
  const token = await refresh(SPOTIFY_TOKEN, env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, env.SPOTIFY_REFRESH_TOKEN);
  const h = { Authorization: `Bearer ${token}` };
  const [nowRes, recentRes] = await Promise.all([
    fetch(`${SPOTIFY_API}/me/player/currently-playing`, { headers: h }),
    fetch(`${SPOTIFY_API}/me/player/recently-played?limit=6`, { headers: h }),
  ]);
  const now = nowRes.status === 200 ? await nowRes.json() : null;
  const recent = recentRes.ok ? await recentRes.json() : { items: [] };
  const shape = (t) => t && ({
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(", "),
    album: t.album?.name,
    image: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url,
    url: t.external_urls?.spotify,
    durationMs: t.duration_ms,
  });
  const isPlaying = !!(now && now.is_playing && now.item);
  const track = isPlaying ? { ...shape(now.item), progressMs: now.progress_ms } : shape(recent.items?.[0]?.track);
  const list = (recent.items || []).map((i) => shape(i.track)).filter(Boolean)
    .filter((t, i, arr) => arr.findIndex((x) => x.url === t.url) === i)
    .filter((t) => !track || t.url !== track.url);
  return json({ isPlaying, track, recent: list.slice(0, 5), updatedAt: new Date().toISOString() });
}
