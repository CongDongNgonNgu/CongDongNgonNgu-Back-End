-- Stop context producers first. Never silently discard retained references.
LOCK TABLE direct_messages IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM direct_messages WHERE context_type IS NOT NULL OR context_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Retained message contexts exist; preserve them before downgrade';
  END IF;
END $$;
ALTER TABLE direct_messages
  DROP CONSTRAINT direct_messages_text_or_context_check,
  DROP CONSTRAINT direct_messages_context_reference_check,
  DROP COLUMN context_type,
  DROP COLUMN context_id,
  ADD CONSTRAINT direct_messages_text_check CHECK (char_length(text) BETWEEN 1 AND 4000);
