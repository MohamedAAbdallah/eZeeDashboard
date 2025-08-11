import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "client")));

app.get("/", async (req, res) => {
  try {
    res.json({ status: "Server is running." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});

// Helpers
const timeoutMs = (Number(process.env.CACHE_TIMEOUT) || 0) * 1000;
const todayISOcairo = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }); // YYYY-MM-DD

const getDayParam = (req) => {
  const d = (req.query.day || "").toString().trim();
  // minimal guard: expect YYYY-MM-DD; fallback to Cairo "today"
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayISOcairo();
};

const getMonthParam = (req) => {
  const m = (req.query.month || "").toString().trim();
  // Expect YYYY-MM; fallback to Cairo "today" month
  if (/^\d{4}-\d{2}$/.test(m)) return m;
  const today = todayISOcairo(); // YYYY-MM-DD
  return today.slice(0, 7); // YYYY-MM
};

// ---- simple cache (per-day) ----
const cachePath = path.join(__dirname, "cache.json");
function readCache() {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { byDay: {} };
  }
}
function writeCache(obj) {
  try {
    fs.writeFileSync(cachePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("[cache] write failed:", e.message);
  }
}

// ---- Booking List (working endpoint from test.js) ----
// GET  [LIST_BASE]/booking/reservation_api/listing.php? + params
async function fetchBookingListDay(day) {
  // cache hit?
  const store = readCache();
  const hit = store.byDay?.[day];
  if (hit && hit.timestamp && Date.now() - hit.timestamp < timeoutMs) {
    console.log(`[cache] hit for ${day}`);
    return hit.data;
  }

  console.log(`[fetch] BookingList for ${day}`);
  const base = process.env.LIST_BASE || "https://live.ipms247.com/";
  const url = new URL("booking/reservation_api/listing.php", base);
  url.searchParams.set("request_type", "BookingList");
  url.searchParams.set("HotelCode", process.env.HOTEL_CODE || "");
  url.searchParams.set(
    "APIKey",
    process.env.API_KEY || process.env.AUTH_CODE || ""
  );
  url.searchParams.set("arrival_from", day);
  url.searchParams.set("arrival_to", day);
  url.searchParams.set("EmailId", ""); // per docs can be empty for “all”

  const r = await fetch(url.toString(), { method: "GET" });
  const text = await r.text();
  if (!r.ok) {
    console.error("[fetch] vendor error:", text.slice(0, 200));
    throw new Error(`Upstream error (${r.status}): ${r.statusText}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error("[fetch] invalid JSON from vendor");
    throw new Error("Invalid JSON response from vendor");
  }

  // store cache
  store.byDay = store.byDay || {};
  store.byDay[day] = { timestamp: Date.now(), data };
  writeCache(store);

  return data; // return fresh payload
}

// Core daily computation
function computeDailyStats(data, day) {
  const list = Array.isArray(data?.BookingList) ? data.BookingList : [];

  let reservationCount = 0;
  let revenue = 0;
  let nights = 0;
  let ADR = 0;
  let cancelationCount = 0;

  const sources = {};
  const nationalities = {};

  for (const b of list) {
    // filter for the selected day (arrival-based)
    const arrival = (b?.ArrivalDate || "").trim();
    if (arrival !== day) continue;

    reservationCount += 1;

    const nNights = Number(b?.NoOfNights) || 0;
    nights += nNights;

    // Booking List doesn’t expose nightly rent consistently;
    // use DueAmount as a simple, consistent proxy here.
    const due = Number(b?.DueAmount) || 0;
    revenue += due;

    const sKey = (b?.Source || "unknown").toString().trim() || "unknown";
    const nKey =
      (b?.Country || b?.Nationality || "unknown").toString().trim() ||
      "unknown";

    if (!sources[sKey]) {
      sources[sKey] = { reservationCount: 0, revenue: 0, nights: 0, ADR: 0 };
    }
    if (!nationalities[nKey]) {
      nationalities[nKey] = {
        reservationCount: 0,
        revenue: 0,
        nights: 0,
        ADR: 0,
      };
    }

    sources[sKey].reservationCount += 1;
    sources[sKey].revenue += due;
    sources[sKey].nights += nNights;

    nationalities[nKey].reservationCount += 1;
    nationalities[nKey].revenue += due;
    nationalities[nKey].nights += nNights;

    if ((b?.CancelDate || "").trim()) cancelationCount += 1;
  }

  ADR = nights === 0 ? 0 : revenue / nights;

  // ADR per group
  for (const k in sources) {
    const s = sources[k];
    s.ADR = s.nights === 0 ? 0 : s.revenue / s.nights;
  }
  for (const k in nationalities) {
    const n = nationalities[k];
    n.ADR = n.nights === 0 ? 0 : n.revenue / n.nights;
  }

  return {
    stats: {
      all: {
        Day: day,
        Reservations: reservationCount,
        Revenue: revenue,
        Nights: nights,
        ADR: ADR,
        Cancellations: cancelationCount,
      },
      sources,
      nationalities,
    },
  };
}

// Temporarily IGNORED. I will fix this after the new API tests
function computeMonthlyCalendar(data, month) {
  // month: "YYYY-MM"
  const Reservations = data?.Reservations || {};
  const Reservation = Array.isArray(Reservations?.Reservation)
    ? Reservations.Reservation
    : [];

  const [Y, M] = month.split("-").map((v) => Number(v));
  const daysInMonth = new Date(Y, M, 0).getDate(); // JS month is 1-based here because we pass M directly
  const monthPrefix = month + "-"; // e.g., "2025-08-"

  // Calendar: rooms[roomTypeCode] = { code, name, days: [{booked:boolean, rent:number}], totals:{nights,revenue} }
  const rooms = {};
  // Totals per day across all room types
  const totalsByDay = Array.from({ length: daysInMonth }, (_, i) => ({
    day: i + 1,
    revenue: 0,
    nights: 0,
  }));

  for (const r of Reservation) {
    const trans = Array.isArray(r?.BookingTran) ? r.BookingTran : [];
    for (const b of trans) {
      const rental = Array.isArray(b?.RentalInfo) ? b.RentalInfo : [];
      for (const ri of rental) {
        const eff = (ri?.EffectiveDate || "").trim();
        if (!eff.startsWith(monthPrefix)) continue;

        const code = ri?.RoomTypeCode || b?.RoomTypeCode || "unknown";
        const name = ri?.RoomTypeName || b?.RoomTypeName || "Unknown Room Type";
        if (!rooms[code]) {
          rooms[code] = {
            code,
            name,
            days: Array.from({ length: daysInMonth }, () => ({
              booked: false,
              rent: 0,
            })),
            totals: { nights: 0, revenue: 0 },
          };
        }

        // Day index (1..N -> 0..N-1)
        const dnum = Number(eff.slice(8, 10));
        if (!Number.isFinite(dnum) || dnum < 1 || dnum > daysInMonth) continue;

        const rent = Number(ri?.Rent) || 0;

        // mark day for this room type
        const cell = rooms[code].days[dnum - 1];
        cell.booked = true;
        cell.rent += rent;

        rooms[code].totals.nights += 1;
        rooms[code].totals.revenue += rent;

        totalsByDay[dnum - 1].nights += 1;
        totalsByDay[dnum - 1].revenue += rent;
      }
    }
  }

  // Overall summary
  const summary = {
    month,
    daysInMonth,
    totalRooms: Object.keys(rooms).length,
    totalNights: totalsByDay.reduce((s, d) => s + d.nights, 0),
    totalRevenue: totalsByDay.reduce((s, d) => s + d.revenue, 0),
  };

  return { summary, calendar: { rooms, totalsByDay } };
}

// -------- Routes --------

// Daily stats endpoint now backed by Booking List new API
app.get("/api/stats", async (req, res) => {
  try {
    const day = getDayParam(req);
    const data = await fetchBookingListDay(day);
    const result = computeDailyStats(data, day);
    console.log(
      `[stats] ${day} → R:${result.stats.all.Reservations} N:${
        result.stats.all.Nights
      } $:${result.stats.all.Revenue.toFixed(2)}`
    );
    res.json(result);
  } catch (e) {
    console.error("[stats] error:", e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Report endpoint (kept as-is to preserve history)
app.get("/api/report", async (req, res) => {
  try {
    // still using legacy path; left untouched to keep diff tiny
    const day = getDayParam(req);
    const data = await fetchBookingListDay(day); // safest fallback so it doesn’t explode
    if (req.query.month) {
      const month = getMonthParam(req);
      const result = computeMonthlyCalendar(data, month);
      return res.json({ report: result });
    }
    const result = computeDailyStats(data, day);
    return res.json({ report: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(process.env.PORT || 5174, () =>
  console.log(`Server running on http://localhost:${process.env.PORT || 5174}`)
);
