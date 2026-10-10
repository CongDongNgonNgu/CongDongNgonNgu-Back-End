-- Stop stream producers first. Only expired, disposable lease metadata may be discarded.
LOCK TABLE direct_message_stream_leases, direct_message_rate_limits IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM direct_message_stream_leases WHERE expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Live message streams exist; stop producers and expire leases before downgrade';
  END IF;
END $$;
DROP TABLE direct_message_stream_leases;
DELETE FROM direct_message_rate_limits WHERE bucket='STREAM_MINUTE';
ALTER TABLE direct_message_rate_limits DROP CONSTRAINT direct_message_rate_limits_bucket_check;
ALTER TABLE direct_message_rate_limits ADD CONSTRAINT direct_message_rate_limits_bucket_check
  CHECK (bucket IN ('SEND_MINUTE','SEND_HOUR'));
