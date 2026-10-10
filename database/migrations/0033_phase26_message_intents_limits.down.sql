-- Stop producers first. Do not discard undelivered notification intent on downgrade.
LOCK TABLE direct_message_notification_intents, direct_message_rate_limits IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM direct_message_notification_intents) THEN
    RAISE EXCEPTION 'Pending message intent exists; drain or preserve it before downgrade';
  END IF;
END $$;
DROP TABLE direct_message_notification_intents;
DROP TABLE direct_message_rate_limits;
