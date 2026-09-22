ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_assignment_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assignment_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_assignment_rules_array;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_assignment_rules_array
  CHECK (jsonb_typeof(auto_assignment_rules) = 'array');