'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db/queries');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/sendgrid');
const { err } = require('../middleware/auth');

const REFRESH_DAYS = 7;
const ACCESS_MINUTES = 15;

function signAccess(user) {
  return jwt.sign(
    { type: 'user', user_id: user.id, tier: user.tier, org_id: user.org_id },
    process.env.JWT_SECRET,
    { expiresIn: `${ACCESS_MINUTES}m` }
  );
}

function signRefresh(user) {
  return jwt.sign(
    { type: 'refresh', user_id: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: `${REFRESH_DAYS}d` }
  );
}

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password || !full_name) return res.status(400).json(err('MISSING_FIELDS', 'email, password, and full_name are required'));
    if (password.length < 12) return res.status(400).json(err('WEAK_PASSWORD', 'Password must be at least 12 characters', 'password'));

    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(409).json(err('EMAIL_EXISTS', 'An account with this email already exists', 'email'));

    const password_hash = await bcrypt.hash(password, 12);
    const user = await db.createUser({ email, password_hash, full_name });

    const verifyToken = crypto.randomBytes(32).toString('hex');
    await db.createSession({
      user_id: user.id,
      token_hash: crypto.createHash('sha256').update(verifyToken).digest('hex'),
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await sendVerificationEmail(user.email, user.full_name, verifyToken);

    res.status(201).json({ user_id: user.id, message: 'Account created. Please verify your email.' });
  } catch (e) { next(e); }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json(err('MISSING_FIELDS', 'email and password are required'));

    const user = await db.getUserByEmail(email);
    if (!user) return res.status(401).json(err('INVALID_CREDENTIALS', 'Invalid email or password'));

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json(err('INVALID_CREDENTIALS', 'Invalid email or password'));

    if (!user.email_verified) return res.status(403).json(err('EMAIL_NOT_VERIFIED', 'Please verify your email before logging in'));

    await db.updateLastLogin(user.id);
    const access_token = signAccess(user);
    const refresh_token = signRefresh(user);

    const hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    await db.deleteSession(user.id);
    await db.createSession({
      user_id: user.id,
      token_hash: hash,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      expires_at: new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000),
    });

    res.cookie('cs_refresh', refresh_token, {
      httpOnly: true, secure: true, sameSite: 'strict',
      maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
    });

    res.json({ access_token, user: { id: user.id, email: user.email, full_name: user.full_name, tier: user.tier, org_id: user.org_id } });
  } catch (e) { next(e); }
});

// POST /api/auth/admin-login
router.post('/admin-login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json(err('MISSING_FIELDS', 'email and password required'));

    const user = await db.getUserByEmail(email);
    if (!user || user.deleted_at) return res.status(401).json(err('INVALID_CREDENTIALS', 'Invalid email or password'));

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json(err('INVALID_CREDENTIALS', 'Invalid email or password'));

    const adminRole = await db.getAdminRole(user.id);
    if (!adminRole) return res.status(403).json(err('NOT_ADMIN', 'Admin access not granted'));

    const adminToken = jwt.sign(
      { type: 'admin', user_id: user.id, role: adminRole.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ admin_token: adminToken, role: adminRole.role });
  } catch (e) { next(e); }
});


// POST /api/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.cs_refresh;
    if (!token) return res.status(401).json(err('NO_REFRESH_TOKEN', 'Refresh token not found'));

    let payload;
    try { payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET); }
    catch (e) { return res.status(401).json(err('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired')); }

    const user = await db.getUserById(payload.user_id);
    if (!user) return res.status(401).json(err('USER_NOT_FOUND', 'User not found'));

    const access_token = signAccess(user);
    res.json({ access_token });
  } catch (e) { next(e); }
});

// POST /api/auth/logout
router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.cs_refresh;
    if (token) {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      await db.deleteSessionByToken(hash);
    }
    res.clearCookie('cs_refresh');
    res.json({ message: 'Logged out successfully' });
  } catch (e) { next(e); }
});

// POST /api/auth/verify-email
router.post('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json(err('MISSING_TOKEN', 'Verification token is required'));

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await db.pool.query(
      'SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()', [hash]
    ).then(r => r.rows[0]);

    if (!session) return res.status(400).json(err('INVALID_TOKEN', 'Verification token is invalid or has expired'));

    const user = await db.setEmailVerified(session.user_id);
    await db.deleteSessionByToken(hash);

    const access_token = signAccess(user);
    res.json({ access_token, message: 'Email verified. Welcome to CyberSense.' });
  } catch (e) { next(e); }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json(err('MISSING_FIELDS', 'email is required'));

    const user = await db.getUserByEmail(email);
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHash('sha256').update(resetToken).digest('hex');
      await db.createSession({
        user_id: user.id, token_hash: hash, ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      });
      await sendPasswordResetEmail(user.email, user.full_name, resetToken);
    }
    res.json({ message: 'If an account exists for this email, a reset link has been sent.' });
  } catch (e) { next(e); }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json(err('MISSING_FIELDS', 'token and password are required'));
    if (password.length < 12) return res.status(400).json(err('WEAK_PASSWORD', 'Password must be at least 12 characters', 'password'));

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await db.pool.query(
      'SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()', [hash]
    ).then(r => r.rows[0]);

    if (!session) return res.status(400).json(err('INVALID_TOKEN', 'Reset token is invalid or has expired'));

    const password_hash = await bcrypt.hash(password, 12);
    await db.updateUser(session.user_id, { password_hash });
    await db.deleteSessionByToken(hash);

    res.json({ message: 'Password reset successfully. Please log in.' });
  } catch (e) { next(e); }
});

module.exports = router;
