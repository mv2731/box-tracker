#!/usr/bin/env node
// Scrapes each EasyPost public tracking page and writes docs/data/tracking.json.
// The pages server-render the full EasyPost tracker object into the Next.js RSC
// payload, so no API key is needed.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(ROOT, "packages.json");
const OUT = resolve(ROOT, "docs/data/tracking.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Concatenate the self.__next_f.push([1,"..."]) string chunks that make up the payload.
function extractFlightPayload(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,/g;
  let m;
  while ((m = re.exec(html))) {
    let i = m.index + m[0].length;
    if (html[i] !== '"') continue;
    let j = i + 1;
    let raw = "";
    while (j < html.length) {
      if (html[j] === "\\") {
        raw += html[j] + html[j + 1];
        j += 2;
        continue;
      }
      if (html[j] === '"') break;
      raw += html[j];
      j++;
    }
    try {
      chunks.push(JSON.parse('"' + raw + '"'));
    } catch {
      // A chunk that will not parse contributes nothing; the tracker guard below catches real breakage.
    }
  }
  return chunks.join("");
}

// Read the balanced JSON object that follows the "tracker": key.
function extractTracker(flight) {
  const key = '"tracker":';
  const at = flight.indexOf(key);
  if (at === -1) throw new Error('no "tracker" key in RSC payload');
  const start = flight.indexOf("{", at + key.length);
  if (start === -1) throw new Error("no object after tracker key");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < flight.length; i++) {
    const c = flight[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(flight.slice(start, i + 1));
    }
  }
  throw new Error("unterminated tracker object");
}

function normalizeEvent(d) {
  const loc = d.tracking_location ?? {};
  return {
    message: d.message ?? d.description ?? "",
    status: d.status ?? null,
    statusDetail: d.status_detail ?? null,
    datetime: d.datetime ?? null,
    datetimeLocal: d.datetime_local ?? null,
    city: loc.city ?? null,
    state: loc.state ?? null,
    zip: loc.zip ?? null,
    country: loc.country ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry transient network/5xx errors; a real failure still propagates.
async function fetchHtml(url, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(1000 * 2 ** (i - 1));
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      if (res.status >= 500 || res.status === 429) {
        last = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`${last?.message ?? "unknown error"} after ${attempts} attempts`);
}

async function fetchTracker(pkg) {
  const tracker = extractTracker(extractFlightPayload(await fetchHtml(pkg.trackerUrl)));

  // Guard against a mislabeled URL silently showing the wrong box.
  if (tracker.tracking_code !== pkg.trackingCode) {
    throw new Error(
      `tracking code mismatch: page has ${tracker.tracking_code}, config has ${pkg.trackingCode}`,
    );
  }

  const events = (tracker.tracking_details ?? [])
    .map(normalizeEvent)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const cd = tracker.carrier_detail ?? {};

  return {
    nickname: pkg.nickname,
    trackingCode: tracker.tracking_code,
    trackerUrl: pkg.trackerUrl,
    carrier: tracker.carrier ?? null,
    service: cd.service ?? null,
    status: tracker.status ?? "unknown",
    statusDetail: tracker.status_detail ?? null,
    estDelivery: tracker.est_delivery_date ?? null,
    estDeliveryLocal: cd.est_delivery_date_local ?? null,
    carrierUpdatedAt: tracker.updated_at ?? null,
    signedBy: tracker.signed_by ?? null,
    weightOz: tracker.weight ?? null,
    originLocation: cd.origin_location ?? null,
    destinationLocation: cd.destination_location ?? null,
    lastEvent: events.length ? events[events.length - 1] : null,
    events,
  };
}

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const results = await Promise.all(
  config.packages.map(async (pkg) => {
    try {
      return { ok: true, data: await fetchTracker(pkg) };
    } catch (err) {
      console.error(`FAIL ${pkg.nickname} (${pkg.trackingCode}): ${err.message}`);
      return {
        ok: false,
        data: {
          nickname: pkg.nickname,
          trackingCode: pkg.trackingCode,
          trackerUrl: pkg.trackerUrl,
          status: "error",
          error: err.message,
          events: [],
          lastEvent: null,
        },
      };
    }
  }),
);

const failed = results.filter((r) => !r.ok).length;

// Refuse to overwrite good data with a wholesale failure (network down, page redesign).
if (failed === results.length) {
  console.error(`All ${failed} lookups failed; leaving existing tracking.json untouched.`);
  process.exit(1);
}

const payload = {
  generatedAt: new Date().toISOString(),
  shipmentRequestId: config.shipmentRequestId ?? null,
  origin: config.origin ?? null,
  destination: config.destination ?? null,
  failedCount: failed,
  packages: results.map((r) => r.data),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");

const summary = payload.packages
  .map((p) => `${p.nickname}=${p.status}`)
  .join("  ");
console.log(`Wrote ${OUT}`);
console.log(summary);
if (failed) console.error(`${failed} of ${results.length} lookups failed.`);
