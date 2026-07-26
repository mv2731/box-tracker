#!/usr/bin/env node
// Emails the family when a box is about to arrive and again when it is delivered.
// State lives in state/notified.json so each box triggers each email only once.
//
// Env:
//   MAIL_TO    comma-separated recipients (kept in a secret, not in this public repo)
//   SMTP_USER  gmail address to send from
//   SMTP_PASS  gmail app password
//   ARRIVAL_TZ timezone used to decide "today" (default America/Los_Angeles)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(ROOT, "docs/data/tracking.json");
const STATE = resolve(ROOT, "state/notified.json");
const DRY_RUN = process.argv.includes("--dry-run");
const TZ = process.env.ARRIVAL_TZ || "America/Los_Angeles";

const dayIn = (tz, date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);

async function readJson(path, fallbackWhenMissing) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" && fallbackWhenMissing !== undefined) return fallbackWhenMissing;
    throw err;
  }
}

const tracking = await readJson(DATA);
// Only the state file is allowed to be absent — on the very first run nothing has been sent yet.
const state = await readJson(STATE, {});
const today = dayIn(TZ);

// Flatten packages across batches; tag each with its batch title for clear wording.
const allPackages = (tracking.batches ?? [{ title: null, packages: tracking.packages ?? [] }])
  .flatMap((b) => b.packages.map((p) => ({ ...p, batchTitle: b.title })));

const pending = [];
for (const p of allPackages) {
  if (p.status === "error") continue;
  const seen = (state[p.trackingCode] ??= {});
  const etaDay = p.estDeliveryLocal || (p.estDelivery || "").slice(0, 10) || null;

  const arrivingToday =
    p.status === "out_for_delivery" ||
    (etaDay && etaDay === today && p.status !== "delivered");

  if (arrivingToday && !seen.arriving) pending.push({ kind: "arriving", pkg: p, etaDay });
  if (p.status === "delivered" && !seen.delivered) pending.push({ kind: "delivered", pkg: p, etaDay });
}

if (!pending.length) {
  console.log("Nothing new to announce.");
  process.exit(0);
}

const where = (p) => {
  const e = p.lastEvent;
  if (!e) return "";
  const city = (e.city || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return [city, e.state].filter(Boolean).join(", ");
};

const arriving = pending.filter((x) => x.kind === "arriving");
const delivered = pending.filter((x) => x.kind === "delivered");

const names = (list) => list.map((x) => x.pkg.nickname).join(", ");
let subject;
if (delivered.length && arriving.length) {
  subject = `${names(delivered)} delivered, ${names(arriving)} arriving today`;
} else if (delivered.length) {
  subject = delivered.length === 1
    ? `${delivered[0].pkg.nickname} was just delivered`
    : `${delivered.length} boxes were just delivered`;
} else {
  subject = arriving.length === 1
    ? `${arriving[0].pkg.nickname} is arriving today`
    : `${arriving.length} boxes are arriving today`;
}

const lines = [];
if (delivered.length) {
  lines.push("Delivered:");
  for (const { pkg } of delivered) {
    const who = pkg.signedBy ? `, signed for by ${pkg.signedBy}` : "";
    lines.push(`  - ${pkg.nickname} (${pkg.trackingCode}) arrived${who}.`);
  }
  lines.push("");
}
if (arriving.length) {
  lines.push("Arriving today:");
  for (const { pkg } of arriving) {
    const loc = where(pkg);
    lines.push(`  - ${pkg.nickname} (${pkg.trackingCode})${loc ? `, last seen in ${loc}` : ""}.`);
  }
  lines.push("");
}
lines.push("See all six boxes: https://mv2731.github.io/box-tracker/");

const text = lines.join("\n");
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const section = (title, items, render) =>
  items.length
    ? `<h3 style="margin:18px 0 6px;font-size:15px;color:#221f1b">${title}</h3>
       <ul style="margin:0;padding-left:18px;color:#5b554c;font-size:14px;line-height:1.6">
         ${items.map(render).join("")}
       </ul>`
    : "";

const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px">
  <h2 style="margin:0 0 4px;font-size:19px;color:#221f1b">${esc(subject)}</h2>
  <p style="margin:0;color:#918a7e;font-size:13px">Brooklyn, NY to Sunnyvale, CA</p>
  ${section("Delivered", delivered, ({ pkg }) =>
    `<li><b>${esc(pkg.nickname)}</b> (${esc(pkg.trackingCode)}) arrived${
      pkg.signedBy ? `, signed for by ${esc(pkg.signedBy)}` : ""}.</li>`)}
  ${section("Arriving today", arriving, ({ pkg }) => {
    const loc = where(pkg);
    return `<li><b>${esc(pkg.nickname)}</b> (${esc(pkg.trackingCode)})${
      loc ? `, last seen in ${esc(loc)}` : ""}.</li>`;
  })}
  <p style="margin:20px 0 0">
    <a href="https://mv2731.github.io/box-tracker/"
       style="background:#2a78d6;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px;display:inline-block">
      See all six boxes
    </a>
  </p>
</div>`;

if (DRY_RUN) {
  console.log("--- DRY RUN, no email sent ---");
  console.log(`To: ${process.env.MAIL_TO || "(MAIL_TO not set)"}`);
  console.log(`Subject: ${subject}\n`);
  console.log(text);
  process.exit(0);
}

const { MAIL_TO, SMTP_USER, SMTP_PASS } = process.env;
const missing = Object.entries({ MAIL_TO, SMTP_USER, SMTP_PASS })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(
    `${pending.length} notification(s) ready but cannot send: missing ${missing.join(", ")}.`,
  );
  process.exit(1);
}

const { default: nodemailer } = await import("nodemailer");
const transport = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

await transport.sendMail({
  from: `"Box tracker" <${SMTP_USER}>`,
  to: MAIL_TO,
  subject,
  text,
  html,
});
console.log(`Sent "${subject}" to ${MAIL_TO.split(",").length} recipient(s).`);

// Only record state after a successful send, so a failed send retries next run.
for (const { kind, pkg } of pending) (state[pkg.trackingCode] ??= {})[kind] = new Date().toISOString();
await mkdir(dirname(STATE), { recursive: true });
await writeFile(STATE, JSON.stringify(state, null, 2) + "\n");
