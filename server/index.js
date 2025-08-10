import "dotenv/config";
import express from "express";
import fetch from "node-fetch";

const app = express();

app.get("/", async (req, res) => {
  try {
    res.json({ status: "Server is running." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/test", async (req, res) => {
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
      const errorData = await r.json();
      console.error("VENDOR API Error Details:", errorData);
      throw new Error(`VENDOR API Error! status: ${r.status} ${errorData.message}`);
    }

    const data = await r.json();

    const Reservations = data.Reservations;

    const Reservation = Reservations.Reservation;
    const CancelReservation = Reservations.CancelReservation;

    let reservationCount = 0;
    let revenue = 0;
    let nights = 0;

    for (const r of Reservation) {
      for (const b of r.BookingTran) {
        reservationCount += 1;
        revenue += parseFloat(b.TotalAmountBeforeTax);
        nights += b.RentalInfo.length;
      }
    }

    const ADR = revenue / nights;

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
  console.log(`Server running on https://localhost:${process.env.port || 5174}`)
);
