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