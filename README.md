# FixMate Server

REST API for **FixMate**, the on-demand device & home appliance repair booking platform.
Built with Express.js, MongoDB, JWT and Stripe.

- **Live API:** https://fixmate-server-sable.vercel.app
- **Live site:** https://fixmate-client-kappa.vercel.app
- **Client repo:** https://github.com/TunazzinaEmma2002/fixmate-client

## Test accounts (live site)

| Role | Email | Password |
|---|---|---|
| Admin | admin@fixmate.com | Fixmate123 |
| Technician | tech1@fixmate.com | Fixmate123 |
| Technician 2 | tech2@fixmate.com | Fixmate123 |
| Customer | customer@fixmate.com | Fixmate123 |

Stripe test card: `4242 4242 4242 4242`, any future date, any CVC.

> **Google sign in:** the Google button works with BetterAuth, but the Google app is in *Testing* mode, so only Gmail accounts added as test users can use it (a Google user becomes a `customer`). Reviewers please use the email and password accounts above.

## Key features

- **JWT auth** in an HTTPOnly cookie. Middlewares: `verifyToken`, `verifyCustomer`, `verifyTechnician`, `verifyAdmin`. Missing/invalid token gives `401`, wrong role gives `403`. The role is always read from the database, never trusted from the token.
- **Server-side search, filter and sort** on `GET /api/services` (`search`, `category`, `serviceMode`, `sort`, `limit`).
- **Job status pipeline enforced on the server**: requested → accepted / rejected → in-progress → completed. Customers can cancel only while a job is still `requested`. Invalid jumps return `400`, a technician who does not own the job gets `403`.
- **Payment gate**: a job can only be paid when it is `completed` and unpaid. The amount always comes from the database, never from the browser.
- **Stripe Checkout + webhook** (`checkout.session.completed`) with signature verification. A unique index on the Stripe session id makes sure a payment is never saved twice.
- **Duplicate protection**: a customer cannot have two active requests for the same service (`409`).
- **Admin tools**: approve/reject services, change roles, list all users, bookings and payments, dashboard statistics.

## Collections

`user` (managed by BetterAuth, with `role`, `phone`, `area`, `bio`), `services`, `bookings`, `payments`.

## Main endpoints

| Area | Endpoints |
|---|---|
| Auth | `POST /jwt`, `POST /logout`, `GET /api/me` |
| Services | `GET /api/services`, `GET /api/services/:id`, `GET /api/services/mine`, `POST`, `PATCH`, `DELETE /api/services/:id` |
| Bookings | `POST /api/bookings`, `GET /api/bookings/my`, `GET /api/bookings/technician`, `PATCH /api/bookings/:id/cancel`, `PATCH /api/bookings/:id/status` |
| Payments | `POST /api/payments/create-checkout-session`, `GET /api/payments/verify`, `GET /api/payments/my`, `POST /api/payments/webhook` |
| Profile | `GET/PATCH /api/users/profile` |
| Admin | `GET /api/admin/users`, `PATCH /api/admin/users/:id/role`, `GET /api/admin/services`, `PATCH /api/admin/services/:id/approval`, `GET /api/admin/bookings`, `GET /api/admin/payments` |
| Stats | `GET /api/dashboard/stats`, `GET /api/public/stats` |

## npm packages

`express`, `cors`, `cookie-parser`, `dotenv`, `mongodb`, `jsonwebtoken`, `stripe`.

## Run it locally

```bash
git clone https://github.com/TunazzinaEmma2002/fixmate-server.git
cd fixmate-server
npm install
# create .env (see below)
npm run dev
```

Optional demo data (register the 4 accounts on the site first): `node seed.js`.

### Environment variables (`.env`)

| Name | Meaning |
|---|---|
| `PORT` | Server port, for example `5000` |
| `MONGODB_URI` | MongoDB connection string (database `fixmate`) |
| `JWT_SECRET` | Must be the same value as in the client `.env.local` |
| `CLIENT_URL` | Allowed client origin(s) for CORS, comma separated |
| `STRIPE_SECRET_KEY` | Stripe secret key (test mode) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the Stripe webhook endpoint |

Stripe webhook endpoint: `<server url>/api/payments/webhook`, event `checkout.session.completed`.