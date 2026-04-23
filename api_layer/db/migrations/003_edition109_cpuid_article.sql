-- Migration 003 — Edition 109 + CPUID Intel Brief article seed
-- Run: npm run db:migrate (from api_layer/)

BEGIN;

-- ── Edition 109 (April 23, 2026) ─────────────────────────────────────────────
-- Update subject_line and description before running if HTML content is ready.
INSERT INTO briefings
  (id, edition_date, edition_number, subject_line, description, body_md, file_path,
   pipeline_status, published_at, threat_item_ids, innovation_item_ids, open_count, click_count)
VALUES (
  gen_random_uuid(),
  '2026-04-23',
  109,
  'CyberSense Daily Briefing — Edition 109',
  'Edition 109 — update subject and description with today''s content.',
  'Edition 109 — update subject and description with today''s content.',
  'newsletter/2026/Apr/04232026_edition109.html',
  'published',
  '2026-04-23 12:00:00+00',
  '{}', '{}', 0, 0
)
ON CONFLICT (edition_date) DO UPDATE SET
  edition_number = EXCLUDED.edition_number,
  file_path      = EXCLUDED.file_path,
  subject_line   = CASE WHEN briefings.subject_line LIKE 'CyberSense Daily Briefing%' THEN EXCLUDED.subject_line ELSE briefings.subject_line END,
  description    = CASE WHEN briefings.description LIKE 'Edition 109 — update%' THEN EXCLUDED.description ELSE briefings.description END;

-- ── CPUID Supply Chain Compromise — Intel Brief article ───────────────────────
INSERT INTO articles
  (id, title, slug, section, body_md, access_tier, pipeline_status, published_at, read_time_min)
VALUES (
  gen_random_uuid(),
  'CPUID Supply Chain Compromise: STX RAT via Trojanized CPU-Z and HWMonitor',
  'cpuid-supply-chain-compromise-stx-rat-via-trojanized-cpu-z-and-hwmonitor',
  'threat',
  E'## The Trusted Tool Is the Attack\n\nCPUID''s website was compromised for less than 24 hours — long enough to serve trojanized versions of CPU-Z and HWMonitor to every user who downloaded during that window. In every case, the attack arrived through something the victim trusted.\n\n## What Happened\n\nThreat actors compromised CPUID''s official website and replaced legitimate downloads of CPU-Z, HWMonitor, HWMonitor Pro, and PerfMonitor with trojanized executables carrying a remote access trojan called **STX RAT**. The compromise window ran from approximately **April 9 at 15:00 UTC to April 10 at 10:00 UTC** — roughly 19 hours.\n\nAny user who downloaded any of these tools during that window should assume the installed software is malicious and treat the affected system as compromised.\n\nCPU-Z and HWMonitor are among the most widely used hardware diagnostic tools among IT professionals, system administrators, and technical users — making CPUID a high-value target for a supply chain attack.\n\n## Indicators and Scope\n\n- **Affected tools:** CPU-Z, HWMonitor, HWMonitor Pro, PerfMonitor\n- **Compromise window:** April 9, 2026 ~15:00 UTC – April 10, 2026 ~10:00 UTC\n- **Payload:** STX RAT (remote access trojan)\n- **Vector:** Trojanized executables served from official vendor website\n\n## What to Do\n\n1. Check download history for any of the affected tools during the compromise window\n2. If a download occurred: isolate the system immediately and initiate a full threat hunt\n3. Assume credential compromise on any affected machine — rotate credentials\n4. Re-download only from the vendor after confirming the clean build is restored\n\n## Why This Pattern Matters\n\nThis incident follows the same model as the Smart Slider 3 Pro compromise: trusted update and download channels subverted to deliver weaponized builds to users following best practice. When attackers operate through trusted channels, the traditional question — "did this come from a known-bad source?" — stops being useful. The better question is: "does this behavior make sense for what this tool should be doing?"',
  'monthly',
  'published',
  '2026-04-15 12:00:00+00',
  5
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
