process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret';
process.env.AGENT_JWT_SECRET = process.env.AGENT_JWT_SECRET || 'test_agent_secret';
process.env.INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'test_internal_secret';
process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || 'SG.test_key';
process.env.FROM_EMAIL = process.env.FROM_EMAIL || 'test@cybersense.solutions';
