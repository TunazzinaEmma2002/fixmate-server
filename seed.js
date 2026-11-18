// Run AFTER you registered these 4 accounts on the site:  node seed.js
// It gives them roles, adds 14 approved services, and some bookings in different statuses.
if (process.env.NODE_ENV !== "production") {
  require("node:dns/promises").setServers(["8.8.8.8", "1.1.1.1"]);
}
require("dotenv").config();
const { MongoClient } = require("mongodb");

const ADMIN = "admin@fixmate.com";
const TECH1 = "tech1@fixmate.com";
const TECH2 = "tech2@fixmate.com";
const CUSTOMER = "customer@fixmate.com";

const img = (seed) => `https://picsum.photos/seed/${seed}/900/600`;
const services = [
  ["iPhone Screen Replacement", "Smartphone", 85, "2-3 hours", "Home Visit", "Mirpur, Dhaka", "Genuine-quality display replacement for iPhone 11 to 15 with a 3 month warranty. We test touch, True Tone and Face ID before handing it back.", TECH1],
  ["Android Battery & Charging Port Fix", "Smartphone", 35, "1-2 hours", "Shop Drop-off", "Dhanmondi, Dhaka", "New battery or charging port for Samsung, Xiaomi and Oppo phones. Same day service in most cases.", TECH2],
  ["Laptop Full Service & Thermal Paste", "Laptop & PC", 45, "3-4 hours", "Shop Drop-off", "Uttara, Dhaka", "Deep cleaning of fans and vents, fresh thermal paste and a full health check to stop overheating and noise.", TECH1],
  ["Laptop SSD Upgrade & Windows Setup", "Laptop & PC", 60, "2 hours", "Home Visit", "Gulshan, Dhaka", "Swap a slow hard drive for a fast SSD, clone your data and install a clean Windows with all drivers.", TECH2],
  ["Desktop PC Troubleshooting", "Laptop & PC", 30, "1-2 hours", "Home Visit", "Banani, Dhaka", "Boot problems, blue screens, slow performance and virus removal for home and office desktops.", TECH1],
  ["Split AC Gas Refill", "AC", 55, "1-2 hours", "Home Visit", "Mirpur, Dhaka", "Leak check and gas refill for 1 to 2 ton split air conditioners, including pressure test and cooling report.", TECH2],
  ["AC Deep Cleaning & Servicing", "AC", 40, "2 hours", "Home Visit", "Dhanmondi, Dhaka", "Indoor and outdoor unit wash, filter cleaning and drain check so your AC cools faster and uses less power.", TECH1],
  ["Refrigerator Cooling Repair", "Refrigerator", 70, "3-4 hours", "Home Visit", "Uttara, Dhaka", "Fix weak cooling, ice build up and strange noises in single door and double door refrigerators.", TECH2],
  ["Fridge Compressor Replacement", "Refrigerator", 120, "1 day", "Shop Drop-off", "Mohammadpur, Dhaka", "Compressor and relay replacement with a 6 month warranty on the new part.", TECH1],
  ["LED TV Backlight Repair", "TV", 65, "1 day", "Shop Drop-off", "Gulshan, Dhaka", "Fix dark screens and dim pictures on LED and smart TVs by replacing the backlight strips.", TECH2],
  ["Smart TV Software & Panel Check", "TV", 25, "1 hour", "Home Visit", "Banani, Dhaka", "Apps crashing, no WiFi or no sound? We reset, update and check the main board at your home.", TECH1],
  ["Washing Machine Drain & Motor Fix", "Washing Machine", 50, "2-3 hours", "Home Visit", "Mirpur, Dhaka", "Water not draining, drum not spinning or loud noises. We repair top load and front load machines.", TECH2],
  ["Home Electrical Wiring Check", "Electrical", 40, "2 hours", "Home Visit", "Dhanmondi, Dhaka", "Safety inspection of switches, sockets and the main board. We fix sparks, tripping and loose wires.", TECH1],
  ["Ceiling Fan & Light Installation", "Electrical", 20, "1 hour", "Home Visit", "Uttara, Dhaka", "Quick and tidy installation of ceiling fans, lights and regulators with clean cable work.", TECH2],
];

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db("fixmate");
  const users = db.collection("user");
  const servicesCol = db.collection("services");
  const bookingsCol = db.collection("bookings");
  const paymentsCol = db.collection("payments");

  const roles = [[ADMIN, "admin"], [TECH1, "technician"], [TECH2, "technician"], [CUSTOMER, "customer"]];
  for (const [email, role] of roles) {
    const user = await users.findOne({ email });
    if (!user) {
      console.log(`Missing account ${email}. Register it on the site first, then run this again.`);
      await client.close();
      process.exit(1);
    }
    await users.updateOne({ email }, { $set: { role } });
  }
  const tech = { [TECH1]: await users.findOne({ email: TECH1 }), [TECH2]: await users.findOne({ email: TECH2 }) };
  await users.updateOne({ email: TECH1 }, { $set: { area: "Mirpur, Dhaka", bio: "Phone, laptop and AC specialist with 8 years of experience." } });
  await users.updateOne({ email: TECH2 }, { $set: { area: "Dhanmondi, Dhaka", bio: "Home appliance and electrical technician. Fast and tidy work." } });
  const cus = await users.findOne({ email: CUSTOMER });

  let added = 0;
  const saved = [];
  for (const [i, s] of services.entries()) {
    const [title, category, basePrice, estimatedDuration, serviceMode, serviceArea, description, owner] = s;
    let doc = await servicesCol.findOne({ title });
    if (!doc) {
      doc = {
        title, category, description, image: img(`fixmate${i + 1}`), basePrice, estimatedDuration, serviceMode, serviceArea,
        technicianName: tech[owner].name, technicianEmail: owner, approvalStatus: "approved", isAvailable: true,
        createdAt: new Date(Date.now() - i * 3600 * 1000),
      };
      const r = await servicesCol.insertOne(doc);
      doc._id = r.insertedId;
      added++;
    }
    saved.push(doc);
  }

  // bookings in every status (only once)
  let bookingsAdded = 0;
  if ((await bookingsCol.countDocuments({ customerEmail: CUSTOMER })) === 0) {
    const plan = [
      [0, "completed", "paid"], [2, "completed", "unpaid"], [6, "in-progress", "unpaid"], [4, "accepted", "unpaid"],
      [10, "requested", "unpaid"], [8, "rejected", "unpaid"], [12, "cancelled", "unpaid"],
    ];
    const problems = [
      "The screen is cracked after a fall and the touch is not working properly.",
      "The laptop gets very hot and the fan is making a loud noise all day.",
      "The AC is on but the room does not cool down like before.",
      "The desktop restarts again and again when I open heavy programs.",
      "The smart TV shows no picture, only sound comes from the speakers.",
      "The compressor makes a clicking sound and then the fridge stops cooling.",
      "A switch in the bedroom sparks every time I turn on the light.",
    ];
    const flow = { requested: ["requested"], accepted: ["requested", "accepted"], "in-progress": ["requested", "accepted", "in-progress"], completed: ["requested", "accepted", "in-progress", "completed"], rejected: ["requested", "rejected"], cancelled: ["requested", "cancelled"] };
    for (const [n, [idx, status, pay]] of plan.entries()) {
      const s = saved[idx];
      const finalAmount = status === "completed" ? s.basePrice + 5 : s.basePrice;
      const day = new Date(Date.now() - (7 - n) * 86400000);
      const booking = {
        serviceId: String(s._id), serviceTitle: s.title, serviceImage: s.image, category: s.category, basePrice: s.basePrice,
        technicianName: s.technicianName, technicianEmail: s.technicianEmail, customerName: cus.name, customerEmail: CUSTOMER,
        customerPhone: "01712345678", address: "House 12, Road 5, Mirpur, Dhaka", preferredDate: new Date(Date.now() + (n + 1) * 86400000),
        problemDescription: problems[n], status, finalAmount, paymentStatus: pay,
        statusHistory: flow[status].map((st, k) => ({ status: st, changedAt: new Date(day.getTime() + k * 3600000) })),
        createdAt: day,
      };
      const r = await bookingsCol.insertOne(booking);
      bookingsAdded++;
      if (pay === "paid") {
        await paymentsCol.insertOne({
          bookingId: String(r.insertedId), serviceTitle: s.title, customerName: cus.name, customerEmail: CUSTOMER,
          technicianName: s.technicianName, technicianEmail: s.technicianEmail, amount: finalAmount, currency: "usd",
          transactionId: "pi_seed_demo_001", stripeSessionId: "cs_seed_demo_001", paymentStatus: "paid", paidAt: new Date(),
        });
      }
    }
  }
  console.log(`Roles set. Added ${added} service(s) and ${bookingsAdded} booking(s).`);
  await client.close();
}
main().catch((e) => { console.error(e); process.exit(1); });