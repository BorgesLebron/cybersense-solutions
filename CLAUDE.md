# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend (api_layer/)
```bash
npm run dev          # Development with auto-reload (nodemon)
npm start            # Production start
npm run db:migrate   # Run pending SQL migrations
npm test             # Jest tests (--runInBand, sequential)
```

### Frontend
No build step — vanilla JS/HTML/CSS served directly from root. No compilation required.

### Tools
```bash
python tools/generate_carousel.py   # Generate Meta carousel images for social posts
```

## Architecture

CyberSense.Solutions is a B2B cybersecurity intelligence SaaS with two separate deployable parts:

**Frontend** (repo root) — Static site deployable to GitHub Pages. Vanilla JS, no bundler. Key files: `index.html` (landing), `dashboard.html` (app shell), `auth.js` (registration/login/reset flows), `main.js` (shared nav/animations).

**Backend** (`api_layer/`) — Express REST API deployed on Railway (nixpacks builder). Entry: `server.js`. Health check: `GET /health`.

### Backend Structure

```
api_layer/
├── server.js          # Express setup: CORS, helmet, rate limits, route mounting
├── middleware/
│   ├── auth.js        # JWT verification, role checks, tier-based content gating
│   └── logger.js      # Request/error logging
├── routes/            # ~13 route modules mounted under /api/*
│   ├── all-routes.js  # Articles, briefings, radar (content tier gating)
│   ├── auth.js        # Registration, login, token refresh, password reset
│   ├── pipeline.js    # Agent data ingestion: threats, intel, training workflows
│   ├── enterprise.js  # Org admin: dashboards, simulation campaigns
│   ├── tasks.js       # Agent task queue management
│   └── ...            # sales, revenue, social, ops, admin, users, training, content
├── services/
│   ├── agents.js      # Webhook notifications to agents, escalation triggers
│   ├── scheduler.js   # Nightly cron: dashboard snapshots, SLA breach detection
│   ├── sendgrid.js    # Email delivery (verification, briefings, welcome)
│   ├── stripe.js      # Subscription management
│   └── linkedin.js    # LinkedIn posting integration
└── db/
    ├── queries.js     # ~80 reusable query functions (the data access layer)
    ├── migrate.js     # Migration runner
    └── migrations/
        └── 001_initial_schema.sql  # Full schema: 40+ tables, 20+ enums, triggers
```

### Agent Fleet

The platform uses 20+ named agents organized into teams. Agents receive work via the task queue (`tasks` table) and webhook notifications. The `AGENT_JWT_SECRET` authenticates agent API calls separately from user JWTs.

Teams and roles:
- **Acquisition**: threat/intel ingestion (Rick, Ivan, Charlie)
- **Analyst**: processing and normalization (Barbara, Laura)
- **Intel**: article creation (James, Jason, Rob)
- **Awareness**: briefing creation (Ruth, Peter, Ed)
- **Training**: training modules (Kirby, Mario, Matt)
- **Sales**: lead/account management (Mary, William, Joe)
- **Social**: LinkedIn/Meta posting (Oliver, Lucy, Riley, Ethan)
- **Management**: oversight and escalations (Henry GM, Valerie, Victor, Barret, Maya, Alex)

### Content Pipeline

Multi-stage editorial workflow for articles and briefings:
```
draft → dev_edit → eic_review → qa → maya → approved → published
```
Training modules use a simpler path: `draft → qa → maya → published`.

### User Tiers

`free` → `freemium` → `monthly` → `enterprise`

Tier is checked in `middleware/auth.js` to gate content access (e.g., radar depth, briefing archive, articles). Enterprise users belong to an organization with seat management and simulation campaigns.

### Auth System

- Access tokens: 15-minute expiry (`JWT_SECRET`)
- Refresh tokens: 7-day expiry (`JWT_REFRESH_SECRET`)
- Agent tokens: separate secret (`AGENT_JWT_SECRET`)
- Admin roles stored in `admin_roles` table: `gm, editor, analyst, sales, training`

### Database

PostgreSQL (single connection via `DATABASE_URL`). All queries abstracted through `db/queries.js` — do not write raw SQL in routes. Migrations live in `db/migrations/` and run in numeric order via `npm run db:migrate`.

### Rate Limiting

Three tiers defined in `server.js`:
- Unauthenticated users: most restrictive
- Authenticated users: standard limits
- Agents: higher limits for pipeline ingestion

### External Services

| Service | Purpose | Config |
|---------|---------|--------|
| PostgreSQL | Primary database | `DATABASE_URL` |
| Stripe | Subscription billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| SendGrid | Transactional email | `SENDGRID_API_KEY`, `SG_TEMPLATE_*` |
| AWS S3 | Training content storage | `AWS_*`, `S3_BUCKET_TRAINING` |
| LinkedIn API | Social posting | via `linkedin.js` service |
| Railway | API hosting | `railway.toml` |
| GitHub Pages | Frontend hosting | Root of repo, main branch |

### Scheduled Jobs

`services/scheduler.js` runs nightly in production (`NODE_ENV=production`):
- Dashboard metric snapshots → `dashboard_snapshots` table
- SLA breach detection → triggers escalations
- Health score updates for organizations

### Newsletter Archive

HTML editions stored in `newsletter/YYYY/Mon/MMDDYYYY_editionNNN.html`.
