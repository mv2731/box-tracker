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

const fedexUrl = (code) => `https://www.fedex.com/fedextrack/?trknbr=${code}`;

// A package with no EasyPost tracker URL can't be live-scraped (FedEx blocks
// direct tracking requests). Show it as a label with a FedEx link instead.
function staticPackage(pkg) {
  return {
    nickname: pkg.nickname,
    trackingCode: pkg.trackingCode,
    trackerUrl: fedexUrl(pkg.trackingCode),
    carrier: "FedEx",
    service: "FEDEX_GROUND",
    status: "pre_transit",
    statusDetail: "label_created",
    estDelivery: null,
    estDeliveryLocal: null,
    carrierUpdatedAt: null,
    signedBy: null,
    weightOz: null,
    originLocation: null,
    destinationLocation: null,
    live: false,
    events: [],
    lastEvent: null,
  };
}

async function fetchOne(pkg) {
  if (!pkg.trackerUrl) return { live: false, ok: true, data: staticPackage(pkg) };
  try {
    return { live: true, ok: true, data: { ...(await fetchTracker(pkg)), live: true } };
  } catch (err) {
    console.error(`FAIL ${pkg.nickname} (${pkg.trackingCode}): ${err.message}`);
    return {
      live: true,
      ok: false,
      data: {
        nickname: pkg.nickname,
        trackingCode: pkg.trackingCode,
        trackerUrl: pkg.trackerUrl,
        status: "error",
        error: err.message,
        live: true,
        events: [],
        lastEvent: null,
      },
    };
  }
}

const config = JSON.parse(await readFile(CONFIG, "utf8"));
// Support both the batched config and the older single-batch shape.
const batches = config.batches ?? [
  {
    id: "batch1",
    title: "Our Boxes",
    shipmentRequestId: config.shipmentRequestId,
    origin: config.origin,
    destination: config.destination,
    packages: config.packages,
  },
];

let liveTotal = 0;
let liveFailed = 0;
const outBatches = [];
for (const batch of batches) {
  const results = await Promise.all(batch.packages.map(fetchOne));
  const failed = results.filter((r) => r.live && !r.ok).length;
  liveTotal += results.filter((r) => r.live).length;
  liveFailed += failed;
  outBatches.push({
    id: batch.id,
    title: batch.title,
    shipmentRequestId: batch.shipmentRequestId ?? null,
    origin: batch.origin ?? null,
    destination: batch.destination ?? null,
    note: batch.note ?? null,
    failedCount: failed,
    packages: results.map((r) => r.data),
  });
}

// Refuse to overwrite good data with a wholesale failure (network down, page redesign).
// Static-only runs (no live lookups) are always allowed to write.
if (liveTotal > 0 && liveFailed === liveTotal) {
  console.error(`All ${liveTotal} live lookups failed; leaving existing tracking.json untouched.`);
  process.exit(1);
}

const payload = {
  generatedAt: new Date().toISOString(),
  failedCount: liveFailed,
  batches: outBatches,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");

console.log(`Wrote ${OUT}`);
for (const b of outBatches) {
  console.log(`[${b.title}] ` + b.packages.map((p) => `${p.nickname}=${p.status}`).join("  "));
}
if (liveFailed) console.error(`${liveFailed} of ${liveTotal} live lookups failed.`);
