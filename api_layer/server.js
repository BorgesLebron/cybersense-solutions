'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { requestLogger, errorHandler } = require('./middleware/logger');
const enterpriseRoutes = require('./routes/enterprise');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const contentRoutes = require('./routes/content');
const pipelineRoutes = require('./routes/pipeline');
const taskRoutes = require('./routes/tasks');
const trainingRoutes = require('./routes/training');
const revenueRoutes = require('./routes/revenue');
const salesRoutes = require('./routes/sales');
const opsRoutes = require('./routes/ops');
const socialRoutes = require('./routes/social');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://cybersense.solutions'],
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(requestLogger);

const unauthLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ip,
  skip: (req) => !!req.headers.authorization,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
});

const userLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.user?.id || req.ip,
  skip: (req) => req.agent != null,
  message: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded.' } },
});

const agentLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  keyGenerator: (req) => req.agent?.name || req.ip,
  skip: (req) => req.agent == null,
  message: { error: { code: 'RATE_LIMITED', message: 'Agent rate limit exceeded.' } },
});

app.use('/api/auth', unauthLimit, authRoutes);
app.use('/api/users', userLimit, agentLimit, userRoutes);
app.use('/api/content', userLimit, agentLimit, contentRoutes);
app.use('/api/pipeline', agentLimit, pipelineRoutes);
app.use('/api/tasks', userLimit, agentLimit, taskRoutes);
app.use('/api/training', userLimit, agentLimit, trainingRoutes);
app.use('/api/revenue', userLimit, agentLimit, revenueRoutes);
app.use('/api/sales', userLimit, agentLimit, salesRoutes);
app.use('/api/ops', userLimit, agentLimit, opsRoutes);
app.use('/api/social', agentLimit, socialRoutes);
app.use('/api/admin', userLimit, adminRoutes);

app.use('/api/enterprise', userLimit, agentLimit, enterpriseRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'SERVER_START', port: PORT, env: process.env.NODE_ENV }));
  if (process.env.NODE_ENV === 'production') {
    const { startScheduler } = require('./services/scheduler');
    startScheduler();
  }
});

module.exports = app;
