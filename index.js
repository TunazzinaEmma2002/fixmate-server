// Some ISPs block SRV lookups for mongodb+srv:// links, so use Google DNS on localhost
if (process.env.NODE_ENV !== "production") {
  require("node:dns/promises").setServers(["8.8.8.8", "1.1.1.1"]);
}
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;
const isProd = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = "token";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const cookieOptions = { httpOnly: true, secure: isProd, sameSite: "lax", path: "/" };

if (!JWT_SECRET) console.error("JWT_SECRET is missing in .env");

// ---------- database ----------
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});
const db = client.db("fixmate");
// BetterAuth stores its users in the "user" collection, we treat it as our users collection
const usersCol = db.collection("user");
const servicesCol = db.collection("services");
const bookingsCol = db.collection("bookings");
const paymentsCol = db.collection("payments");

// Connect lazily and retry on the next request if a cold start fails (important on Vercel)
let connecting = null;
function ensureConnected() {
  if (!connecting) {
    connecting = client.connect().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

// ---------- middlewares ----------
// STRIPE_WEBHOOK_HERE (the raw-body webhook route goes above express.json)
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = (process.env.CLIENT_URL || "").split(",").map((s) => s.trim());
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(async (req, res, next) => {
  try {
    await ensureConnected();
    next();
  } catch (err) {
    next(err);
  }
});

// Challenge 2, step 1: valid JWT cookie -> 401 if missing or invalid
async function verifyToken(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).send({ message: "Unauthorized: please sign in first" });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== "session") throw new Error("wrong token type");
  } catch {
    return res.status(401).send({ message: "Unauthorized: your session is invalid or expired" });
  }
  // the role is always read from the database, never trusted from the client
  const user = await usersCol.findOne({ email: payload.email });
  if (!user) return res.status(401).send({ message: "Unauthorized: account not found" });
  req.user = {
    email: user.email,
    name: user.name,
    image: user.image || "",
    role: user.role || "customer",
  };
  next();
}

// Challenge 2, step 2: right role -> 403 if not
const requireRole = (role) => (req, res, next) => {
  if (req.user?.role !== role) {
    return res.status(403).send({ message: `Forbidden: only a ${role} can do this` });
  }
  next();
};
const verifyCustomer = requireRole("customer");
const verifyTechnician = requireRole("technician");
const verifyAdmin = requireRole("admin");

// ---------- helpers ----------
const toId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- basic + auth ----------
app.get("/", (req, res) => res.send("FixMate server is running"));

// The Next.js app signs a short-lived proof after BetterAuth login.
// We verify it and set our own JWT in an HTTPOnly cookie.
app.post("/jwt", async (req, res) => {
  try {
    const proof = jwt.verify(req.body?.proof, JWT_SECRET, { audience: "fixmate-server" });
    if (proof.type !== "proof" || !proof.email) throw new Error("bad proof");
    const token = jwt.sign({ type: "session", email: proof.email }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: WEEK });
    res.send({ success: true });
  } catch {
    res.status(401).send({ message: "Invalid login proof" });
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions);
  res.send({ success: true });
});

app.get("/api/me", verifyToken, (req, res) => res.send(req.user));

// ---------- constants + validation ----------
const CATEGORIES = ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"];
const MODES = ["Home Visit", "Shop Drop-off"];
const ACTIVE = ["requested", "accepted", "in-progress"];
// Challenge 3: the only moves the server allows
const NEXT_STATUS = {
  requested: ["accepted", "rejected"],
  accepted: ["in-progress"],
  "in-progress": ["completed"],
};
const publicFilter = { approvalStatus: "approved", isAvailable: true };
const historyEntry = (status) => ({ status, changedAt: new Date() });

function pickService(body = {}) {
  return {
    title: String(body.title || "").trim(),
    category: String(body.category || "").trim(),
    description: String(body.description || "").trim(),
    image: String(body.image || "").trim(),
    basePrice: Number(body.basePrice),
    estimatedDuration: String(body.estimatedDuration || "").trim(),
    serviceMode: String(body.serviceMode || "").trim(),
    serviceArea: String(body.serviceArea || "").trim(),
  };
}

function serviceError(s) {
  if (!s.title || !s.description || !s.image || !s.estimatedDuration || !s.serviceArea) {
    return "Title, description, image, duration and service area are required";
  }
  if (!CATEGORIES.includes(s.category)) return "Please choose a valid category";
  if (!MODES.includes(s.serviceMode)) return "Please choose a valid service mode";
  if (!(s.basePrice > 0)) return "Base price must be greater than 0";
  return null;
}

const sumOf = (list, key) => Math.round(list.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) * 100) / 100;
const countBy = (list, key) => list.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});

// ---------- services ----------
// Challenge 1: search, filter and sort all happen in MongoDB
app.get("/api/services", async (req, res) => {
  const { search, category, serviceMode, sort, limit } = req.query;
  const query = { ...publicFilter };
  if (category) query.category = String(category);
  if (serviceMode) query.serviceMode = String(serviceMode);
  if (search) {
    const rx = { $regex: escapeRegex(String(search).trim()), $options: "i" };
    query.$or = [{ title: rx }, { category: rx }];
  }
  const sorts = {
    "price-asc": { basePrice: 1 },
    "price-desc": { basePrice: -1 },
    newest: { createdAt: -1 },
  };
  let cursor = servicesCol.find(query).sort(sorts[sort] || sorts.newest);
  const max = Number(limit);
  if (max > 0) cursor = cursor.limit(Math.min(max, 50));
  res.send(await cursor.toArray());
});

app.get("/api/services/mine", verifyToken, verifyTechnician, async (req, res) => {
  const result = await servicesCol.find({ technicianEmail: req.user.email }).sort({ createdAt: -1 }).toArray();
  res.send(result);
});

app.get("/api/services/:id", async (req, res) => {
  const _id = toId(req.params.id);
  if (!_id) return res.status(404).send({ message: "Service not found" });
  const service = await servicesCol.findOne({ _id, ...publicFilter });
  if (!service) return res.status(404).send({ message: "Service not found" });
  const tech = await usersCol.findOne({ email: service.technicianEmail });
  res.send({
    ...service,
    technician: {
      name: tech?.name || service.technicianName,
      image: tech?.image || "",
      area: tech?.area || "",
      bio: tech?.bio || "",
    },
  });
});

app.post("/api/services", verifyToken, verifyTechnician, async (req, res) => {
  const data = pickService(req.body);
  const error = serviceError(data);
  if (error) return res.status(400).send({ message: error });
  const service = {
    ...data,
    technicianName: req.user.name, // always from the logged-in user, never from the form
    technicianEmail: req.user.email,
    approvalStatus: "pending",
    isAvailable: true,
    createdAt: new Date(),
  };
  const result = await servicesCol.insertOne(service);
  res.status(201).send(result);
});

app.patch("/api/services/:id", verifyToken, verifyTechnician, async (req, res) => {
  const _id = toId(req.params.id);
  if (!_id) return res.status(400).send({ message: "Invalid service id" });
  const service = await servicesCol.findOne({ _id });
  if (!service) return res.status(404).send({ message: "Service not found" });
  if (service.technicianEmail !== req.user.email) {
    return res.status(403).send({ message: "You can only change your own services" });
  }
  const body = req.body || {};
  // only the availability switch: do not send it back to admin approval
  if (Object.keys(body).length === 1 && typeof body.isAvailable === "boolean") {
    const result = await servicesCol.updateOne({ _id }, { $set: { isAvailable: body.isAvailable } });
    return res.send(result);
  }
  const data = pickService(body);
  const error = serviceError(data);
  if (error) return res.status(400).send({ message: error });
  // editing a service sends it back to the admin for approval
  const result = await servicesCol.updateOne(
    { _id },
    { $set: { ...data, approvalStatus: "pending", updatedAt: new Date() } }
  );
  res.send(result);
});

app.delete("/api/services/:id", verifyToken, verifyTechnician, async (req, res) => {
  const _id = toId(req.params.id);
  if (!_id) return res.status(400).send({ message: "Invalid service id" });
  const service = await servicesCol.findOne({ _id });
  if (!service) return res.status(404).send({ message: "Service not found" });
  if (service.technicianEmail !== req.user.email) {
    return res.status(403).send({ message: "You can only delete your own services" });
  }
  const result = await servicesCol.deleteOne({ _id });
  res.send(result);
});

// ---------- bookings ----------
app.post("/api/bookings", verifyToken, verifyCustomer, async (req, res) => {
  const { serviceId, customerPhone, address, preferredDate, problemDescription } = req.body || {};
  const _id = toId(serviceId);
  if (!_id) return res.status(400).send({ message: "Invalid service" });
  const phone = String(customerPhone || "").trim();
  const addr = String(address || "").trim();
  const problem = String(problemDescription || "").trim();
  if (!/^[0-9+\-\s]{7,20}$/.test(phone)) return res.status(400).send({ message: "Please enter a valid phone number" });
  if (addr.length < 5) return res.status(400).send({ message: "Please enter your full address" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(preferredDate || ""))) {
    return res.status(400).send({ message: "Please choose a valid date" });
  }
  // today or later (one day of slack so every timezone works)
  const earliest = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (preferredDate < earliest) return res.status(400).send({ message: "Preferred date must be today or later" });
  if (problem.length < 20) {
    return res.status(400).send({ message: "Please describe the problem in at least 20 characters" });
  }

  const service = await servicesCol.findOne({ _id, ...publicFilter });
  if (!service) return res.status(404).send({ message: "This service is not available" });
  if (service.technicianEmail === req.user.email) {
    return res.status(400).send({ message: "You cannot request your own service" });
  }
  const duplicate = await bookingsCol.findOne({
    serviceId: String(service._id),
    customerEmail: req.user.email,
    status: { $in: ACTIVE },
  });
  if (duplicate) {
    return res.status(409).send({ message: "You already have an active request for this service" });
  }

  const booking = {
    serviceId: String(service._id),
    serviceTitle: service.title,
    serviceImage: service.image,
    category: service.category,
    basePrice: service.basePrice,
    technicianName: service.technicianName,
    technicianEmail: service.technicianEmail,
    customerName: req.user.name,
    customerEmail: req.user.email,
    customerPhone: phone,
    address: addr,
    preferredDate: new Date(preferredDate),
    problemDescription: problem,
    status: "requested",
    finalAmount: service.basePrice,
    paymentStatus: "unpaid",
    statusHistory: [historyEntry("requested")],
    createdAt: new Date(),
  };
  const result = await bookingsCol.insertOne(booking);
  res.status(201).send(result);
});

app.get("/api/bookings/my", verifyToken, verifyCustomer, async (req, res) => {
  const result = await bookingsCol.find({ customerEmail: req.user.email }).sort({ createdAt: -1 }).toArray();
  res.send(result);
});

app.get("/api/bookings/technician", verifyToken, verifyTechnician, async (req, res) => {
  const query = { technicianEmail: req.user.email };
  if (req.query.status) query.status = String(req.query.status);
  const result = await bookingsCol.find(query).sort({ createdAt: -1 }).toArray();
  res.send(result);
});

app.patch("/api/bookings/:id/cancel", verifyToken, verifyCustomer, async (req, res) => {
  const _id = toId(req.params.id);
  if (!_id) return res.status(400).send({ message: "Invalid booking id" });
  const booking = await bookingsCol.findOne({ _id });
  if (!booking) return res.status(404).send({ message: "Booking not found" });
  if (booking.customerEmail !== req.user.email) {
    return res.status(403).send({ message: "You can only cancel your own bookings" });
  }
  if (booking.status !== "requested") {
    return res.status(400).send({ message: "Only a requested job can be cancelled" });
  }
  const result = await bookingsCol.updateOne(
    { _id },
    { $set: { status: "cancelled" }, $push: { statusHistory: historyEntry("cancelled") } }
  );
  res.send(result);
});

// Challenge 3: only the owner technician, only the allowed next step
app.patch("/api/bookings/:id/status", verifyToken, verifyTechnician, async (req, res) => {
  const _id = toId(req.params.id);
  if (!_id) return res.status(400).send({ message: "Invalid booking id" });
  const { status, finalAmount } = req.body || {};
  const booking = await bookingsCol.findOne({ _id });
  if (!booking) return res.status(404).send({ message: "Booking not found" });
  if (booking.technicianEmail !== req.user.email) {
    return res.status(403).send({ message: "Only the technician of this job can update it" });
  }
  const allowed = NEXT_STATUS[booking.status] || [];
  if (!allowed.includes(status)) {
    return res.status(400).send({ message: `A ${booking.status} job cannot be changed to ${status}` });
  }
  const set = { status };
  if (status === "completed") {
    const amount = Number(finalAmount);
    if (!(amount > 0)) return res.status(400).send({ message: "Final amount must be greater than 0" });
    set.finalAmount = Math.round(amount * 100) / 100;
  }
  const result = await bookingsCol.updateOne({ _id }, { $set: set, $push: { statusHistory: historyEntry(status) } });
  res.send(result);
});

// ---------- profile ----------
app.get("/api/users/profile", verifyToken, async (req, res) => {
  const user = await usersCol.findOne({ email: req.user.email });
  res.send({
    name: user.name,
    email: user.email,
    image: user.image || "",
    role: user.role || "customer",
    phone: user.phone || "",
    area: user.area || "",
    bio: user.bio || "",
  });
});

app.patch("/api/users/profile", verifyToken, async (req, res) => {
  const { name, phone, area, bio, image } = req.body || {};
  const set = {
    name: String(name || "").trim(),
    phone: String(phone || "").trim(),
    area: String(area || "").trim(),
    bio: String(bio || "").trim().slice(0, 300),
    updatedAt: new Date(),
  };
  if (set.name.length < 2) return res.status(400).send({ message: "Please enter your name" });
  if (typeof image === "string" && image.trim()) set.image = image.trim();
  const result = await usersCol.updateOne({ email: req.user.email }, { $set: set });
  res.send(result);
});

// ---------- admin ----------
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  const users = await usersCol.find({}).sort({ createdAt: -1 }).toArray();
  res.send(
    users.map((u) => ({
      _id: u._id,
      name: u.name,
      email: u.email,
      image: u.image || "",
      role: u.role || "customer",
      createdAt: u.createdAt,
    }))
  );
});

app.patch("/api/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  const _id = toId(req.params.id);
  const { role } = req.body || {};
  if (!_id) return res.status(400).send({ message: "Invalid user id" });
  if (!["customer", "technician", "admin"].includes(role)) {
    return res.status(400).send({ message: "Invalid role" });
  }
  const user = await usersCol.findOne({ _id });
  if (!user) return res.status(404).send({ message: "User not found" });
  if (user.email === req.user.email) {
    return res.status(400).send({ message: "You cannot change your own role" });
  }
  const result = await usersCol.updateOne({ _id }, { $set: { role } });
  res.send(result);
});

app.get("/api/admin/services", verifyToken, verifyAdmin, async (req, res) => {
  const query = {};
  if (req.query.approvalStatus) query.approvalStatus = String(req.query.approvalStatus);
  const result = await servicesCol.find(query).sort({ createdAt: -1 }).toArray();
  res.send(result);
});

app.patch("/api/admin/services/:id/approval", verifyToken, verifyAdmin, async (req, res) => {
  const _id = toId(req.params.id);
  const { approvalStatus } = req.body || {};
  if (!_id) return res.status(400).send({ message: "Invalid service id" });
  if (!["approved", "rejected"].includes(approvalStatus)) {
    return res.status(400).send({ message: "Approval status must be approved or rejected" });
  }
  const service = await servicesCol.findOne({ _id });
  if (!service) return res.status(404).send({ message: "Service not found" });
  const result = await servicesCol.updateOne({ _id }, { $set: { approvalStatus } });
  res.send(result);
});

app.get("/api/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  const query = {};
  if (req.query.status) query.status = String(req.query.status);
  const result = await bookingsCol.find(query).sort({ createdAt: -1 }).toArray();
  res.send(result);
});

app.get("/api/admin/payments", verifyToken, verifyAdmin, async (req, res) => {
  const payments = await paymentsCol.find({}).sort({ paidAt: -1 }).toArray();
  res.send({ totalRevenue: sumOf(payments, "amount"), payments });
});

// ---------- stats for the dashboards and the home page ----------
app.get("/api/dashboard/stats", verifyToken, async (req, res) => {
  const { role, email } = req.user;
  if (role === "customer") {
    const bookings = await bookingsCol.find({ customerEmail: email }).toArray();
    const payments = await paymentsCol.find({ customerEmail: email }).toArray();
    return res.send({
      totalRequests: bookings.length,
      activeJobs: bookings.filter((b) => ACTIVE.includes(b.status)).length,
      completedJobs: bookings.filter((b) => b.status === "completed").length,
      totalSpent: sumOf(payments, "amount"),
      byStatus: countBy(bookings, "status"),
    });
  }
  if (role === "technician") {
    const services = await servicesCol.find({ technicianEmail: email }).toArray();
    const bookings = await bookingsCol.find({ technicianEmail: email }).toArray();
    const payments = await paymentsCol.find({ technicianEmail: email }).toArray();
    return res.send({
      totalServices: services.length,
      approvedServices: services.filter((s) => s.approvalStatus === "approved").length,
      pendingRequests: bookings.filter((b) => b.status === "requested").length,
      totalEarned: sumOf(payments, "amount"),
      byStatus: countBy(bookings, "status"),
    });
  }
  // admin
  const [users, technicians, pendingServices] = await Promise.all([
    usersCol.countDocuments({}),
    usersCol.countDocuments({ role: "technician" }),
    servicesCol.countDocuments({ approvalStatus: "pending" }),
  ]);
  const bookings = await bookingsCol.find({}).toArray();
  const payments = await paymentsCol.find({}).toArray();
  const revenueByDay = {};
  for (let i = 6; i >= 0; i--) {
    revenueByDay[new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)] = 0;
  }
  payments.forEach((p) => {
    const day = new Date(p.paidAt).toISOString().slice(0, 10);
    if (day in revenueByDay) revenueByDay[day] += Number(p.amount) || 0;
  });
  res.send({
    totalUsers: users,
    totalTechnicians: technicians,
    pendingServices,
    totalBookings: bookings.length,
    totalRevenue: sumOf(payments, "amount"),
    byStatus: countBy(bookings, "status"),
    revenueByDay,
  });
});

app.get("/api/public/stats", async (req, res) => {
  const [technicians, services, completedJobs] = await Promise.all([
    usersCol.countDocuments({ role: "technician" }),
    servicesCol.countDocuments(publicFilter),
    bookingsCol.countDocuments({ status: "completed" }),
  ]);
  res.send({ technicians, services, completedJobs });
});
// ---------- ROUTES BELOW (more are added in the next steps) ----------

// ---------- fallbacks ----------
app.use((req, res) => res.status(404).send({ message: "Route not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send({ message: "Something went wrong on the server" });
});

if (require.main === module) {
  app.listen(port, () => console.log(`FixMate server running on port ${port}`));
}

module.exports = app;