#!/usr/bin/env python3
"""
CyberSense — Manual Newsletter Pipeline Trigger
================================================
Manually advances a Daily Awareness Briefing through the full pipeline:
  draft → dev_edit → eic_review → qa → maya → approved
  → confirm-distribution (admin gate)
  → release (marks published + sends email)

All pipeline steps are executed as Henry (GM agent, wildcard authority).
The human-in-the-loop gate uses your admin credentials.

Config: place .tools/.env with CS_API_URL, CS_ADMIN_EMAIL, CS_ADMIN_PASSWORD
        (see .tools/pipeline.env.example for the template)

Usage:
  python .tools/trigger_pipeline.py               # discover + interactive
  python .tools/trigger_pipeline.py --id <id>     # target a specific briefing
  python .tools/trigger_pipeline.py --confirm-all # skip per-step prompts
  python .tools/trigger_pipeline.py --dry-run     # print steps, no API calls
"""

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("Missing dependency: pip install requests")
    sys.exit(1)

# ── ANSI terminal colors ──────────────────────────────────────────────────────
G = '\033[92m'   # green
R = '\033[91m'   # red
Y = '\033[93m'   # yellow
B = '\033[94m'   # blue
C = '\033[96m'   # cyan
W = '\033[1m'    # bold
D = '\033[2m'    # dim
X = '\033[0m'    # reset

def ok(msg):    print(f"  {G}✓{X}  {msg}")
def fail(msg):  print(f"  {R}✗{X}  {msg}")
def warn(msg):  print(f"  {Y}⚠{X}  {msg}")
def info(msg):  print(f"  {B}→{X}  {msg}")
def hdr(msg):   print(f"\n{W}{msg}{X}")
def dim(msg):   print(f"  {D}{msg}{X}")

STAGES = ['draft', 'dev_edit', 'eic_review', 'qa', 'maya', 'approved', 'published']

STAGE_LABELS = {
    'draft':       'Draft (Ruth)',
    'dev_edit':    'Dev Edit (Peter)',
    'eic_review':  'EIC Review (Ed)',
    'qa':          'QA (Jeff)',
    'maya':        'Maya Approval',
    'approved':    'Approved — awaiting distribution',
    'published':   'Published',
}

TRANSITIONS = [
    ('draft',      'dev_edit'),
    ('dev_edit',   'eic_review'),
    ('eic_review', 'qa'),
    ('qa',         'maya'),
    ('maya',       'approved'),
]

# ── Config ────────────────────────────────────────────────────────────────────

def load_config():
    env_path = Path(__file__).parent / '.env'
    cfg = {}
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                cfg[k.strip()] = v.strip()
    for k in ('CS_API_URL', 'CS_ADMIN_EMAIL'):
        if k not in cfg:
            cfg[k] = os.environ.get(k, '')
    if not cfg['CS_API_URL']:
        cfg['CS_API_URL'] = 'https://api.cybersense.solutions'
    # Password is never read from config — always prompted at runtime
    cfg['CS_ADMIN_PASSWORD'] = ''
    return cfg


def prompt_credentials(cfg):
    if not cfg['CS_ADMIN_EMAIL']:
        cfg['CS_ADMIN_EMAIL'] = input("  Admin email: ").strip()
    else:
        print(f"  Admin email: {cfg['CS_ADMIN_EMAIL']}")
    # Always prompt for password — never read from file
    cfg['CS_ADMIN_PASSWORD'] = getpass.getpass("  Admin password: ")
    return cfg


# ── API calls ─────────────────────────────────────────────────────────────────

class API:
    def __init__(self, base_url, dry_run=False):
        self.base = base_url.rstrip('/')
        self.dry_run = dry_run
        self.admin_token = None
        self.henry_token = None
        self.session = requests.Session()
        self.session.headers['Content-Type'] = 'application/json'
        self.session.timeout = 20

    def _url(self, path):
        return f"{self.base}{path}"

    def _post(self, path, body=None, auth=None):
        if self.dry_run:
            dim(f"[dry-run] POST {path}  body={json.dumps(body or {})}")
            return {'_dry_run': True}
        headers = {}
        if auth == 'admin':
            headers['Authorization'] = f"Bearer {self.admin_token}"
        elif auth == 'henry':
            headers['Authorization'] = f"Agent {self.henry_token}"
        r = self.session.post(self._url(path), json=body or {}, headers=headers)
        if not r.ok:
            raise RuntimeError(f"POST {path} → {r.status_code}: {r.text[:300]}")
        return r.json()

    def _get(self, path, auth=None, params=None):
        if self.dry_run:
            dim(f"[dry-run] GET {path}")
            return {}
        headers = {}
        if auth == 'admin':
            headers['Authorization'] = f"Bearer {self.admin_token}"
        elif auth == 'henry':
            headers['Authorization'] = f"Agent {self.henry_token}"
        r = self.session.get(self._url(path), headers=headers, params=params)
        if not r.ok:
            raise RuntimeError(f"GET {path} → {r.status_code}: {r.text[:300]}")
        return r.json()

    def _patch(self, path, body=None, auth=None):
        if self.dry_run:
            dim(f"[dry-run] PATCH {path}  body={json.dumps(body or {})}")
            return {'_dry_run': True}
        headers = {}
        if auth == 'admin':
            headers['Authorization'] = f"Bearer {self.admin_token}"
        elif auth == 'henry':
            headers['Authorization'] = f"Agent {self.henry_token}"
        r = self.session.patch(self._url(path), json=body or {}, headers=headers)
        if not r.ok:
            raise RuntimeError(f"PATCH {path} → {r.status_code}: {r.text[:300]}")
        return r.json()

    # ── Auth ─────────────────────────────────────────────────────────────────

    def admin_login(self, email, password):
        data = self._post('/api/auth/admin-login', {'email': email, 'password': password})
        if self.dry_run:
            self.admin_token = 'DRY_RUN_ADMIN_TOKEN'
            return
        if data.get('role') != 'gm':
            warn(f"Admin role is '{data.get('role')}' — some steps require 'gm'. Distribution confirmation may fail.")
        self.admin_token = data['admin_token']
        ok(f"Admin login OK  (role: {data.get('role', '?')})")

    def get_henry_token(self):
        info("Rotating Henry agent token via admin API…")
        data = self._post('/api/admin/agents/Henry/token', auth='admin')
        if self.dry_run:
            self.henry_token = 'DRY_RUN_HENRY_TOKEN'
            return
        self.henry_token = data['token']
        ok(f"Henry token issued  (rotated_at: {data.get('rotated_at', '?')})")

    # ── Briefing discovery ────────────────────────────────────────────────────

    def get_preview_briefings(self):
        data = self._get('/api/admin/briefings/preview', auth='admin')
        if self.dry_run:
            return []
        return data.get('data', [])

    def get_in_progress_briefings(self):
        """Return briefings at 'approved' status waiting for the human gate."""
        if self.dry_run:
            return []
        r = self.session.get(
            self._url('/api/admin/briefings/preview'),
            headers={'Authorization': f"Bearer {self.admin_token}"},
        )
        if not r.ok:
            warn(f"Could not fetch preview queue ({r.status_code}). Use --id to target a briefing directly.")
            return []
        return r.json().get('data', [])

    def get_briefing(self, briefing_id):
        if self.dry_run:
            return {'id': briefing_id, 'pipeline_status': 'draft',
                    'subject_line': '[DRY RUN]', 'edition_date': '2026-05-05',
                    'edition_number': 999}
        r = self.session.get(
            self._url(f'/api/admin/briefings/preview'),
            headers={'Authorization': f"Bearer {self.admin_token}"},
        )
        if r.ok:
            for b in r.json().get('data', []):
                if b['id'] == briefing_id:
                    return b
        return None

    # ── Pipeline advancement ──────────────────────────────────────────────────

    def advance_stage(self, briefing_id, to_status, notes=None):
        return self._patch(
            f'/api/pipeline/briefings/{briefing_id}/status',
            body={'to_status': to_status, 'agent_name': 'Henry',
                  'notes': notes or f'Manual trigger — Henry override'},
            auth='henry',
        )

    def confirm_distribution(self, briefing_id):
        return self._post(
            f'/api/admin/briefings/{briefing_id}/confirm-distribution',
            body={},
            auth='admin',
        )

    def release(self, briefing_id):
        return self._post(
            '/api/pipeline/release',
            body={'content_type': 'briefing', 'content_id': briefing_id, 'maya_approved': True},
            auth='henry',
        )


# ── Briefing selection ────────────────────────────────────────────────────────

def pick_briefing(api, explicit_id=None):
    if explicit_id:
        info(f"Targeting briefing ID: {explicit_id}")
        b = api.get_briefing(explicit_id)
        if not b and not api.dry_run:
            fail(f"Briefing {explicit_id} not found in approved queue. It may be at an earlier stage.")
            warn("Proceeding anyway — script will attempt to advance from whatever stage it is at.")
        return explicit_id, b or {}

    info("Querying for in-progress briefings…")
    candidates = api.get_in_progress_briefings()

    if not candidates:
        warn("No briefings found at 'approved' stage in the preview queue.")
        info("If your briefing is at an earlier stage (draft → maya), provide its ID directly.")
        info("Find the ID in the DB: SELECT id, edition_date, pipeline_status FROM briefings ORDER BY created_at DESC LIMIT 5;")
        bid = input("  Briefing ID (or press Enter to abort): ").strip()
        if not bid:
            fail("No briefing selected. Exiting.")
            sys.exit(0)
        return bid, {}

    if len(candidates) == 1:
        b = candidates[0]
        stage = b.get('pipeline_status', '?')
        info(f"Found 1 briefing: {b.get('edition_date', '?')} — \"{b.get('subject_line', '?')}\" [{stage}]")
        return b['id'], b

    print(f"\n  Found {len(candidates)} briefings:\n")
    for i, b in enumerate(candidates, 1):
        stage = b.get('pipeline_status', '?')
        print(f"  [{i}] {b.get('edition_date','?')}  {STAGE_LABELS.get(stage, stage)}")
        dim(f"       {b.get('subject_line', '(no subject)')}")
        dim(f"       id: {b['id']}")

    choice = input("\n  Select briefing [1]: ").strip() or '1'
    try:
        b = candidates[int(choice) - 1]
        return b['id'], b
    except (ValueError, IndexError):
        fail("Invalid selection.")
        sys.exit(1)


# ── Stage advancement ─────────────────────────────────────────────────────────

def stages_to_run(current_status):
    """Return the list of (from, to) transitions needed to reach approved."""
    idx = STAGES.index(current_status) if current_status in STAGES else 0
    return [(f, t) for f, t in TRANSITIONS if STAGES.index(f) >= idx]


def confirm_step(prompt, confirm_all):
    if confirm_all:
        return True
    ans = input(f"  {Y}?{X}  {prompt} [Y/n]: ").strip().lower()
    return ans in ('', 'y', 'yes')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='CyberSense manual pipeline trigger')
    parser.add_argument('--id',          metavar='BRIEFING_ID', help='Target a specific briefing by ID')
    parser.add_argument('--from-stage',  metavar='STAGE',       help='Override starting stage (skips earlier steps)')
    parser.add_argument('--confirm-all', action='store_true',   help='Skip per-step confirmations')
    parser.add_argument('--dry-run',     action='store_true',   help='Print steps without calling the API')
    parser.add_argument('--api',         metavar='URL',         help='API base URL override')
    args = parser.parse_args()

    print(f"\n{W}{'═' * 56}{X}")
    print(f"{W}  CyberSense — Manual Newsletter Pipeline Trigger{X}")
    print(f"{W}{'═' * 56}{X}")
    if args.dry_run:
        warn("DRY RUN — no API calls will be made\n")

    # ── Load config ──────────────────────────────────────────────────────────
    cfg = load_config()
    if args.api:
        cfg['CS_API_URL'] = args.api
    api = API(cfg['CS_API_URL'], dry_run=args.dry_run)

    # ── Auth ─────────────────────────────────────────────────────────────────
    hdr("Step 1 — Authentication")
    info(f"API: {cfg['CS_API_URL']}")
    for attempt in range(3):
        if not args.dry_run:
            cfg = prompt_credentials(cfg)
        try:
            api.admin_login(cfg['CS_ADMIN_EMAIL'], cfg['CS_ADMIN_PASSWORD'])
            break
        except RuntimeError as e:
            fail(str(e))
            if attempt < 2:
                warn("Try again. Check email, password, and that your account has gm role.")
                cfg['CS_ADMIN_EMAIL'] = ''  # force re-prompt
                cfg['CS_ADMIN_PASSWORD'] = ''
            else:
                fail("3 failed attempts. Exiting.")
                sys.exit(1)

    try:
        api.get_henry_token()
    except RuntimeError as e:
        fail(f"Failed to issue Henry token: {e}")
        sys.exit(1)

    # ── Select briefing ──────────────────────────────────────────────────────
    hdr("Step 2 — Select briefing")
    briefing_id, briefing_meta = pick_briefing(api, args.id)
    current_status = briefing_meta.get('pipeline_status', args.from_stage or 'draft')
    edition = briefing_meta.get('edition_number', '?')
    subject = briefing_meta.get('subject_line', '?')
    date    = briefing_meta.get('edition_date', '?')

    print(f"\n  {W}Target:{X}")
    print(f"    Edition : {edition}")
    print(f"    Date    : {date}")
    print(f"    Subject : {subject}")
    print(f"    Status  : {C}{STAGE_LABELS.get(current_status, current_status)}{X}")
    print(f"    ID      : {D}{briefing_id}{X}")

    if current_status == 'published':
        ok("This briefing is already published. Nothing to do.")
        sys.exit(0)

    # ── Plan ─────────────────────────────────────────────────────────────────
    hdr("Step 3 — Execution plan")
    pending = stages_to_run(current_status)

    if not pending:
        # Already at approved or later
        if current_status == 'approved':
            info("Briefing is already at approved. Proceeding to distribution gate.")
        else:
            warn(f"Unexpected status '{current_status}'. Will attempt distribution gate.")
    else:
        for from_s, to_s in pending:
            print(f"    {D}{STAGE_LABELS.get(from_s, from_s)}{X}  →  {STAGE_LABELS.get(to_s, to_s)}")
        print(f"    {STAGE_LABELS.get('approved', 'approved')}  →  {Y}Human gate (confirm-distribution){X}")
        print(f"    {Y}confirm-distribution{X}  →  {G}Release (published + email){X}")

    if not confirm_step("Proceed with this plan?", args.confirm_all):
        print("  Aborted.")
        sys.exit(0)

    # ── Advance through pipeline stages ──────────────────────────────────────
    hdr("Step 4 — Pipeline advancement")
    total_steps = len(pending) + 2  # stages + gate + release
    step_n = 0

    for from_s, to_s in pending:
        step_n += 1
        label = f"Advance: {STAGE_LABELS.get(from_s, from_s)} → {STAGE_LABELS.get(to_s, to_s)}"
        print(f"\n  [{step_n}/{total_steps}] {label}")

        if not confirm_step(f"Advance to {to_s}?", args.confirm_all):
            warn("Skipped. Remaining steps will be skipped too.")
            break

        try:
            result = api.advance_stage(briefing_id, to_s)
            if not api.dry_run:
                ok(f"Advanced to '{to_s}'")
            else:
                ok(f"Would advance to '{to_s}'")
        except RuntimeError as e:
            fail(f"Stage advance failed: {e}")
            fail("Pipeline halted. Fix the issue and re-run with --from-stage " + to_s)
            sys.exit(1)

    # ── Human gate: confirm-distribution ─────────────────────────────────────
    step_n += 1
    print(f"\n  [{step_n}/{total_steps}] {Y}Human-in-the-Loop Gate — Confirm Distribution{X}")
    print(f"  {D}This is your executive authorization. Logs an audit record.{X}")

    if not confirm_step("Authorize distribution? This will task Laura + schedule Oliver at 0700 CT.", args.confirm_all):
        warn("Distribution not confirmed. Briefing remains at 'approved'. Run again when ready.")
        sys.exit(0)

    try:
        gate_result = api.confirm_distribution(briefing_id)
        if not api.dry_run:
            ok("Distribution confirmed")
            scheduled = gate_result.get('scheduled_post_at', '?')
            dim(f"  Oliver LinkedIn post scheduled: {scheduled}")
            dim(f"  Laura task ID: {gate_result.get('laura_task_id', '?')}")
    except RuntimeError as e:
        fail(f"Distribution confirmation failed: {e}")
        fail("Briefing is at 'approved'. You can retry confirm-distribution from the admin console.")
        sys.exit(1)

    # ── Release — mark published + send email ─────────────────────────────────
    step_n += 1
    print(f"\n  [{step_n}/{total_steps}] {G}Release — Mark Published + Send Email{X}")
    print(f"  {D}Marks briefing as published and triggers SendGrid email to subscribers.{X}")

    if not confirm_step("Release briefing (triggers subscriber email delivery)?", args.confirm_all):
        warn("Release skipped. Call POST /api/pipeline/release manually when ready.")
        sys.exit(0)

    try:
        rel_result = api.release(briefing_id)
        if not api.dry_run:
            ok("Released. Briefing marked published.")
            dim(f"  published_at: {rel_result.get('published_at', '?')}")
        else:
            ok("Would release briefing.")
    except RuntimeError as e:
        fail(f"Release failed: {e}")
        warn("Briefing is confirmed for distribution but not published. Call:")
        warn(f"  POST /api/pipeline/release  {{content_type:'briefing', content_id:'{briefing_id}', maya_approved:true}}")
        sys.exit(1)

    # ── Done ─────────────────────────────────────────────────────────────────
    print(f"\n{G}{'═' * 56}{X}")
    print(f"{G}  Pipeline complete — Edition {edition} is published.{X}")
    print(f"{G}{'═' * 56}{X}\n")


if __name__ == '__main__':
    main()
