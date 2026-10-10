-- Canonical references only. Target eligibility is resolved live, never copied.
ALTER TABLE direct_messages
  ADD COLUMN context_type text,
  ADD COLUMN context_id uuid,
  ADD CONSTRAINT direct_messages_context_reference_check CHECK (
    (context_type IS NULL AND context_id IS NULL)
    OR (context_type IS NOT NULL AND context_id IS NOT NULL
      AND context_type IN ('LIBRARY_RESOURCE', 'COMMUNITY_POST'))
  );

-- Existing text-only rows still satisfy this constraint. A context-only message
-- stores an empty string, preserving the non-null text wire/storage contract.
ALTER TABLE direct_messages
  DROP CONSTRAINT direct_messages_text_check,
  ADD CONSTRAINT direct_messages_text_or_context_check CHECK (
    char_length(text) <= 4000 AND (char_length(text) > 0 OR context_type IS NOT NULL)
  );
