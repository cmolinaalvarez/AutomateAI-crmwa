ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS audio_mode text NOT NULL DEFAULT 'text_only';

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_audio_mode_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_audio_mode_check
  CHECK (audio_mode IN ('text_only', 'first_audio', 'full_audio'));