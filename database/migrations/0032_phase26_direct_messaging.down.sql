-- Code first: stop messaging writers before rollback. Retained private history must
-- never be erased to make a schema downgrade succeed. Empty disposable schemas only.
LOCK TABLE direct_conversations, direct_messages IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM direct_conversations) OR EXISTS (SELECT 1 FROM direct_messages) THEN
    RAISE EXCEPTION 'Direct conversation data exists; preserve history and use a reviewed recovery plan';
  END IF;
END $$;
DROP TABLE direct_messages;
DROP TABLE direct_conversations;
