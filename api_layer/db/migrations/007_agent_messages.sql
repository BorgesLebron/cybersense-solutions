-- Persist operator/agent chat history so department heads can troubleshoot
-- from Command Center instead of depending on transient UI responses.

CREATE TABLE IF NOT EXISTS agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL,
  task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
  content_type pipeline_content_type NOT NULL DEFAULT 'system',
  content_id UUID,
  from_role VARCHAR(20) NOT NULL CHECK (from_role IN ('user', 'agent', 'system')),
  from_name VARCHAR(100) NOT NULL,
  to_agent VARCHAR(100),
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_task ON agent_messages(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_agent ON agent_messages(to_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_content ON agent_messages(content_type, content_id, created_at DESC);
