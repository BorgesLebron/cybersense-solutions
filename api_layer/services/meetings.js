'use strict';

/**
 * api_layer/services/meetings.js
 * Logic for structured meeting templates and business rules.
 */

const db = require('../db/queries');

const MEETING_TEMPLATES = {
  sync: {
    title: 'Weekly Sync Meeting',
    type: 'operational',
    lead: 'Barret',
    decision_maker: 'Henry',
    records_agent: 'Laura',
    agenda: `
- Unsolved matters
- Department status
- Current week Goals
- Two weeks ahead
- Requests from other departments
- Victor: Risk Assessment
    `.trim()
  },
  security: {
    title: 'Weekly Security Briefing',
    type: 'security',
    lead: 'Cy',
    decision_maker: 'Henry',
    records_agent: 'Paige',
    agenda: `
- Application Status/Health (Nora)
- System Vulnerabilities (Owen)
- Credential/Access Issues (Quinn)
- Playbook Amendments (Paige)
- Requisitions from IT/Security
    `.trim()
  },
  training: {
    title: 'Training & Production Meeting',
    type: 'training',
    lead: 'Barret',
    decision_maker: 'Henry',
    records_agent: 'Mario',
    agenda: `
- Current trends and projections (Barbara)
- Risk assessment (Victor)
- Topic selection and themes (Maya)
- Marketing & KPIs (Valerie)
- Training status & Next projects (Alex)
    `.trim()
  },
  eow: {
    title: 'End of Week Update',
    type: 'operational',
    lead: 'Laura',
    decision_maker: 'Henry',
    records_agent: 'Valerie',
    agenda: `
- Week Results
- Unsolved matters
- Next weeks Goals
- Two weeks ahead
- Victor: EOW Risk Analysis
    `.trim()
  }
};

/**
 * Creates a meeting based on a template.
 */
async function createMeetingFromTemplate(template_type, initiated_by) {
  const tpl = MEETING_TEMPLATES[template_type];
  if (!tpl) throw new Error(`INVALID_TEMPLATE: ${template_type}`);

  return db.createMeeting({
    title: tpl.title,
    type: tpl.type,
    convener: tpl.lead,
    initiated_by: initiated_by,
    agenda: tpl.agenda,
    lead: tpl.lead,
    decision_maker: tpl.decision_maker,
    records_agent: tpl.records_agent
  });
}

module.exports = {
  MEETING_TEMPLATES,
  createMeetingFromTemplate
};
