/** A Home Assistant of our own, for the card to be tested in.
 *
 * The browser checks in `scripts/smoke.js` drive the built card against a fake
 * `hass`, and a fake only ever behaves the way the person who wrote it
 * imagined. Two bugs reached a live instance that way: Home Assistant rejects
 * a service call with `{code, message}` and not an `Error`, and the editor
 * renders `ha-form`, which no fake provides at all.
 *
 * So this brings up the real thing — a throwaway Home Assistant and a
 * throwaway TimescaleDB, in containers of their own — installs Scribe and the
 * built card into it, onboards it over the API, and hands back a browser that
 * is logged in. Nothing here touches a real instance, and `down()` leaves
 * nothing behind.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Named so that anything left behind is obviously ours, and obviously junk. */
const NETWORK = "scribe-card-e2e";
const DB = "scribe-card-e2e-db";
const HA = "scribe-card-e2e-ha";

/** A port nobody's real Home Assistant is on. */
const PORT = Number(process.env.E2E_PORT ?? 8124);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = `${BASE_URL}/`;

const DB_IMAGE = "timescale/timescaledb:latest-pg17";
const HA_IMAGE = process.env.E2E_HA_IMAGE ?? "homeassistant/home-assistant:stable";

/** Where Scribe itself is checked out, since the card is tested against it. */
const SCRIBE = resolve(root, process.env.SCRIBE_PATH ?? "../scribe");

const USER = { name: "E2E", username: "e2e", password: "e2e-password-1234" };

async function docker(args, { tolerate = false } = {}) {
  try {
    const { stdout } = await run("docker", args, { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    if (tolerate) return "";
    throw new Error(`docker ${args.join(" ")}\n${error.stderr || error.message}`);
  }
}

/** Everything this rig ever creates, removed. Safe to call before `up`. */
export async function down() {
  await docker(["rm", "-f", HA, DB], { tolerate: true });
  await docker(["network", "rm", NETWORK], { tolerate: true });
}

async function waitFor(what, check, { timeout = 180_000, every = 1000 } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, every));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** The configuration directory Home Assistant is handed, built from scratch. */
async function writeConfig() {
  const dir = await mkdtemp(resolve(tmpdir(), "scribe-card-e2e-"));

  // Only what a dashboard needs. `default_config` would pull in Bluetooth and
  // a dozen discoveries that make a container take minutes to boot.
  await writeFile(
    resolve(dir, "configuration.yaml"),
    `homeassistant:
  name: Scribe Card E2E
  latitude: 48.85
  longitude: 2.35
  elevation: 35
  time_zone: Europe/Paris
  country: FR
  currency: EUR
  unit_system: metric
frontend:
http:
websocket_api:
api:
config:
person:
lovelace:
  mode: storage
logger:
  default: warning
  logs:
    custom_components.scribe: info
scribe:
  db_url: postgresql://scribe:scribe@${DB}:5432/scribe
  flush_interval: 5
  batch_size: 50
  enable_stats_io: false
  enable_stats_chunk: false
`,
  );

  await mkdir(resolve(dir, "custom_components"), { recursive: true });
  await cp(resolve(SCRIBE, "custom_components/scribe"), resolve(dir, "custom_components/scribe"), {
    recursive: true,
    filter: (path) => !path.includes("__pycache__"),
  });

  await mkdir(resolve(dir, "www"), { recursive: true });
  await cp(resolve(root, "dist/scribe-card.js"), resolve(dir, "www/scribe-card.js"));

  return dir;
}

/** Create the owner, and finish the steps that would otherwise leave the
 * frontend stuck on its welcome screen. */
async function post(path, body, token) {
  const answer = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!answer.ok) throw new Error(`${path}: ${answer.status} ${await answer.text()}`);
  return answer.json();
}

/** An authorization code for an access token, which is the last step of both
 * onboarding and logging in. */
async function exchange(code) {
  const granted = await fetch(`${BASE_URL}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
    }),
  });
  if (!granted.ok) throw new Error(`token: ${granted.status} ${await granted.text()}`);
  return granted.json();
}

async function onboard() {
  const { auth_code } = await post("/api/onboarding/users", {
    ...USER,
    client_id: CLIENT_ID,
    // French, on purpose: it is the locale the card has to read, and an
    // English instance would never show a wrong month name.
    language: "fr",
  });
  const tokens = await exchange(auth_code);

  const auth = { authorization: `Bearer ${tokens.access_token}` };
  for (const [step, body] of [
    ["core_config", {}],
    ["analytics", {}],
    ["integration", { client_id: CLIENT_ID, redirect_uri: `${BASE_URL}/?auth_callback=1` }],
  ]) {
    await fetch(`${BASE_URL}/api/onboarding/${step}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }

  return tokens;
}

/**
 * Log in the way a person does, for a container that is already onboarded.
 *
 * Onboarding happens once; this is how a second run, or a rig brought up
 * against a container left standing, gets a token.
 */
export async function login() {
  const flow = await post("/auth/login_flow", {
    client_id: CLIENT_ID,
    handler: ["homeassistant", null],
    redirect_uri: `${BASE_URL}/?auth_callback=1`,
    type: "authorize",
  });

  const step = await post(`/auth/login_flow/${flow.flow_id}`, {
    username: USER.username,
    password: USER.password,
    client_id: CLIENT_ID,
  });
  if (step.type !== "create_entry") {
    throw new Error(
      `login stopped at ${step.step_id ?? step.type}: ${JSON.stringify(step.errors ?? {})}`,
    );
  }

  return exchange(step.result);
}

/** What `localStorage` holds once someone has logged in, which is all the
 * frontend needs to consider a browser logged in. */
export function hassTokens(tokens) {
  return {
    hassUrl: BASE_URL,
    clientId: CLIENT_ID,
    expires: Date.now() + tokens.expires_in * 1000,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
  };
}

/** Run some SQL in the database container, with no client library here. */
export async function sql(statement) {
  return docker(["exec", "-i", DB, "psql", "-U", "scribe", "-d", "scribe", "-At", "-c", statement]);
}

export async function up({ quiet = false } = {}) {
  const say = (line) => !quiet && console.log(`  ${line}`);

  await down();
  await docker(["network", "create", NETWORK]);

  say("database…");
  await docker([
    "run",
    "-d",
    "--name",
    DB,
    "--network",
    NETWORK,
    "-e",
    "POSTGRES_USER=scribe",
    "-e",
    "POSTGRES_PASSWORD=scribe",
    "-e",
    "POSTGRES_DB=scribe",
    DB_IMAGE,
    // A scheduler running a policy on a table a test is dropping has crashed
    // the whole server before; nothing here needs background jobs.
    "-c",
    "timescaledb.max_background_workers=0",
  ]);
  await waitFor("the database", async () => {
    const out = await docker(["exec", DB, "pg_isready", "-U", "scribe"], { tolerate: true });
    return out.includes("accepting connections");
  });

  const configDir = await writeConfig();

  say("home assistant…");
  await docker([
    "run",
    "-d",
    "--name",
    HA,
    "--network",
    NETWORK,
    "-p",
    `${PORT}:8123`,
    "-e",
    "TZ=Europe/Paris",
    "-v",
    `${configDir}:/config`,
    HA_IMAGE,
  ]);
  await waitFor("home assistant", async () => {
    const answer = await fetch(`${BASE_URL}/api/onboarding`).catch(() => undefined);
    return Boolean(answer?.ok);
  });

  say("onboarding…");
  const status = await fetch(`${BASE_URL}/api/onboarding`).then((answer) => answer.json());
  const done = Array.isArray(status) && status.every((step) => step.done);
  const tokens = done ? await login() : await onboard();

  say("scribe…");
  // Scribe builds its own schema on the way up; the card has nothing to draw
  // until it has.
  await waitFor(
    "scribe's tables",
    async () => (await sql("SELECT to_regclass('public.states_raw')")) === "states_raw",
  );

  return { baseUrl: BASE_URL, tokens, configDir, containers: { HA, DB } };
}

/**
 * A month of history to draw.
 *
 * Home Assistant records a handful of rows a second here, which is nothing to
 * chart; these are the thirty days a real instance would already have, put in
 * directly so a range picker has something to range over. Eight thousand rows
 * is also past the point where the card starts downsampling.
 */
export async function seed() {
  await sql(`
    INSERT INTO entities (entity_id, domain, name)
    VALUES ('sensor.e2e_temperature', 'sensor', 'E2E temperature')
    ON CONFLICT DO NOTHING;

    INSERT INTO states_raw (time, metadata_id, state, value)
    SELECT g, (SELECT id FROM entities WHERE entity_id = 'sensor.e2e_temperature'),
           round(v::numeric, 2)::text, v
    FROM (
      SELECT g, 18 + 8 * sin(extract(epoch from g) / 86400.0 * 2 * pi()) + (random() - 0.5) AS v
      FROM generate_series(now() - interval '30 days', now(), interval '5 minutes') g
    ) s
    ON CONFLICT DO NOTHING;
  `);
  return Number(await sql("SELECT count(*) FROM states_raw"));
}

/** The Home Assistant log, for when something fails and the reason is in it. */
export async function haLog(lines = 40) {
  return docker(["logs", "--tail", String(lines), HA], { tolerate: true });
}

export async function cleanup(configDir) {
  await down();
  if (!configDir) return;
  // Home Assistant writes its `.storage` as root, so this process cannot
  // remove what it created; a throwaway container can.
  await docker(
    [
      "run",
      "--rm",
      "-v",
      `${configDir}:/target`,
      "alpine",
      "sh",
      "-c",
      "rm -rf /target/* /target/.[!.]*",
    ],
    { tolerate: true },
  );
  await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
}
