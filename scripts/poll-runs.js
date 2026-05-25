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

async function postRun(profile, run) {
  const color = CLASS_COLORS[profile.class] ?? 0xffb938;
  const timed = timedLabel(run);
  const completed = run.completed_at ? new Date(run.completed_at).toISOString() : null;

  const embed = {
    color,
    author: {
      name: `${profile.name} — ${profile.realm}`,
      url: profile.profile_url,
      icon_url: profile.thumbnail_url || undefined,
    },
    title: `+${run.mythic_level} ${run.dungeon} — ${timed}`,
    url: run.url || profile.profile_url,
    fields: [
      { name: "Score", value: String(Math.round(run.score ?? 0)), inline: true },
      { name: "Result", value: timed, inline: true },
      { name: "Class / Spec", value: `${profile.active_spec_name || ""} ${profile.class || ""}`.trim() || "—", inline: true },
    ],
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
      if (state.bootstrapped) toPost.push({ profile, run });
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
    for (const { profile, run } of toPost) {
      await postRun(profile, run);
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
