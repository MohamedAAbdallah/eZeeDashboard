import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

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

app.get("/api", async (req, res) => {
  try {
    const r = await fetch(process.env.END_POINT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
      console.error("VENDOR API Error Details:", data);
      return res.status(r.status).json({
        error: "Upstream error",
        status: r.status,
        details: data,
      });
    }

    const data = await r.json();

    const Reservations = data.Reservations;

    const Reservation = Reservations.Reservation;
    const CancelReservation = Reservations.CancelReservation;

    const noReservationFound =
      !Reservation || (Array.isArray(Reservation) && Reservation.length < 1);
    let reservationCount = 0;
    let revenue = 0;
    let nights = 0;
    let ADR = 0;

    if (!noReservationFound) {
      for (const r of Reservation) {
        for (const b of r.BookingTran) {
          reservationCount += 1;
          revenue += parseFloat(Number(b.TotalAmountBeforeTax) || 0);
          nights += b.RentalInfo.length;
        }
      }
      if (nights === 0) {
        ADR = 0;
      } else {
        ADR = revenue / nights;
      }
    }

    const body = {
      Reservations: reservationCount,
      Revenue: revenue,
      Nights: nights,
      ADR: ADR,
    };

    res.json(body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 5174, () =>
  console.log(`Server running on http://localhost:${process.env.PORT || 5174}`)
);
