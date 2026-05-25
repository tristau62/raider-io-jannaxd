// Polls Raider.IO for each character's recent runs and posts new completions
// at MIN_LEVEL or higher to a Discord webhook. State is kept in data/seen-runs.json
// so we only post each run once.
//
// Keep CHARACTERS in sync with the list in index.html.

const fs = require("fs");
const path = require("path");

const MIN_LEVEL = 19;
const STATE_FILE = path.join(__dirname, "..", "data", "seen-runs.json");
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

const WCL_CLIENT_ID = process.env.WCL_CLIENT_ID;
const WCL_CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;
const WCL_ENABLED = !!(WCL_CLIENT_ID && WCL_CLIENT_SECRET);
const WCL_REPORT_WINDOW_MS = 45 * 60 * 1000;
let wclToken = null;

const CHARACTERS = [
  { region: "us", realm: "tichondrius", name: "Karmabunni" },
  { region: "us", realm: "tichondrius", name: "Frostdkgobrr" },
  { region: "us", realm: "tichondrius", name: "Spargycat" },
  { region: "us", realm: "tichondrius", name: "Remytherat" },
  { region: "us", realm: "tichondrius", name: "Gldk" },
  { region: "us", realm: "tichondrius", name: "Feetslopgoon" },
  { region: "us", realm: "sargeras",    name: "Shabbarizz" },
  { region: "us", realm: "tichondrius", name: "Aquendiia" },
  { region: "us", realm: "tichondrius", name: "Eraiced" },
  { region: "us", realm: "tichondrius", name: "Spargywater" },
  { region: "us", realm: "illidan",     name: "Huntrayjr" },
  { region: "us", realm: "tichondrius", name: "Restyx" },
  { region: "us", realm: "tichondrius", name: "Aquendlock" },
  { region: "us", realm: "tichondrius", name: "Dilloc" },
];

const CLASS_COLORS = {
  "Death Knight": 0xC41E3A, "Demon Hunter": 0xA330C9, "Druid": 0xFF7C0A,
  "Evoker": 0x33937F, "Hunter": 0xAAD372, "Mage": 0x3FC7EB,
  "Monk": 0x00FF98, "Paladin": 0xF48CBA, "Priest": 0xFFFFFF,
  "Rogue": 0xFFF468, "Shaman": 0x0070DD, "Warlock": 0x8788EE,
  "Warrior": 0xC69B6D,
};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { bootstrapped: false, seen: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { bootstrapped: false, seen: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Keep the most recent N ids to bound file growth.
  state.seen = state.seen.slice(-1000);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function fetchProfile(c) {
  const url = `https://raider.io/api/v1/characters/profile?region=${c.region}&realm=${c.realm}&name=${encodeURIComponent(c.name)}&fields=mythic_plus_recent_runs,mythic_plus_scores_by_season:current`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[${c.name}] HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

function runKey(c, run) {
  // keystone_run_id is the stable Raider.IO id; fall back to a composite if missing.
  const id = run.keystone_run_id ?? `${run.dungeon}|${run.completed_at}|${run.mythic_level}`;
  return `${c.region}-${c.realm}-${c.name.toLowerCase()}-${id}`;
}

function timedLabel(run) {
  const upgrades = run.num_keystone_upgrades ?? 0;
  if (upgrades <= 0) return "Depleted";
  return "+".repeat(upgrades) + " Timed";
}

async function wclGetToken() {
  if (wclToken) return wclToken;
  const creds = Buffer.from(`${WCL_CLIENT_ID}:${WCL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`WCL auth HTTP ${res.status}`);
  const data = await res.json();
  wclToken = data.access_token;
  return wclToken;
}

async function wclQuery(query, variables) {
  const token = await wclGetToken();
  const res = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`WCL GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`WCL GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// Best-effort: return the character's overall "Key %" (DPS percentile across the
// whole keystone) for this specific run. We query zoneRankings, which stores the
// best DPS-parsed run per dungeon — so we only return a value when that "best"
// entry is at the same key level as the run we just detected. If the character
// already has a higher key timed in the same dungeon, zoneRankings reflects that
// higher key instead, and we deliberately show no parse rather than a misleading one.
async function findParseForRun(c, run) {
  if (!WCL_ENABLED) return null;
  try {
    const completedMs = new Date(run.completed_at).getTime();

    // Find a recent report for the link + the M+ zone id.
    const recent = await wclQuery(
      `query Recent($name: String!, $server: String!, $region: String!) {
         characterData {
           character(name: $name, serverSlug: $server, serverRegion: $region) {
             recentReports(limit: 10) {
               data { code endTime zone { id name } }
             }
           }
         }
       }`,
      { name: c.name, server: c.realm, region: c.region },
    );

    const reports = recent?.characterData?.character?.recentReports?.data ?? [];
    const candidate = reports
      .filter(r => Math.abs(r.endTime - completedMs) <= WCL_REPORT_WINDOW_MS)
      .sort((a, b) => Math.abs(a.endTime - completedMs) - Math.abs(b.endTime - completedMs))[0];
    if (!candidate?.zone?.id) return null;

    // The character's per-dungeon best DPS run for the current M+ season.
    const zr = await wclQuery(
      `query ZR($name: String!, $server: String!, $region: String!, $zoneId: Int!) {
         characterData {
           character(name: $name, serverSlug: $server, serverRegion: $region) {
             zoneRankings(zoneID: $zoneId, metric: dps)
           }
         }
       }`,
      { name: c.name, server: c.realm, region: c.region, zoneId: candidate.zone.id },
    );

    const ranks = zr?.characterData?.character?.zoneRankings?.rankings ?? [];
    const dungeonName = (run.dungeon || "").toLowerCase();
    const entry = ranks.find(r => r.encounter?.name?.toLowerCase() === dungeonName);
    if (!entry) return null;

    // Strict key-level match: only show the parse if WCL's recorded best for this
    // dungeon IS the run we just detected. WCL may expose the key level under a
    // few field paths depending on schema version — try the common ones.
    const entryLevel =
      entry.bestRun?.keystoneLevel ??
      entry.keystoneLevel ??
      entry.highestLevel ??
      entry.hardModeLevel ??
      null;
    if (entryLevel == null || entryLevel !== run.mythic_level) return null;

    // Key % = overall keystone DPS percentile from the zoneRankings entry.
    const keyPct = entry.rankPercent ?? entry.bestPercent ?? null;
    if (keyPct == null) return null;

    return {
      percent: Math.round(keyPct),
      reportUrl: `https://www.warcraftlogs.com/reports/${candidate.code}`,
    };
  } catch (err) {
    console.warn(`[${c.name}] WCL lookup failed: ${err.message}`);
    return null;
  }
}

function parseColorHex(pct) {
  // WCL parse color thresholds.
  if (pct >= 99) return "🟠 Astounding";
  if (pct >= 95) return "🟣 Legendary";
  if (pct >= 75) return "🔵 Epic";
  if (pct >= 50) return "🟢 Rare";
  if (pct >= 25) return "🟢 Uncommon";
  return "⚪ Common";
}

async function postRun(profile, run, parse) {
  const color = CLASS_COLORS[profile.class] ?? 0xffb938;
  const timed = timedLabel(run);
  const completed = run.completed_at ? new Date(run.completed_at).toISOString() : null;

  const fields = [
    { name: "Score", value: String(Math.round(run.score ?? 0)), inline: true },
    { name: "Result", value: timed, inline: true },
    { name: "Class / Spec", value: `${profile.active_spec_name || ""} ${profile.class || ""}`.trim() || "—", inline: true },
  ];
  if (parse) {
    fields.push({
      name: "Key %",
      value: `[${parse.percent} · ${parseColorHex(parse.percent)}](${parse.reportUrl})`,
      inline: true,
    });
  }

  const embed = {
    color,
    author: {
      name: `${profile.name} — ${profile.realm}`,
      url: profile.profile_url,
      icon_url: profile.thumbnail_url || undefined,
    },
    title: `+${run.mythic_level} ${run.dungeon} — ${timed}`,
    url: run.url || profile.profile_url,
    fields,
    thumbnail: profile.thumbnail_url ? { url: profile.thumbnail_url } : undefined,
    timestamp: completed,
  };

  const body = { embeds: [embed], allowed_mentions: { parse: [] } };
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`Discord POST ${res.status}: ${text}`);
  }
}

async function main() {
  if (!WEBHOOK) {
    console.error("DISCORD_WEBHOOK_URL is not set");
    process.exit(1);
  }

  const state = loadState();
  const seen = new Set(state.seen);
  const newIds = [];
  const toPost = [];

  for (const c of CHARACTERS) {
    const profile = await fetchProfile(c);
    if (!profile?.mythic_plus_recent_runs) continue;

    for (const run of profile.mythic_plus_recent_runs) {
      if ((run.mythic_level ?? 0) < MIN_LEVEL) continue;
      const key = runKey(c, run);
      if (seen.has(key)) continue;

      newIds.push(key);
      if (state.bootstrapped) toPost.push({ profile, run, character: c });
    }

    // Be polite to the API.
    await new Promise(r => setTimeout(r, 200));
  }

  // On the very first run, just record what's currently in the feed without posting,
  // so we don't dump a wall of historical runs into Discord.
  if (!state.bootstrapped) {
    console.log(`Bootstrapping: recorded ${newIds.length} existing runs, not posting.`);
    state.bootstrapped = true;
  } else {
    // Post oldest first so messages appear in chronological order.
    toPost.sort((a, b) => new Date(a.run.completed_at) - new Date(b.run.completed_at));
    for (const { profile, run, character } of toPost) {
      const parse = await findParseForRun(character, run);
      await postRun(profile, run, parse);
      await new Promise(r => setTimeout(r, 300));
    }
    console.log(`Posted ${toPost.length} new run(s).`);
  }

  for (const id of newIds) state.seen.push(id);
  saveState(state);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
