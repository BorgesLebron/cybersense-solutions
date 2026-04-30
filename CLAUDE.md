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

---

## Agent Fleet (v1.1 — Current)

The platform uses **27 named agents** organized into departments. Agents receive work via the task queue (`tasks` table) and webhook notifications. The `AGENT_JWT_SECRET` authenticates agent API calls separately from user JWTs.

**Agent count increased from 20+ to 27** following the addition of the full IT security team (Cy, Nora, Owen, Paige, Quinn) and Mario (Training Coordinator) in fleet v1.1.

### Department Structure

| Department | Agents |
|-----------|--------|
| **Management** | Henry (GM), Valerie (Strategy), Victor (Risk), Barret (Coordination), Alex (Training Mgr), Maya (Managing Editor) |
| **IT / Security** | Cy (CISO), Nora (System Health), Owen (Vulnerability/Patch), Paige (Incident Response), Quinn (Access/Credentials) |
| **Operations / Acquisitions** | Rick (Threat Intel), Ivan/Charlie (Intel Scout), Barbara (Data Analyst), Laura (Operations Analyst), Jim (Financial Analyst), Jeff (QA Analyst) |
| **Editorial — Intel** | James (Intel Acquisition), Jason (Dev Editor Intel), Rob (EIC Intel) |
| **Editorial — Awareness** | Ruth (Awareness Acquisition — dual role: Ops + Editorial), Peter (Dev Editor Awareness), Ed (EIC Awareness) |
| **Training / Production** | Kirby (Instructional Designer), Mario (Training Coordinator), Matt (Trainer/Facilitator) |
| **Sales** | Mary (SDR), William (AE — includes pre-sales technical support, Dale consolidated), Joe (Account Manager) |
| **Social Media / Distribution** | Oliver (LinkedIn), Lucy (Meta), Riley (TikTok/X), Ethan (YouTube) |

### Key Agent Architecture Notes

- **Ruth** operates under two SOPs — OA-AWR-001 (Operations scope) and ED-AWR-001 (Editorial scope). Both govern her simultaneously.
- **Ivan/Charlie** is a single consolidated agent covering two intelligence streams: Innovation (Ivan function) and Growth (Charlie function).
- **Dale** (Sales Engineer) is consolidated into William's scope for the current phase. Dale re-activates in fleet v1.2 upon Federal/Defense tier launch.
- **Jeff** (QA Analyst) is listed under Operations/Acquisitions in the fleet but cross-pipeline — he reviews Intel, Awareness, and Training content.
- **Cy** is both the platform's CISO agent and the brand avatar. His security standards are publicly accountable — the platform cannot publish threat intelligence about vulnerabilities it has not patched in its own stack.

### Agent SOP Access — Private Repository Architecture

Agents pull their SOPs via authenticated API at runtime (on startup or task assignment). They operate from the current version — not a hardcoded copy. SOP updates propagate to agents without redeployment.

**Authentication:** `AGENT_JWT_SECRET` — same gate as existing agent auth. Each agent authenticates by agent ID and receives only its own SOP. No agent can pull another agent's SOP unless specifically authorized.

**API endpoint:** `GET /api/agent/sop` → returns the calling agent's current SOP. Server-side GitHub API call to private repository — private repo credentials never leave backend.

**Private repository structure:**
```
cybersense-sop (private GitHub repo)
├── ops/           # OA series — Operations/Acquisitions SOPs
├── editorial/     # ED series — Editorial SOPs
├── it/            # IT series — Security team SOPs
├── mgmt/          # MG series — Management SOPs (ESC, DSH, GOV, TRG)
├── admin/         # AD series — Administrative/Sales/Finance SOPs
├── production/    # PR series — Training, Video, Lab SOPs
├── distribution/  # DI series — Social Media/Distribution SOPs
└── vision/        # Product vision documents (VISION-LAB-001, etc.)
```

**Benefits:** Version control, trade secret protection, hot updates, full auditability. SOPs never touch the public repo. Agents in the public codebase only know how to fetch instructions — not what they say.

**SOP version logging:** Every agent SOP pull is logged: agent ID, SOP ID, version number, pull timestamp. Creates an immutable audit record of which SOP version governed each agent invocation.

---

## SOP Library (Current State)

A complete Standard Operating Procedure library governs every agent's function, authority boundaries, escalation paths, and operational behavior. SOPs are version-controlled and stored in the private `cybersense-sop` repository.

### Completed SOPs

| Series | SOP ID | Agent / Function |
|--------|--------|-----------------|
| **OA** | OA-RCK-001 | Rick — Threat Intelligence Acquisition |
| | OA-IVC-001 | Ivan/Charlie — Innovation and Growth Intelligence |
| | OA-BAR-001 | Barbara — Intelligence Normalization and Repository |
| | OA-AWR-001 | Ruth — Awareness Acquisition (Operations scope) |
| **ED** | ED-INT-001 | James — Intel Acquisition |
| | ED-INT-002 | Jason — Intel Developmental Editing |
| | ED-INT-003 | Rob — Intel EIC Final Review |
| | ED-AWR-001 | Ruth — Awareness Acquisition (Editorial scope) |
| | ED-AWR-002 | Peter — Awareness Developmental Editing |
| | ED-AWR-003 | Ed — Awareness EIC Final Review |
| | ED-QA-001 | Jeff — Quality Assurance (cross-pipeline) |
| | ED-MGT-001 | Maya — Managing Editor Final Approval |
| **MG** | MG-ESC-001 | Management Escalation Procedures |
| | MG-DSH-001 | Dashboard Governance |
| **IT** | IT-CY-001 | Cy — CISO |
| | IT-NOR-001 | Nora — System Health Monitor |
| | IT-OWN-001 | Owen — Vulnerability and Patch Management |
| | IT-PAI-001 | Paige — Incident Response |
| | IT-QNN-001 | Quinn — Access and Credential Management |
| **AD** | AD-SAL-001 | Mary — Sales Development Representative |
| | AD-SAL-002 | William — Account Executive |
| | AD-SAL-003 | Joe — Account Manager |
| | AD-FIN-001 | Jim — Financial Analyst |
| **PR** | PR-TRN-001 | Kirby — Instructional Designer |
| | PR-TRN-002 | Mario — Training Coordinator |
| | PR-TRN-003 | Matt — Trainer and Facilitator |
| | PR-TRN-004 | Alex — Training Manager |
| | PR-VID-001 | Video Production (Placeholder — Project 3) |
| | PR-LAB-001 | Ambient Threat Simulation Lab (Placeholder — Project 4) |
| **DI** | DI series | Social Media / Distribution — In progress |

### Pending SOPs

| SOP ID | Function |
|--------|---------|
| DI-OLI-001 | Oliver — LinkedIn Agent |
| DI-LUC-001 | Lucy — Meta Agent |
| DI-RIL-001 | Riley — TikTok and X Agent |
| DI-ETH-001 | Ethan — YouTube Agent |
| MGT-GOV-001 | Master Governance Document (capstone) |
| MGT-TRG-001 | Master Trigger Registry (capstone) |

### Pending Batch Amendments

The following amendments are queued for batch application across completed SOPs:

| # | Amendment | Affected SOPs |
|---|-----------|--------------|
| 1 | Awareness pipeline production cycle: Sunday–Thursday. Delivery: Monday–Friday. | Fleet v1.1, OA-AWR-001, ED-AWR-001, ED-AWR-002, ED-AWR-003, Engineering Notes |
| 2 | Option B timing: Ruth starts 0430 CT, Kirby deadline 0500 CT, Ivan/Charlie deadline 0530 CT, Peter deadline 0630 CT, Jeff 0645–0655 CT, Maya 0655–0700 CT | Fleet v1.1, all Awareness pipeline SOPs |
| 3 | Dale (Sales Engineer) consolidated into William for current phase. Re-activates in fleet v1.2 at Federal/Defense tier launch. | Fleet v1.1, AD-SAL-002 |
| 4 | Social Media ad hoc breaking news: after Maya seals the Daily Briefing, no changes to that edition. Breaking threats delivered ad hoc via Social Media with "covered in Edition XXX" notation. Separate Maya approval required for ad hoc posts. | DI series, ED-AWR-003, ED-MGT-001 |
| 5 | Private SOP Repository architecture: runtime SOP pull via authenticated API, version logging, per-agent access control. | Engineering Notes, Fleet v1.1, MGT-GOV-001 |

---

## Content Pipeline

### Awareness Pipeline (Daily Briefing)

Production cycle: **Sunday through Thursday**. Delivery to subscribers: **Monday through Friday before 0700 CT**.

**Timing chain (Option B — current standard):**
```
0430 CT  Ruth begins daily cycle (source, select, structure 7 items)
0500 CT  Kirby training byte delivered to Mario AND Ruth
0530 CT  Ivan/Charlie delivers Innovation and Growth records to Ruth
0600 CT  Ruth delivers structured 7-item package to Peter
0630 CT  Peter delivers developed briefing to Ed
0645 CT  Ed delivers final briefing to Jeff (QA)
0655 CT  Jeff delivers QA-cleared briefing to Maya
0700 CT  Maya approves → Preview Briefing available → Human Executive reviews → Laura triggers Oliver → LinkedIn distribution
```

**Ruth's required composition (7 items):**
- 3 Threat Items (Critical/High, last 24–48h, from Barbara's repository)
- 2 Innovation Items (from Ivan/Charlie direct delivery)
- 1 Growth Item (from Ivan/Charlie direct delivery)
- 1 Training Byte (from Kirby, verbatim — no alteration)

### Intel Pipeline (Continuous)

No fixed daily deadline. Production triggered by sufficient qualifying material in Barbara's repository. Target: within 2 hours of Jeff QA pass for standard briefs, 30 minutes for Critical/Immediate priority briefs.

```
James (repository query + draft input package)
  → Jason (developmental editing)
  → Rob (final editorial review)
  → Jeff (QA)
  → Maya (approval)
  → Preview Briefing (human executive review)
  → Laura (distribution trigger)
  → Oliver/Lucy/Riley/Ethan
```

### Training Pipeline

```
Kirby (design) → Mario (LMS staging) → Matt (delivery) → Mario (QA routing) → Jeff → Maya → Laura
Kirby → Ruth (training byte, 0500 CT daily)
```

### Full editorial pipeline stages:
```
R&D → In Progress → Under Review → Human in the Loop → Published
```

### Post-Maya Approval — Human-in-the-Loop Gate

**Preview Briefing** in the Admin Console is the mandatory human-in-the-loop review gate between Maya's approval and Laura's distribution trigger. Maya's logged approval makes the briefing available in Preview Briefing. Distribution is authorized only after Human Executive confirms via Preview Briefing. Laura distributes. Oliver posts at 0700 CT.

No distribution occurs without the Preview Briefing confirmation — no exceptions.

### Ad Hoc Breaking News (Social Media)

Once Maya seals a Daily Digital Awareness Briefing edition, that edition is locked — no changes. If a Critical or breaking threat emerges after the seal, the Social Media team delivers it ad hoc with a notation: "Full coverage in Edition [XXX] of the Daily Digital Awareness Briefing." Ad hoc posts require separate Maya approval. This creates subscriber credibility, reliability signaling, and newsletter anticipation.

---

## Admin Console Dashboard

Three primary navigation destinations:

**Command Center** — Operational intelligence: live subscriber metrics, MRR (Jim-validated, Stripe), Open Risks (Victor + Cy), Content Pipeline Status (stage + agent name), Radar Threat Counter (live from Barbara's repository), Recent Activity feed.

**Agent Status** — Fleet management: 27 agents organized by department, color-coded health indicators (Green/Yellow/Red), hover tooltips, agent detail panels. Six management-layer agents have dashboard chat interfaces:

| Agent | Chat Scope |
|-------|-----------|
| Henry | Fleet directives, executive summaries, overrides |
| Cy | Security status, incidents, vulnerabilities |
| Victor | Risk posture, escalations |
| Barret | Pipeline handoff, SLA status |
| Maya | Editorial direction, approval status |
| Valerie | Strategic planning, financial signals |

**Chain of command is enforced at the application layer.** No direct human-to-agent chat exists outside these six management-layer agents.

**Meeting Room** — Structured multi-agent collaboration: human executive-initiated or agent-initiated (via Henry for operational, via Cy for security). Meeting records are permanent audit artifacts. Action items appear as Open Tickets in the Agent Status dashboard.

### Preview Controls (header dropdown)
```
Preview ▼
├── Preview Briefing      (Maya-approved newsletter — human gate before distribution)
├── Preview Carousel      (social media carousel review)
└── Preview Articles ▶
    ├── Threat Intelligence
    ├── Policy Updates
    ├── Latest Innovations
    ├── Professional Growth
    └── Training Resources
```

---

## Source Tier Policy

All intelligence sources across Rick's and Ivan/Charlie's source registries are classified into three tiers governing how they are integrated and referenced in published content:

| Tier | Description | Linking Policy |
|------|-------------|---------------|
| **Tier 1** | Institutional APIs — CISA, NVD, MITRE, FBI, NCSC, MSRC | Always linkable |
| **Tier 2** | Vendor research RSS — Unit 42, CrowdStrike, Microsoft Security Research, Cisco Talos, etc. | Linkable with editorial redirect verification |
| **Tier 3** | Commercial news outlets, any source with uncontrolled redirect behavior | Name only — no links ever |

**RSS Feed Aggregator:** foorilla allinfosecnews_sources (CC0 licensed source list). Rick pulls directly from Tier 1 and Tier 2 RSS feeds via this registry. No dependency on Foorilla's commercial API — avoids single point of failure.

**Tier 3 policy rationale:** A subscriber's newsletter click that redirects to a competitor's signup page is a brand trust event. Tier 3 sources are referenced by name only in all published content.

---

## User Tiers

`free` → `freemium` → `monthly` → `enterprise`

Tier is checked in `middleware/auth.js` to gate content access:

| Feature | Free | Freemium | Monthly | Enterprise |
|---------|------|----------|---------|------------|
| Daily Briefing | ✓ (3 items visible) | ✓ (all 7) | ✓ | ✓ |
| Radar | 3 threats | 5 threats | Full | Full + click-through |
| Intel Articles | Partial (banner) | 2 articles | Full | Full |
| Newsletter Archive | Top 3 blurred | Full | Full | Full |
| Training | — | — | Awareness level | All levels |
| Ambient Lab | — | — | Awareness, limited sessions | Full, unlimited |
| Compliance Dashboard | — | — | — | ✓ |

---

## Auth System

- Access tokens: 15-minute expiry (`JWT_SECRET`)
- Refresh tokens: 7-day expiry (`JWT_REFRESH_SECRET`)
- Agent tokens: separate secret (`AGENT_JWT_SECRET`) — also used for SOP API authentication
- Admin roles stored in `admin_roles` table: `gm, editor, analyst, sales, training`

**SOP API auth:** Agents authenticate by agent ID using `AGENT_JWT_SECRET`. The SOP API resolves which SOP the calling agent owns and fetches it from the private repository via server-side GitHub API call. Private repo credentials never leave the backend. Each agent receives only its own SOP.

---

## IT / Security Architecture

### Critical Security Decision Protocol (CSDP)

When Cy escalates a Critical or High severity security finding to Henry, Henry must acknowledge, decide, and log a response within the defined CSDP SLA regardless of other platform priorities. This is the only agent-to-Henry relationship in the fleet where Henry has a binding response obligation. Deferral of a Critical finding requires documented executive rationale in the audit trail.

**CSDP activation triggers:** Critical CVE on platform stack, active security breach, credential compromise, platform integrity event.

### Brand Integrity Obligation

CyberSense.Solutions cannot publish threat intelligence about a vulnerability while running unpatched software containing that vulnerability. When a CVE appears in Rick's published threat intelligence AND in Owen's platform stack inventory simultaneously — this is a brand integrity intersection. Owen elevates the patch SLA to Critical and Cy notifies Henry immediately. Publishing about a CVE the platform hasn't patched requires Henry's documented authorization.

### Integration Security

No backend integration goes live without Cy's Integration Security Checklist approval AND Nora's acceptance testing AND Quinn's credential provisioning. The illustrative data notation on dashboard panels is removed only when all three conditions are met.

---

## Database

PostgreSQL (single connection via `DATABASE_URL`). All queries abstracted through `db/queries.js` — do not write raw SQL in routes. Migrations live in `db/migrations/` and run in numeric order via `npm run db:migrate`.

---

## Rate Limiting

Three tiers defined in `server.js`:
- Unauthenticated users: most restrictive
- Authenticated users: standard limits
- Agents: higher limits for pipeline ingestion

---

## External Services

| Service | Purpose | Config |
|---------|---------|--------|
| PostgreSQL | Primary database | `DATABASE_URL` |
| Stripe | Subscription billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| SendGrid | Transactional email | `SENDGRID_API_KEY`, `SG_TEMPLATE_*` |
| AWS S3 | Training content storage | `AWS_*`, `S3_BUCKET_TRAINING` |
| LinkedIn API | Social posting | via `linkedin.js` service |
| Railway | API hosting | `railway.toml` |
| GitHub Pages | Frontend hosting | Root of repo, main branch |
| GitHub (private) | SOP repository | Server-side API call only — credentials never exposed |

---

## Scheduled Jobs

`services/scheduler.js` runs nightly in production (`NODE_ENV=production`):
- Dashboard metric snapshots → `dashboard_snapshots` table
- SLA breach detection → triggers escalations
- Health score updates for organizations
- **Midnight content update job** (Sunday–Thursday nights): updates home page and newsletter landing page with current edition before 0700 CT delivery. Monitored by Nora. Failure triggers immediate Barret and Cy alerts.

---

## Newsletter Archive

HTML editions stored in `newsletter/YYYY/Mon/MMDDYYYY_editionNNN.html`.

Archive access: Subscribers and above see full archive. Free users see top 3 editions, remainder blurred. Archive format: month-based accordion (December 2025, January 2026, etc.) expanding to date/edition/subject listings.

---

## Product Roadmap

### Active Platform (October 2026 Enterprise Launch Target)
- Daily Digital Awareness Briefing (Monday–Friday, 0700 CT)
- Threat Radar (tiered visibility)
- Intel Briefs (continuous production)
- Newsletter Archive
- Training content (Awareness level at launch)
- Enterprise/Teams platform with LMS integration

### Future Projects (Session Notes)

**Project 1 — Agentic SOC Expansion (fleet v1.2):**
- Recon Agent (asset discovery / Nmap / perimeter monitoring)
- Analyst Agent (NVIDIA Morpheus — behavioral anomaly detection, telemetry ingest)
- Owen's SOP updated to include Recon Agent as discovery input layer
- Autonomous Action Policy — governed threshold document for agent-initiated actions
- NVIDIA Holoscan/Omniverse SOC visualization for Enterprise/Training tier
- NIM integration (Nemotron/Llama-3) for agent reasoning and threat summarization

**Project 2 — Standalone SOC Platform:**
- Influenced by CyberSense.Solutions agent architecture and governance model
- To be discussed when ready

**Project 3 — Digital Production Pipeline (separate infrastructure):**
- Agent roster: Scout (Creative Director), Rex (Script/Storyboard), Aria (Voice/Audio), Nova (Animation/Visual), Reel (Post-Production), Production Manager
- Tools: DirectML, Bountiful, Runway, NVIDIA Omniverse, ElevenLabs/PlayHT
- Infrastructure: Mac Studio M4 Max (local orchestration) + Cloud GPU (render workloads — AWS p4d / Lambda Labs / RunPod)
- Cy's Nathan voice persona lives in Aria's toolchain
- Connection to content platform via content brief API
- Governed by PR-VID-001 (placeholder until Phase 1 complete)

**Project 4 — Ambient Threat Simulation Lab:**
- Browser-based simulated workday environment (email, calendar, browser, internal tools)
- Organic indicators of compromise — no step-by-step instructions
- User notepad for self-documentation of findings
- Scenario engine: behavioral tracking, branching logic, difficulty calibration
- Intelligence-pipeline-fed indicator library (Barbara's repository → Kirby → scenario engine)
- Avatar debrief: Cy discusses findings conversationally, surfaces personalized remediation videos
- No real user data — preset credentials for all personas
- Complete containment — all threat indicator pages within simulation domain
- Full product vision: VISION-LAB-001
- Governed by PR-LAB-001 (placeholder until Phase 2 prototype complete)
- Open design questions: session length, notepad format, debrief modality, individual session frequency, team analytics privacy, scenario attribution

---

## Key Governance Principles

**Chain of command:** No direct human-to-agent communication outside the six management-layer agents. Enforced at the application layer.

**Financial data authority:** Jim is the sole financial data authority. No agent surfaces revenue figures without Jim's validation. No exceptions.

**Source tier compliance:** Tier 3 sources referenced by name only — no URLs — in all published content, all channels, all pipelines. Zero tolerance. Jeff's QA gate catches Tier 3 URL violations before Maya's approval.

**Brand integrity:** The platform's own security posture must never contradict the threat intelligence it publishes. Owen and Cy govern this jointly.

**Maya approval gate:** Nothing reaches subscribers without Maya's logged approval AND the Preview Briefing human-in-the-loop review AND Laura's distribution trigger. Three conditions. All required.

**Credential governance:** No credential exists without Quinn's registry entry. No credential is provisioned without Cy's authorization. No credential exceeds its rotation SLA without documented extension.

**SOP as trade secret:** All SOPs live in the private `cybersense-sop` repository. Agents fetch their SOP at runtime via authenticated API. The platform's operational intelligence — editorial standards, source tier logic, escalation architecture, brand integrity protocols — is proprietary and protected.
