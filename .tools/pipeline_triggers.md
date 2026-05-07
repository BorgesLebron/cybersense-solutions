# CyberSense.Solutions — Pipeline Trigger Reference
**Version 1.0 | All Five Pipelines | Sourced from cyberSense_agent_fleet.md**

---

## HOW TO READ THIS DOCUMENT

Each trigger entry shows: **who fires it**, **what fires it**, **what it produces**, and **where that output goes next**.
Automated triggers run without human intervention. Manual triggers require an agent decision or external event.

---

## AWARENESS PIPELINE
*Hard deadline: Jeff receives content by 0630 CT; Maya approves by 0700 CT; Oliver posts at 0700 CT.*

| # | Trigger | Fired By | Agent Activated | Output | Next Recipient |
|---|---------|----------|-----------------|--------|----------------|
| A1 | Daily cycle initiation — 0500 CT (automated) | System scheduler | **Ruth** | Begins repository query and curation of 7-item brief | — |
| A2 | Barbara repository update digest containing Awareness-eligible records | Barbara | **Ruth** | Ruth selects threat items from new records | — |
| A3 | Ivan/Charlie direct delivery of Innovation + Growth records (by 0600 CT) | Ivan/Charlie | **Ruth** | Ruth selects innovation and growth items | — |
| A4 | Kirby training byte delivery (by 0530 CT) | Kirby | **Ruth** | Ruth includes training byte verbatim in brief draft | — |
| A5 | Kirby training byte NOT received by 0530 CT | Ruth (auto-detect) | **Barret + Alex** | Barret escalation; Ruth inserts placeholder and continues | — |
| A6 | Ruth delivers 7-item structured draft — hard deadline 0615 CT | Ruth | **Peter** | Peter receives draft for developmental editing | — |
| A7 | Structured draft received from Ruth | Ruth → Peter | **Peter** | Develops briefing into publication-ready format | Ed (by 0630 CT) |
| A8 | Developed briefing + editorial note received from Peter (by 0630 CT) | Peter → Ed | **Ed** | Final editorial review, corrections, approval | Jeff (by 0645 CT) |
| A9 | QA-approved briefing received from Jeff (by 0650 CT) | Jeff → Maya | **Maya** | Final approval check (10-minute window) | Laura (approval signal) |
| A10 | Maya approval logged in task record | Maya → Laura | **Laura** | Initiates distribution sequence | Oliver (0700 CT) |
| A11 | Laura release signal + 0700 CT | Laura → Oliver | **Oliver** | Posts Daily Digital Awareness Briefing to LinkedIn | Lucy + Riley (notify) |
| A12 | Oliver publishes newsletter post | Oliver → Lucy + Riley | **Lucy** (Meta), **Riley** (X/TikTok) | Platform-adapted posts to Facebook/Instagram/Threads/X/TikTok | — |
| A13 | Any handoff exceeds SLA threshold | Barret (auto-monitor) | **Barret** | Intervention alert to delayed agent; escalation to Henry if unresolved in 15 min | Henry (if unresolved) |

**Awareness Pipeline SLA Checkpoints (Barret-enforced):**
- 0500 CT — Ruth begins curation
- 0530 CT — Kirby training byte due to Ruth
- 0600 CT — Ivan/Charlie Innovation + Growth records due to Ruth
- 0615 CT — Ruth → Peter
- 0630 CT — Peter → Ed
- 0645 CT — Ed → Jeff
- 0650 CT — Jeff → Maya
- 0700 CT — Maya approval → Laura → Oliver posts

---

## INTEL PIPELINE
*Continuous — no fixed deadline. Quality over cadence; target once per business day.*

| # | Trigger | Fired By | Agent Activated | Output | Next Recipient |
|---|---------|----------|-----------------|--------|----------------|
| I1 | New repository update digest from Barbara (Intel-eligible records) | Barbara | **James** | Repository query; curates primary story + 2–4 supporting items + 1–2 innovation items | Jason |
| I2 | Critical/Immediate threat alert from Barbara | Barbara | **James** | Priority brief consideration; may trigger an out-of-cycle Intel Brief | Jason (urgent) |
| I3 | James' own continuous cadence (daily minimum query) | James (automated) | **James** | Forces daily repository check even without Barbara notification | Jason |
| I4 | Structured draft input package received from James | James → Jason | **Jason** | Develops full Intel Brief narrative + editorial note | Rob |
| I5 | Developed Intel Brief draft received from Jason | Jason → Rob | **Rob** | Final editorial review; accuracy pass; submission decision | Jeff |
| I6 | Rob approves and submits Intel Brief | Rob → Jeff | **Jeff** | Full QA review against all six criteria | Maya |
| I7 | Jeff QA clearance | Jeff → Maya | **Maya** | Final approval review | Laura (approval signal) |
| I8 | Maya approval logged in task record | Maya → Laura | **Laura** | Schedules Intel Brief release (avoids 0700 CT Awareness window) | Oliver (LinkedIn) |
| I9 | Intel Brief returned from Jeff (QA failure) | Jeff → Rob | **Rob** | Assesses feedback; makes corrections or returns to Jason | Jeff (resubmit) |
| I10 | Intel Brief returned from Jason after Rob feedback | Rob → Jason | **Jason** | Addresses developmental issues | Rob |
| I11 | Insufficient quality material for 48+ hours | James → Rob | **Rob** | Escalation notification; Rob assesses pipeline health | Henry (if systemic) |

---

## TRAINING PIPELINE
*Continuous — no fixed daily deadline. Training byte has hard 0530 CT daily deadline.*

| # | Trigger | Fired By | Agent Activated | Output | Next Recipient |
|---|---------|----------|-----------------|--------|----------------|
| T1 | Daily cycle — Kirby initiates training byte production by 0500 CT | System scheduler | **Kirby** | Queries Barbara's repository for Training-eligible records | — |
| T2 | Training byte ready (0530 CT deadline) | Kirby | **Mario + Ruth** | Training byte delivered to both simultaneously | Mario (queue), Ruth (Awareness brief) |
| T3 | New intelligence batch in Barbara's repository (Training-eligible) | Barbara | **Kirby** | Kirby assesses curriculum update need; may trigger module design | Alex (if gap identified) |
| T4 | Alex curriculum directive or update | Alex | **Kirby** | Kirby adjusts module design priorities | Mario (updated deliverables) |
| T5 | Training module or scenario design complete | Kirby → Mario | **Mario** | Logistics processing — queues for Matt delivery | Matt |
| T6 | Maya-approved content available in delivery queue | Mario → Matt | **Matt** | Records video content or prepares live session | Mario (completed deliverables) |
| T7 | Live session scheduled for Enterprise/Teams client | Client/William handoff | **Matt** | Facilitates live session delivery | — |
| T8 | Completed training deliverable submitted by Matt | Matt → Mario | **Mario** | Routes to Jeff for QA | Jeff |
| T9 | Training content QA clearance from Jeff | Jeff → Maya | **Maya** | Final approval; training content enters library | Laura (release signal) |
| T10 | Kirby training byte not delivered by 0530 CT | Kirby (missed deadline) | **Barret + Alex** | Barret intervention; Ruth includes placeholder; Alex investigates | Henry (if unresolved) |
| T11 | 3+ Jeff rejections on training content in 24 hours | Jeff (auto-count) | **Victor + Maya + Alex** | Victor risk assessment; Alex investigates pipeline quality | Henry (if systemic) |

---

## THREAT INTELLIGENCE ACQUISITION (Red Team — Rick)
*Continuous monitoring. Immediate delivery for Critical/Immediate items; 4-hour batch cycles otherwise.*

| # | Trigger | Fired By | Agent Activated | Output | Next Recipient |
|---|---------|----------|-----------------|--------|----------------|
| R1 | New CVE publication (NVD real-time feed) | NVD API | **Rick** | Structured threat record (if qualifying) | Barbara |
| R2 | New CISA KEV entry or CISA alert publication | CISA API | **Rick** | Structured threat record with KEV flag | Barbara |
| R3 | Vendor security advisory publication (Microsoft, Cisco, Palo Alto, etc.) | Vendor RSS/API feed | **Rick** | Structured threat record | Barbara |
| R4 | Dark web signal detection (credibility threshold met) | Dark web aggregator | **Rick** | Threat record flagged "Unverified — Requires Corroboration" if unverified | Barbara |
| R5 | Critical or Immediate priority threat detected | Rick (quality gate) | **Rick** | Immediate delivery — does not wait for 4-hour batch | Barbara + Victor (simultaneous) |
| R6 | 4-hour batch delivery cycle (automated) | System scheduler | **Rick** | Batch of all queued threat records | Barbara |
| R7 | Rick internal quality gate passed | Rick | **Barbara** | Normalized, validated threat record committed to repository | James, Ruth, Kirby (digest) |
| R8 | Vendor dependency used by the platform flagged in an advisory | Rick (monitoring) | **Victor** | Escalation notification — platform operational risk | Henry |

---

## INNOVATION & GROWTH INTELLIGENCE ACQUISITION (Red Team — Ivan/Charlie)
*Continuous monitoring. Ruth delivery by 0600 CT daily; 4-hour batch to Barbara.*

| # | Trigger | Fired By | Agent Activated | Output | Next Recipient |
|---|---------|----------|-----------------|--------|----------------|
| IC1 | Emerging technology publication detected (IEEE, ACM, arXiv, vendor research) | Publication feed | **Ivan/Charlie** | Structured Innovation intelligence record | Barbara + Ruth (daily delivery) |
| IC2 | Workforce development publication detected (ISC², CompTIA, SANS, LinkedIn Workforce) | Publication feed | **Ivan/Charlie** | Structured Growth intelligence record | Barbara + Ruth + Kirby |
| IC3 | Daily delivery to Ruth — hard deadline 0600 CT | Ivan/Charlie (automated) | **Ivan/Charlie** | Minimum: 2 Innovation records + 1 Growth record delivered directly to Ruth | Ruth |
| IC4 | 4-hour batch delivery cycle to Barbara | System scheduler | **Ivan/Charlie** | All queued Innovation and Growth records | Barbara |
| IC5 | Kirby training curriculum update request | Kirby | **Ivan/Charlie** | Growth intelligence records relevant to curriculum gap | Kirby |
| IC6 | Delivery to Ruth will be delayed past 0600 CT | Ivan/Charlie (detect) | **Barret** | Escalation — Barret intervenes; notifies Henry | Henry |

---

## BARBARA'S REPOSITORY — INBOUND TRIGGERS
*Barbara normalizes, deduplicates, correlates, and indexes all incoming records.*

| # | Trigger | Fired By | Barbara Action | Notification Sent To |
|---|---------|----------|----------------|----------------------|
| B1 | Threat record batch received from Rick (every 4 hours) | Rick | Normalize, deduplicate, tag, correlate, commit to repository | James + Ruth + Kirby (digest) |
| B2 | Critical/Immediate threat record from Rick (immediate) | Rick | Skip batch queue — immediate processing and repository commit | James + Ruth (immediate alert) |
| B3 | Innovation record batch from Ivan/Charlie (every 4 hours) | Ivan/Charlie | Normalize, tag (Innovation), correlate, commit | James + Ruth + Kirby (digest) |
| B4 | Growth record batch from Ivan/Charlie (every 4 hours) | Ivan/Charlie | Normalize, tag (Growth), correlate, commit | James + Ruth + Kirby (digest) |
| B5 | Repository access request from James, Ruth, or Kirby | James/Ruth/Kirby | Serves filtered read access (read-only for consumers) | — |
| B6 | Incoming records fail quality gates at elevated rate | Barbara (detect) | Escalation to Victor — Red Team data quality issue | Victor |

---

## SALES PIPELINE

| # | Trigger | Fired By | Agent Activated | Output | Next Recipient |
|---|---------|----------|-----------------|--------|----------------|
| S1 | Platform engagement signal meets qualification threshold | Platform analytics | **Mary** | Qualification assessment | William (if qualified) |
| S2 | Inbound inquiry received (contact form, demo request) | Prospect | **Mary** | Lead qualification record | William (if qualified) |
| S3 | Free-to-freemium or freemium-to-trial upgrade event | Platform | **Mary** | Qualification trigger | William (if qualified) |
| S4 | Qualified lead record received from Mary | Mary → William | **William** | Discovery, demo, proposal, close | Joe (on close) |
| S5 | Upsell opportunity signal from Joe | Joe → William | **William** | Upsell conversation with existing client | Joe (outcome) |
| S6 | Account health score drops below threshold | Platform (auto-alert) | **Joe** | Retention action — proactive outreach | Victor (if risk escalation needed) |
| S7 | Renewal date approaches (90/60/30-day alerts) | System scheduler | **Joe** | Renewal outreach and health check | William (if at risk) |
| S8 | New account received from William post-close | William → Joe | **Joe** | Onboarding trigger; account health tracking begins | Jim (weekly health data) |

---

## MANAGEMENT ESCALATION TRIGGERS

| # | Trigger | Escalated To | Action Required |
|---|---------|-------------|-----------------|
| E1 | Any pipeline handoff exceeds SLA | **Barret** | Intervention within 15 minutes; Henry notified if unresolved |
| E2 | 3+ Jeff rejections from any pipeline in 24 hours | **Victor + Maya + relevant pipeline manager** | Risk assessment; pattern investigation |
| E3 | Awareness pipeline at risk of missing 0700 CT | **Barret → Henry** | Immediate escalation; Henry has override authority |
| E4 | Critical/Immediate threat detected by Rick | **Victor** | Risk assessment; potential platform or subscriber impact |
| E5 | Content presents legal or reputational risk | **Victor → Maya → Henry** | Maya holds; Victor assesses; Henry decides |
| E6 | Financial anomaly detected by Jim | **Valerie → Henry** | Strategic assessment; possible executive action |
| E7 | Enterprise/Teams account considering cancellation | **Joe → Henry** | Henry-level retention engagement |
| E8 | Vendor/API dependency failure affecting production | **Victor → Henry** | Operational risk; contingency activation |

---

## NOTE: generate_newsletter_migration.py

This script is a **local development tool only**. It does not trigger any pipeline stage.

**What it does:** Scans all HTML files in `newsletter/YYYY/Mon/` directories, extracts `og:title` and `og:description` meta tags, and generates a SQL migration file (`002_briefings_newsletter_archive.sql`) that seeds all editions into the `briefings` table.

**What it does NOT do:** It does not call any API, does not notify any agent, does not create tasks, and has no connection to Barbara's repository, Ruth's pipeline, or any other platform workflow.

**When to run it:** Once, locally, to generate the seed migration for historical newsletter editions. Future editions are added via new migration files (003, 004, etc.) following the same pattern.
