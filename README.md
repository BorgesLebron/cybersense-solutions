# CyberSense.Solutions

Public website for CyberSense — hosted on GitHub Pages, DNS via Cloudflare.

---

## Repo setup

This is a **separate repo** from your portfolio (`hectorborges-portfolio`).
Keep them independent — clean deploys, no conflicts.

```
cybersense-solutions/
├── index.html     ← Landing page (you are here)
├── CNAME          ← Tells GitHub Pages to serve on CyberSense.Solutions
└── README.md
```

---

## Deploying to GitHub Pages

1. Create a new GitHub repo named `cybersense-solutions`
2. Push this folder to the `main` branch
3. Go to repo **Settings → Pages**
4. Set source: **Deploy from branch → main → / (root)**
5. GitHub will show a Pages URL like `borgeslebron.github.io/cybersense-solutions`

---

## Connecting CyberSense.Solutions via Cloudflare

### Step 1 — Get GitHub Pages IPs
GitHub Pages uses these four IPs:
```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

### Step 2 — Add DNS records in Cloudflare
Go to your Cloudflare dashboard → CyberSense.Solutions domain → DNS:

| Type  | Name | Content                | Proxy   |
|-------|------|------------------------|---------|
| A     | @    | 185.199.108.153        | DNS only (grey cloud) |
| A     | @    | 185.199.109.153        | DNS only |
| A     | @    | 185.199.110.153        | DNS only |
| A     | @    | 185.199.111.153        | DNS only |
| CNAME | www  | borgeslebron.github.io | DNS only |

> **Important**: Set to "DNS only" (grey cloud), NOT proxied, while
> GitHub Pages is provisioning your SSL certificate. You can enable
> Cloudflare proxy after the cert is active (~10 min).

### Step 3 — Set custom domain in GitHub
Back in repo **Settings → Pages → Custom domain**:
Type `CyberSense.Solutions` and save.
GitHub will verify DNS and provision HTTPS automatically.

### Step 4 — Enable HTTPS
Once DNS propagates, tick **Enforce HTTPS** in GitHub Pages settings.

---

## Adding pages over time

As CyberSense grows, add HTML files to this repo:

```
index.html          ← landing page (done)
archive.html        ← newsletter archive index
radar.html          ← radar teaser / subscriber login CTA
training.html       ← training byte library
career.html         ← career development events
modernization.html  ← AI & quantum insights
```

Each file is automatically served at its path:
`CyberSense.Solutions/archive.html` → `cybersense.solutions/archive`

---

## Keeping the newsletter archive in sync

Your current newsletter HTMLs live in `hectorborges-portfolio/newsletter/`.
Two options going forward:

1. **Mirror** — copy new issues to both repos (simple, manual)
2. **Redirect** — keep issues in portfolio repo, link to them from CyberSense.Solutions
   (recommended for now — no duplication)

The archive links in `index.html` currently point to `hectorborges.com/newsletter/`.
Update them as your archive grows.
