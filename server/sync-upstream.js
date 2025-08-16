import "dotenv/config";
import fetch from "node-fetch";
import express from "express";

const app = express();
// Helpers
function parse_date(date) {
  if (typeof date !== "string") throw new TypeError("Invalid date format");
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

async function fetch_data(arrival_from, arrival_to) {
  console.log(`[fetch] BookingList from ${arrival_from} to ${arrival_to}`);
  const url = new URL(
    "https://live.ipms247.com/booking/reservation_api/listing.php"
  );
  url.searchParams.set("request_type", "BookingList");
  url.searchParams.set("HotelCode", process.env.HOTEL_CODE);
  url.searchParams.set("APIKey", process.env.API_KEY || process.env.AUTH_CODE);
  url.searchParams.set("arrival_from", arrival_from);
  url.searchParams.set("arrival_to", arrival_to);
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
  return data;
}

app.get("/", async (req, res) => {
  const data = await fetch_data("2025-08-01", "2025-8-16");
  let data_processed = {};
  let reservation = {};

  for (let n of data.BookingList) {
    reservation = {
      ReservationNo: n.ReservationNo,
      ReservationDate: n.ReservationDate,

      ArrivalDate: n.ArrivalDate,
      DepartureDate: n.DepartureDate,
      CancelDate: n.CancelDate,

      RoomNo: n.RoomNo,
      Source: n.Source,

      Nights: n.NoOfNights,
      Revenue: n.TotalExclusivTax,
    };

    const { year, month, day } = parse_date(reservation.ReservationDate);

    if (!data_processed[year]) {
      data_processed[year] = {};
    }
    if (!data_processed[year][month]) {
      data_processed[year][month] = {};
    }
    if (!data_processed[year][month][day]) {
      data_processed[year][month][day] = {
        ReservationCount: -1,
        Revenue: -1,
        Nights: -1,
        ADR: -1,
        Canceled: -1,
        CanceledNights: -1,
        ReservationsList: [],
        CanceledList: [],
      };
    }

    if (reservation.CancelDate === "") {
      data_processed[year][month][day].ReservationsList.push(reservation);
    } else {
      data_processed[year][month][day].CanceledList.push(reservation);
    }
  }

  for (let year of Object.keys(data_processed)) {
    for (let month of Object.keys(data_processed[year])) {
      for (let day of Object.keys(data_processed[year][month])) {
        const entry = data_processed[year][month][day];

        entry.ReservationCount = entry.ReservationsList.length;
        entry.Revenue = 0;
        entry.Nights = 0;

        for (let reservation of entry.ReservationsList) {
          entry.Revenue += reservation.Revenue;
          entry.Nights += reservation.Nights;
        }

        entry.ADR = entry.Revenue / entry.Nights || 0;

        entry.Canceled = entry.CanceledList.length;
        entry.CanceledNights = 0;

        for (let canceled_reservation of entry.CanceledList) {
          entry.CanceledNights += canceled_reservation.Nights;
        }
      }
    }
  }

  // TODO: save data to disk

  res.json(data_processed);
});

app.listen(process.env.PORT, () => {
  console.log("Server listening");
});
