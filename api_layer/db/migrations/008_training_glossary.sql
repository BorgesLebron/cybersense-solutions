-- Migration 008 — Training Glossary
-- Transitioning hardcoded glossary terms to the database

BEGIN;

CREATE TABLE IF NOT EXISTS training_glossary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    term TEXT UNIQUE NOT NULL,
    definition TEXT NOT NULL,
    category TEXT DEFAULT 'General',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial terms from training.html
INSERT INTO training_glossary (term, definition, category) VALUES
('APT (Advanced Persistent Threat)', 'A sophisticated, typically state-sponsored threat actor that employs multiple attack vectors to gain unauthorized access and maintain long-term persistence within a target network, often with objectives beyond immediate financial gain.', 'Threat Actors'),
('CVSS (Common Vulnerability Scoring System)', 'A standardized framework for rating the severity of security vulnerabilities on a scale from 0.0 to 10.0, incorporating metrics for exploitability, scope, and impact across confidentiality, integrity, and availability dimensions.', 'Vulnerability Management'),
('Lateral Movement', 'Post-exploitation techniques used by attackers to progressively move through a network from their initial access point to high-value targets, typically leveraging compromised credentials, RDP, PsExec, or protocol exploitation.', 'Attacker Techniques'),
('LOLBin (Living Off the Land Binary)', 'Legitimate, pre-installed operating system binaries that attackers abuse to execute malicious actions, evading signature-based detection by using trusted system tools like certutil.exe, mshta.exe, or PowerShell.', 'Attacker Techniques'),
('MFA Fatigue Attack', 'A social engineering technique where attackers who have already obtained valid credentials flood a target with MFA push notifications, hoping the user will approve one out of frustration or confusion. Mitigated by number matching and phishing-resistant MFA like FIDO2.', 'Social Engineering'),
('MITRE ATT&CK', 'A globally-accessible knowledge base of adversary tactics and techniques based on real-world observations, widely used by security teams for threat modeling, detection development, and red team exercise planning.', 'Frameworks'),
('Pass-the-Hash', 'An authentication attack technique where an attacker uses a captured NTLM password hash to authenticate to network services without needing to know the plaintext password, commonly used in lateral movement within Active Directory environments.', 'Attacker Techniques'),
('Supply Chain Attack', 'An attack that targets the trusted third-party components, software, or services an organization depends on – rather than the organization directly – to gain unauthorized access through a trusted distribution channel. SolarWinds Orion and XZ Utils are prominent examples.', 'Threat Vectors'),
('Threat Intelligence (TI)', 'Evidence-based knowledge about existing or emerging adversary capabilities, infrastructure, and motivations that enables informed decision-making for defenders. Distinct from raw data – intelligence has been analyzed, contextualized, and validated.', 'Intelligence'),
('Zero-Day Vulnerability', 'A software vulnerability that is unknown to the software vendor and therefore has no available patch at the time of discovery or exploitation. Zero-days command significant value in both criminal and government markets due to their effectiveness against fully patched systems.', 'Vulnerability Management')
ON CONFLICT (term) DO NOTHING;

COMMIT;
