-- Migration 004 — Update Edition 109 subject_line and description now that HTML is finalized
-- Run: npm run db:migrate (from api_layer/)

BEGIN;

UPDATE briefings
SET
  subject_line = 'Trusted Channels, Compromised Pipelines — Developer Toolchain Under Active Exploitation',
  description  = 'Three supply chain incidents converged in a single news cycle: the CanisterSprawl npm worm propagated through postinstall hooks harvesting developer credentials across connected registries; Checkmarx''s official KICS Docker Hub images were replaced with data-exfiltrating builds distributed under the vendor''s own account; and Microsoft issued an emergency out-of-band patch for CVE-2026-40372, a CVSS 9.1 ASP.NET Core privilege escalation to SYSTEM. When trusted distribution channels become the delivery mechanism, the question shifts from origin to behavior.'
WHERE edition_number = 109
  AND subject_line = 'CyberSense Daily Briefing — Edition 109';

COMMIT;
