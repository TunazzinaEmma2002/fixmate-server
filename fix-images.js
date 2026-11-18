// Run once: node fix-images.js  -> gives every service a matching cartoon image by category
require("dotenv").config();
const { setServers } = require("node:dns/promises");
const { MongoClient } = require("mongodb");
try { setServers(["8.8.8.8", "1.1.1.1"]); } catch {}

const MAP = {
  "Smartphone": "/services/smartphone.svg",
  "Laptop & PC": "/services/laptop.svg",
  "AC": "/services/ac.svg",
  "Refrigerator": "/services/refrigerator.svg",
  "TV": "/services/tv.svg",
  "Washing Machine": "/services/washing-machine.svg",
  "Electrical": "/services/electrical.svg",
};

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const col = client.db("fixmate").collection("services");
  let n = 0;
  for (const [cat, image] of Object.entries(MAP)) {
    const r = await col.updateMany({ category: cat }, { $set: { image } });
    n += r.modifiedCount;
  }
  console.log("Updated images for", n, "service(s).");
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
