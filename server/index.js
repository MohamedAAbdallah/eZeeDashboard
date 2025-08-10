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
    const data = await r.json();
    // To Be Played With
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 5174, () =>
  console.log(`Server running on https://localhost:${process.env.port || 5174}`)
);
