import "dotenv/config";
import fetch from "node-fetch";
import express from "express";

const app = express();

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

app.listen(process.env.PORT, () => {
  console.log("Server listening");
});
