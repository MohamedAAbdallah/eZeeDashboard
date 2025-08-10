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

async function fetchData() {
  // 1) Try cache
  try {
    const raw = fs.readFileSync("./cache.json", "utf-8");
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

app.get("/api", async (req, res) => {
  try {
    const data = await fetchData();
    if (!data) {
      console.log(`Data | ${data}`);
      return res.status(500).json({ error: "Failed to fetch data" });
    }

    const Reservations = data.Reservations || {};
    const Reservation = Array.isArray(Reservations?.Reservation)
      ? Reservations.Reservation
      : [];
    const CancelReservation = Array.isArray(Reservations?.CancelReservation)
      ? Reservations.CancelReservation
      : [];

    const noReservationFound = Reservation.length < 1;
    const noCancellationFound = CancelReservation.length < 1;

    let reservationCount = 0;
    let revenue = 0;
    let nights = 0;
    let ADR = 0;
    let cancelationCount = 0;

    /** groupings */
    const sources = {};
    const nationalities = {};

    if (!noReservationFound) {
      for (const r of Reservation) {
        const trans = Array.isArray(r?.BookingTran) ? r.BookingTran : [];
        for (const b of trans) {
          reservationCount += 1;
          revenue += Number(b?.TotalAmountBeforeTax) || 0;
          nights += Array.isArray(b?.RentalInfo) ? b.RentalInfo.length : 0;

          // Source grouping
          const sourceKey = normKey(b?.Source);
          if (!sources[sourceKey]) {
            sources[sourceKey] = {
              reservationCount: 0,
              revenue: 0,
              nights: 0,
              ADR: 0,
            };
          }
          sources[sourceKey].reservationCount += 1;
          sources[sourceKey].revenue += Number(b?.TotalAmountBeforeTax) || 0;
          sources[sourceKey].nights += Array.isArray(b?.RentalInfo)
            ? b.RentalInfo.length
            : 0;

          // Nationality grouping
          const natKey = normKey(b?.Nationality);
          if (!nationalities[natKey]) {
            nationalities[natKey] = {
              reservationCount: 0,
              revenue: 0,
              nights: 0,
              ADR: 0,
            };
          }
          nationalities[natKey].reservationCount += 1;
          nationalities[natKey].revenue += Number(b?.TotalAmountBeforeTax) || 0;
          nationalities[natKey].nights += Array.isArray(b?.RentalInfo)
            ? b.RentalInfo.length
            : 0;
        }
      }

      ADR = nights === 0 ? 0 : revenue / nights;

      // compute ADR per source/nationality (same definition you used)
      for (const k in sources) {
        const s = sources[k];
        s.ADR = s.nights === 0 ? 0 : s.revenue / s.nights;
      }
      for (const k in nationalities) {
        const n = nationalities[k];
        n.ADR = n.nights === 0 ? 0 : n.revenue / n.nights;
      }
    }

    if (!noCancellationFound) {
      const today = todayISOcairo();
      for (const c of CancelReservation) {
        const cancelDate = (c?.Canceldatetime || "").split(" ")[0];
        if (cancelDate === today) {
          cancelationCount += 1;
        }
      }
    }

    res.json({
      stats: {
        all: {
          Reservations: reservationCount,
          Revenue: revenue,
          Nights: nights,
          ADR: ADR,
          Cancellations: cancelationCount,
        },
        sources: sources,
        nationalities: nationalities,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(process.env.PORT || 5174, () =>
  console.log(`Server running on http://localhost:${process.env.PORT || 5174}`)
);
