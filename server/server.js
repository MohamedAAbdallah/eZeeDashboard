import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());

app.get("/", async (req, res) => {
  try {
    res.json({ status: "Server is running." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Helpers
const timeoutMs = (Number(process.env.CACHE_TIMEOUT) || 0) * 1000;
const normKey = (v) => {
  if (typeof v !== "string") return "unknown";
  const t = v.trim();
  return t ? t.toLowerCase() : "unknown";
};
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

async function fetchData() {
  // 1) Try cache
  try {
    const raw = fs.readFileSync("./server/cache.json", "utf-8");
    if (raw) {
      try {
        const cacheObj = JSON.parse(raw);
        if (cacheObj.timestamp && Date.now() - cacheObj.timestamp < timeoutMs) {
          console.log(
            `Used Cache ts=${cacheObj.timestamp} now=${Date.now()} diff=${
              Date.now() - cacheObj.timestamp
            }`
          );
          return cacheObj.data; // return cached payload
        }
      } catch (e) {
        console.warn("Error parsing cache:", e);
      }
    }
  } catch (e) {
    // this is expected for dry runs.
    console.warn("Error reading cache:", e);
  }

  // 2) Fetch upstream
  const r = await fetch(process.env.END_POINT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RES_Request: {
        Request_Type: "Bookings",
        Authentication: {
          HotelCode: process.env.HOTEL_CODE,
          AuthCode: process.env.AUTH_CODE,
        },
      },
    }),
  });

  if (!r.ok) {
    // FUTURE_TODO: Implement cache fallback if no upstream
    //             Use CACHE_ERROR_TIMEOUT to determine fallback duration
    const errorText = await r.text().catch(() => "");
    console.error("VENDOR API Error Details:", errorText);
    throw new Error(
      `Upstream error (${r.status}): ${errorText || r.statusText}`
    );
  }

  const data = await r.json();

  // 3) Write cache (fire-and-forget)
  try {
    const cacheObj = { timestamp: Date.now(), data };
    console.log(`Updated Cache: ${cacheObj.timestamp}`);
    fs.writeFile("./cache.json", JSON.stringify(cacheObj), (err) => {
      if (err) console.error("Error writing cache to disk:", err);
    });
  } catch (e) {
    console.error("Error scheduling cache write:", e);
  }

  return data; // return fresh payload
}

// Core daily computation
function computeDailyStats(data, day) {
  const Reservations = data?.Reservations || {};
  const Reservation = Array.isArray(Reservations?.Reservation)
    ? Reservations.Reservation
    : [];
  const CancelReservation = Array.isArray(Reservations?.CancelReservation)
    ? Reservations.CancelReservation
    : [];

  let reservationCount = 0;
  let revenue = 0;
  let nights = 0;
  let ADR = 0;
  let cancelationCount = 0;

  const sources = {};
  const nationalities = {};

  // Bookings (per-day)
  for (const r of Reservation) {
    const trans = Array.isArray(r?.BookingTran) ? r.BookingTran : [];
    for (const b of trans) {
      const rental = Array.isArray(b?.RentalInfo) ? b.RentalInfo : [];
      let hadDayRow = false;

      for (const ri of rental) {
        if ((ri?.EffectiveDate || "").trim() === day) {
          hadDayRow = true;
          const rent = Number(ri?.Rent) || 0;
          revenue += rent;
          nights += 1;

          // groupings by Source/Nationality for the same day
          const sourceKey = normKey(b?.Source);
          if (!sources[sourceKey]) {
            sources[sourceKey] = {
              reservationCount: 0,
              revenue: 0,
              nights: 0,
              ADR: 0,
            };
          }
          sources[sourceKey].revenue += rent;
          sources[sourceKey].nights += 1;

          const natKey = normKey(b?.Nationality);
          if (!nationalities[natKey]) {
            nationalities[natKey] = {
              reservationCount: 0,
              revenue: 0,
              nights: 0,
              ADR: 0,
            };
          }
          nationalities[natKey].revenue += rent;
          nationalities[natKey].nights += 1;
        }
      }

      if (hadDayRow) {
        reservationCount += 1;

        // count booking once per source/nationality if it had any row that day
        const sourceKey = normKey(b?.Source);
        sources[sourceKey].reservationCount += 1;

        const natKey = normKey(b?.Nationality);
        nationalities[natKey].reservationCount += 1;
      }
    }
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

  // Cancellations for that exact day (Cairo)
  for (const c of CancelReservation) {
    const cancelDate = (c?.Canceldatetime || "").split(" ")[0];
    if (cancelDate === day) cancelationCount += 1;
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

// -------- Monthly calendar (new) --------
// Assumption: API exposes room *types*, not physical room numbers.
// We build a calendar per RoomTypeCode/Name and mark which days have rent rows.
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

// Daily stats endpoint (kept)
app.get("/api/stats", async (req, res) => {
  try {
    const day = getDayParam(req);
    const data = await fetchData();
    if (!data) return res.status(500).json({ error: "Failed to fetch data" });
    const result = computeDailyStats(data, day);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Report endpoint: if ?month is present -> monthly calendar; else -> daily (groundwork for richer reports)
app.get("/api/report", async (req, res) => {
  try {
    const data = await fetchData();
    if (!data) return res.status(500).json({ error: "Failed to fetch data" });

    if (req.query.month) {
      const month = getMonthParam(req); // YYYY-MM
      const result = computeMonthlyCalendar(data, month);
      return res.json({ report: result });
    }

    // fallback to daily report if "day" provided or missing (defaults to today)
    const day = getDayParam(req);
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
