'use strict';

const jwt = require('jsonwebtoken');
const db = require('../db/queries');

const TIER_RANK = { free: 0, freemium: 1, monthly: 2, enterprise: 3 };

const PIPELINE_TRANSITIONS = {
  article: {
    draft: ['dev_edit'],
    dev_edit: ['eic_review', 'draft'],
    eic_review: ['qa', 'draft'],
    qa: ['maya', 'draft'],
    maya: ['approved', 'draft'],
    approved: ['published'],
    published: [],
  },
  briefing: {
    draft: ['dev_edit'],
    dev_edit: ['eic_review', 'draft'],
    eic_review: ['qa', 'draft'],
    qa: ['maya', 'draft'],
    maya: ['approved', 'draft'],
    approved: ['published'],
    published: [],
  },
  training: {
    draft: ['qa'],
    qa: ['maya', 'draft'],
    maya: ['published', 'draft'],
    published: [],
  },
};

const AGENT_PERMISSIONS = {
  Rick:    { teams: ['acquisition'], endpoints: ['pipeline:threat-records', 'tasks:write', 'ops:escalate'] },
  'Ivan/Charlie': { teams: ['acquisition'], endpoints: ['pipeline:intel-items', 'tasks:write', 'ops:escalate'] },
  Barbara: { teams: ['analyst'], endpoints: ['pipeline:repository', 'pipeline:repository:process', 'tasks:write', 'ops:escalate'] },
  Laura:   { teams: ['analyst'], endpoints: ['pipeline:release', 'tasks:write', 'ops:escalate', 'tasks:read'] },
  Jim:     { teams: ['analyst'], endpoints: ['revenue:read', 'sales:accounts:read', 'tasks:write'] },
  Jeff:    { teams: ['analyst'], endpoints: ['pipeline:articles:status', 'pipeline:briefings:status', 'pipeline:training:status', 'tasks:write', 'ops:escalate'] },
  James:   { teams: ['intel'], endpoints: ['pipeline:repository:queue', 'pipeline:articles', 'pipeline:articles:status', 'tasks:write', 'ops:escalate'] },
  Jason:   { teams: ['intel'], endpoints: ['pipeline:articles:status', 'tasks:write', 'ops:escalate'] },
  Rob:     { teams: ['intel'], endpoints: ['pipeline:articles:status', 'tasks:write', 'ops:escalate'] },
  Ruth:    { teams: ['awareness'], endpoints: ['pipeline:repository:queue', 'pipeline:briefings', 'pipeline:briefings:status', 'tasks:write', 'ops:escalate'] },
  Peter:   { teams: ['awareness'], endpoints: ['pipeline:briefings:status', 'tasks:write', 'ops:escalate'] },
  Ed:      { teams: ['awareness'], endpoints: ['pipeline:briefings:status', 'tasks:write', 'ops:escalate'] },
  Kirby:   { teams: ['training'], endpoints: ['pipeline:training:modules', 'pipeline:training:status', 'tasks:write', 'training:simulations', 'ops:escalate'] },
  Mario:   { teams: ['training'], endpoints: ['pipeline:training:status', 'tasks:write', 'ops:escalate'] },
  Matt:    { teams: ['training'], endpoints: ['pipeline:training:status', 'tasks:write', 'ops:escalate'] },
  Mary:    { teams: ['sales'], endpoints: ['sales:leads', 'tasks:write', 'ops:escalate'] },
  William: { teams: ['sales'], endpoints: ['sales:leads', 'sales:accounts', 'sales:partners', 'tasks:write', 'ops:escalate'] },
  Joe:     { teams: ['sales'], endpoints: ['sales:accounts', 'tasks:write', 'ops:escalate'] },
  Oliver:  { teams: ['social'], endpoints: ['social:posts', 'social:posts:metrics', 'tasks:write', 'ops:escalate'] },
  Lucy:    { teams: ['social'], endpoints: ['social:posts', 'social:posts:metrics', 'tasks:write', 'ops:escalate'] },
  Riley:   { teams: ['social'], endpoints: ['social:posts', 'social:posts:metrics', 'tasks:write', 'ops:escalate'] },
  Ethan:   { teams: ['social'], endpoints: ['social:posts', 'social:posts:metrics', 'tasks:write', 'ops:escalate'] },
  Henry:   { teams: ['management'], endpoints: ['*'] },
  Valerie: { teams: ['management'], endpoints: ['ops:read', 'revenue:read', 'sales:read', 'tasks:read'] },
  Victor:  { teams: ['management'], endpoints: ['ops:risk', 'ops:escalate', 'pipeline:articles:status', 'tasks:read'] },
  Barret:  { teams: ['management'], endpoints: ['ops:read', 'ops:escalate', 'tasks:read', 'ops:sla'] },
  Maya:    { teams: ['management'], endpoints: ['pipeline:articles:status', 'pipeline:briefings:status', 'pipeline:training:status', 'tasks:read', 'ops:escalate'] },
  Alex:    { teams: ['management'], endpoints: ['training:read', 'pipeline:training:status', 'tasks:read'] },
};

const ADMIN_ROLE_SECTIONS = {
  gm:       ['command', 'radar', 'intel', 'innovation', 'newsletter', 'training', 'social', 'financial', 'sales', 'risk'],
  editor:   ['intel', 'newsletter', 'radar'],
  analyst:  ['command', 'financial', 'sales', 'risk'],
  sales:    ['sales', 'financial'],
  training: ['training'],
};

function requireUserToken(minTier = 'free') {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return res.status(401).json(err('NO_TOKEN', 'Authentication required'));

      const token = header.slice(7);
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.type !== 'user') return res.status(403).json(err('WRONG_TOKEN_TYPE', 'User token required'));

      const user = await db.getUserById(payload.user_id);
      if (!user || user.deleted_at) return res.status(401).json(err('USER_NOT_FOUND', 'User not found'));

      if (TIER_RANK[user.tier] < TIER_RANK[minTier]) {
        return res.status(403).json(err('INSUFFICIENT_TIER', `This resource requires ${minTier} tier or above`));
      }

      req.user = user;
      next();
    } catch (e) {
      if (e.name === 'TokenExpiredError') return res.status(401).json(err('TOKEN_EXPIRED', 'Token has expired'));
      return res.status(401).json(err('INVALID_TOKEN', 'Invalid token'));
    }
  };
}

function requireAdminToken(allowedRoles = []) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return res.status(401).json(err('NO_TOKEN', 'Authentication required'));

      const token = header.slice(7);
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.type !== 'admin') return res.status(403).json(err('WRONG_TOKEN_TYPE', 'Admin token required'));

      const adminRole = await db.getAdminRole(payload.user_id);
      if (!adminRole) return res.status(403).json(err('NOT_ADMIN', 'Admin access not granted'));

      if (allowedRoles.length && !allowedRoles.includes(adminRole.role)) {
        return res.status(403).json(err('ROLE_INSUFFICIENT', `Requires role: ${allowedRoles.join(' or ')}`));
      }

      req.user = await db.getUserById(payload.user_id);
      req.adminRole = adminRole;
      next();
    } catch (e) {
      if (e.name === 'TokenExpiredError') return res.status(401).json(err('TOKEN_EXPIRED', 'Token has expired'));
      return res.status(401).json(err('INVALID_TOKEN', 'Invalid token'));
    }
  };
}

function requireAgentToken(allowedAgents = []) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Agent ')) return res.status(401).json(err('NO_AGENT_TOKEN', 'Agent token required'));

      const token = header.slice(6);
      const payload = jwt.verify(token, process.env.AGENT_JWT_SECRET);
      if (payload.type !== 'agent') return res.status(403).json(err('WRONG_TOKEN_TYPE', 'Agent token required'));

      const agentRecord = await db.getAgentToken(payload.agent_name);
      if (!agentRecord || agentRecord.token_hash !== hashToken(token)) {
        return res.status(401).json(err('INVALID_AGENT_TOKEN', 'Agent token invalid or rotated'));
      }

      if (allowedAgents.length && !allowedAgents.includes(payload.agent_name)) {
        return res.status(403).json(err('AGENT_NOT_PERMITTED', `Agent ${payload.agent_name} not permitted for this endpoint`));
      }

      req.agent = { name: payload.agent_name, team: payload.agent_team, permissions: AGENT_PERMISSIONS[payload.agent_name] };
      next();
    } catch (e) {
      if (e.name === 'TokenExpiredError') return res.status(401).json(err('TOKEN_EXPIRED', 'Agent token expired'));
      return res.status(401).json(err('INVALID_TOKEN', 'Invalid agent token'));
    }
  };
}

function gateContent(article, userTier) {
  if (TIER_RANK[userTier] >= TIER_RANK[article.access_tier]) return article;
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    section: article.section,
    published_at: article.published_at,
    read_time_min: article.read_time_min,
    access_tier: article.access_tier,
    blurred: true,
    teaser: article.body_md ? article.body_md.slice(0, 280) + '…' : null,
  };
}

function validatePipelineTransition(contentType, fromStatus, toStatus, agentName, content) {
  const map = PIPELINE_TRANSITIONS[contentType];
  if (!map) return { valid: false, reason: `Unknown content type: ${contentType}` };

  const allowed = map[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    return { valid: false, reason: `Invalid transition: ${fromStatus} → ${toStatus} for ${contentType}` };
  }

  if (['maya', 'approved', 'published'].includes(toStatus) && !content.qa_passed_at) {
    return { valid: false, reason: 'Cannot advance past qa stage without qa_passed_at timestamp' };
  }
  if (toStatus === 'published' && !content.maya_approved_at) {
    return { valid: false, reason: 'Cannot advance past maya stage without maya_approved_at timestamp' };
  }

  const STAGE_AGENTS = {
    dev_edit: ['Jason', 'Peter'],
    eic_review: ['Rob', 'Ed'],
    qa: ['Jeff'],
    maya: ['Maya'],
    approved: ['Maya'],
    published: ['Laura'],
  };

  const permitted = STAGE_AGENTS[toStatus];
  if (permitted && !permitted.includes(agentName) && agentName !== 'Henry') {
    return { valid: false, reason: `Agent ${agentName} is not permitted to advance content to ${toStatus}` };
  }

  return { valid: true };
}

function hashToken(token) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(token).digest('hex');
}

function err(code, message, field) {
  return { error: { code, message, ...(field ? { field } : {}) } };
}

module.exports = {
  requireUserToken,
  requireAdminToken,
  requireAgentToken,
  gateContent,
  validatePipelineTransition,
  TIER_RANK,
  ADMIN_ROLE_SECTIONS,
  AGENT_PERMISSIONS,
  err,
};
