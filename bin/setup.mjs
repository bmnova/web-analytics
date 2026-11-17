#!/usr/bin/env node
// web-analytics CLI: creates the BigQuery dataset, table, functions and scheduled
// aggregation for one site, or the cross-site observer views. Uses the `bq` CLI with
// your own gcloud login; it never reads or writes service-account keys.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const LOCATION = /^[A-Za-z0-9-]{2,40}$/;
const AGG_TABLES = ["daily_overview", "daily_channels", "daily_pages", "daily_events", "daily_errors", "daily_bots"];

const HELP = `Usage:
  web-analytics setup    --project <gcp-project> [--dataset web_analytics] [--location EU]
                         [--retention-days 425] [--lookback-days 2] [--schedule-sa <email>] [--no-schedule] [--print]
  web-analytics observer --project <observer-project> --sites <proj.dataset,proj.dataset,...>
                         [--dataset all_sites] [--location EU] [--print]

  --schedule-sa  service account that runs the hourly aggregation (needs BigQuery Job User on the
                 project and Data Editor on the dataset). Without it the scheduled query is skipped,
                 because bq would need an interactive browser consent.
  --print   only print the SQL, do not run anything.
Requires the bq CLI (Google Cloud SDK) logged in as someone who can create datasets.`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--no-")) out[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
      else (out[a.slice(2)] = next), i++;
    } else out._.push(a);
  }
  return out;
}

function fail(msg) {
  console.error(`error: ${msg}\n\n${HELP}`);
  process.exit(1);
}

function check(value, re, name) {
  if (typeof value !== "string" || !re.test(value)) fail(`invalid or missing --${name}`);
  return value;
}

function render(file, vars) {
  return readFileSync(join(SQL_DIR, file), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`missing template var ${k}`);
    return String(vars[k]);
  });
}

function bq(argv, input) {
  const res = spawnSync("bq", argv, { input, encoding: "utf8", stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  if (res.error) fail(`could not run bq (${res.error.message}). Install the Google Cloud SDK and run \`gcloud auth login\`.`);
  return res;
}

function runQuery(project, location, sql, label) {
  process.stdout.write(`• ${label} … `);
  const res = bq(["--quiet", `--project_id=${project}`, `--location=${location}`, "query", "--use_legacy_sql=false", "--format=none"], sql);
  if (res.status !== 0) {
    console.log("failed");
    console.error(res.stderr || res.stdout);
    process.exit(1);
  }
  console.log("ok");
}

function setup(o) {
  const project = check(o.project, PROJECT, "project");
  const dataset = check(o.dataset ?? "web_analytics", DATASET, "dataset");
  const location = check(o.location ?? "EU", LOCATION, "location");
  const retention_days = Number(o["retention-days"] ?? 425);
  const lookback_days = Number(o["lookback-days"] ?? 2);
  if (!Number.isInteger(retention_days) || retention_days < 1) fail("--retention-days must be a positive integer");
  if (!Number.isInteger(lookback_days) || lookback_days < 0 || lookback_days > 30) fail("--lookback-days must be 0-30");

  const vars = { project, dataset, retention_days, lookback_days };
  const ddl = `CREATE SCHEMA IF NOT EXISTS \`${project}.${dataset}\` OPTIONS (location = '${location}');\n${render("01_events.sql", vars)}`;
  const functions = render("02_functions.sql", vars);
  const aggregates = render("03_daily_aggregates.sql", vars);

  if (o.print) {
    console.log([ddl, functions, aggregates].join("\n\n"));
    return;
  }
  runQuery(project, location, ddl, `dataset ${project}.${dataset} and events table`);
  runQuery(project, location, functions, "session and funnel functions");
  runQuery(project, location, aggregates, "daily aggregate tables (first run)");

  if (o.schedule !== false && typeof o["schedule-sa"] !== "string") {
    console.log("• hourly scheduled query … skipped (pass --schedule-sa <service-account-email> to create it)");
  } else if (o.schedule !== false) {
    const sa = check(o["schedule-sa"], /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/, "schedule-sa");
    const displayName = `web-analytics aggregates (${dataset})`;
    const existing = bq(["--format=json", `--project_id=${project}`, "ls", "--transfer_config", `--transfer_location=${location}`]);
    let already = false;
    try {
      already = JSON.parse(existing.stdout || "[]").some((c) => c.displayName === displayName);
    } catch {
      // listing failed; try to create
    }
    // The BigQuery Data Transfer service agent must be able to act as the scheduler account.
    const num = spawnSync("gcloud", ["projects", "describe", project, "--format=value(projectNumber)"], { encoding: "utf8" });
    const projectNumber = num.status === 0 ? num.stdout.trim() : null;
    if (projectNumber) {
      process.stdout.write("• let the transfer service act as the scheduler … ");
      const g = spawnSync("gcloud", [
        "iam", "service-accounts", "add-iam-policy-binding", sa, `--project=${sa.split("@")[1].split(".")[0]}`,
        `--member=serviceAccount:service-${projectNumber}@gcp-sa-bigquerydatatransfer.iam.gserviceaccount.com`,
        "--role=roles/iam.serviceAccountTokenCreator", "--format=none",
      ], { encoding: "utf8" });
      console.log(g.status === 0 ? "ok" : `failed (${(g.stderr || "").trim().split("\n").pop()})`);
    }
    if (already) {
      console.log("• hourly scheduled query … already exists, kept");
    } else {
    process.stdout.write("• hourly scheduled query … ");
    const res = bq([
      `--project_id=${project}`,
      `--location=${location}`,
      "mk",
      "--transfer_config",
      "--data_source=scheduled_query",
      `--display_name=${displayName}`,
      "--schedule=every 1 hours",
      `--service_account_name=${sa}`,
      `--params=${JSON.stringify({ query: aggregates })}`,
    ]);
    if (res.status !== 0) {
      console.log("skipped");
      console.error((res.stderr || res.stdout).trim());
      console.error("Check that the BigQuery Data Transfer API is enabled and that you can act as the service account (roles/iam.serviceAccountUser), or create the scheduled query in the console from `--print` output.");
    } else console.log("ok");
    }
  }

  console.log(`
Next steps (see docs/add-a-site.md for the full guide):
  • Grant web-analytics-writer and web-analytics-scheduler "BigQuery Data Editor" on ${project}.${dataset},
    and the scheduler "BigQuery Job User" on the project; then re-run with --schedule-sa to schedule the aggregation.
  • Store the writer key and settings on your host without printing them:
      scripts/push-secrets.sh vercel|cloudflare ${project} <site> <site-dir>
    (Never commit key files.)`);
}

function observer(o) {
  const project = check(o.project, PROJECT, "project");
  const dataset = check(o.dataset ?? "all_sites", DATASET, "dataset");
  const location = check(o.location ?? "EU", LOCATION, "location");
  if (typeof o.sites !== "string") fail("missing --sites");
  const sites = o.sites.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [p, d] = s.split(".");
    check(p, PROJECT, "sites (project part)");
    check(d, DATASET, "sites (dataset part)");
    return `${p}.${d}`;
  });
  if (!sites.length) fail("--sites is empty");

  const target = `${project}.${dataset}`;
  const parts = [`CREATE SCHEMA IF NOT EXISTS \`${target}\` OPTIONS (location = '${location}');`];
  for (const table of AGG_TABLES) {
    parts.push(`CREATE OR REPLACE VIEW \`${target}.${table}\` AS\n${sites.map((s) => `SELECT * FROM \`${s}.${table}\``).join("\nUNION ALL\n")};`);
  }
  parts.push(
    `CREATE OR REPLACE TABLE FUNCTION \`${target}.funnel\`(steps ARRAY<STRING>, from_date DATE, to_date DATE) AS (\n${sites
      .map((s) => `  SELECT * FROM \`${s}.funnel\`(steps, from_date, to_date)`)
      .join("\n  UNION ALL\n")}\n);`,
    `CREATE OR REPLACE TABLE FUNCTION \`${target}.sessions\`(from_date DATE, to_date DATE) AS (\n${sites
      .map((s) => `  SELECT * FROM \`${s}.sessions\`(from_date, to_date)`)
      .join("\n  UNION ALL\n")}\n);`,
  );
  const sql = parts.join("\n\n");
  if (o.print) return console.log(sql);
  runQuery(project, location, sql, `observer views in ${target} over ${sites.length} site(s)`);
  console.log(`
Give the observer (you, and Looker Studio's data credentials) "BigQuery Data Viewer" on each site dataset,
then connect Looker Studio to ${target}.daily_* — see docs/dashboard.md.`);
}

const o = args(process.argv.slice(2));
const cmd = o._[0];
if (cmd === "setup") setup(o);
else if (cmd === "observer") observer(o);
else {
  console.log(HELP);
  process.exit(cmd ? 1 : 0);
}
