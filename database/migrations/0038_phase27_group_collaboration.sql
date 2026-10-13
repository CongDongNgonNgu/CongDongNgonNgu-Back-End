-- Existing group domain only; deterministic backfill, no message snapshots.
ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS text_sequence bigint NOT NULL DEFAULT 0 CHECK(text_sequence>=0);
ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS change_version bigint NOT NULL DEFAULT 0 CHECK(change_version>=0);
ALTER TABLE study_group_texts ADD COLUMN IF NOT EXISTS sequence bigint;
WITH positions AS (SELECT id,row_number() OVER(PARTITION BY group_id ORDER BY created_at,id) AS sequence FROM study_group_texts)
 UPDATE study_group_texts t SET sequence=p.sequence FROM positions p WHERE p.id=t.id AND t.sequence IS NULL;
ALTER TABLE study_group_texts ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE study_group_texts DROP CONSTRAINT IF EXISTS study_group_text_positive_sequence;
ALTER TABLE study_group_texts ADD CONSTRAINT study_group_text_positive_sequence CHECK(sequence>0);
CREATE UNIQUE INDEX IF NOT EXISTS study_group_text_sequence_idx ON study_group_texts(group_id,sequence);
UPDATE study_groups g SET text_sequence=COALESCE((SELECT max(t.sequence) FROM study_group_texts t WHERE t.group_id=g.id),0)
 WHERE g.text_sequence=0;
ALTER TABLE study_group_texts ADD COLUMN IF NOT EXISTS client_message_id uuid;
ALTER TABLE study_group_texts ADD COLUMN IF NOT EXISTS context_type text;
ALTER TABLE study_group_texts ADD COLUMN IF NOT EXISTS context_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS study_group_text_client_idx ON study_group_texts(group_id,author_user_id,client_message_id) WHERE client_message_id IS NOT NULL;
ALTER TABLE study_group_texts DROP CONSTRAINT IF EXISTS study_group_texts_body_check;
ALTER TABLE study_group_texts DROP CONSTRAINT IF EXISTS study_group_context_check;
ALTER TABLE study_group_texts ADD CONSTRAINT study_group_context_check CHECK((context_type IS NULL AND context_id IS NULL) OR (context_type IS NOT NULL AND context_id IS NOT NULL AND context_type IN ('LIBRARY_RESOURCE','COMMUNITY_POST')));
ALTER TABLE study_group_texts ADD CONSTRAINT study_group_texts_body_check CHECK(char_length(body)<=2000 AND (char_length(btrim(body))>0 OR context_id IS NOT NULL));
ALTER TABLE study_group_memberships ADD COLUMN IF NOT EXISTS read_sequence bigint NOT NULL DEFAULT 0 CHECK(read_sequence>=0);
ALTER TABLE study_group_memberships ADD COLUMN IF NOT EXISTS generation uuid NOT NULL DEFAULT gen_random_uuid();
UPDATE study_group_memberships m SET read_sequence=g.text_sequence FROM study_groups g WHERE m.group_id=g.id AND m.read_sequence=0;
CREATE OR REPLACE FUNCTION phase27_group_membership_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (OLD.status<>'ACTIVE' AND NEW.status='ACTIVE') THEN
  SELECT text_sequence INTO NEW.read_sequence FROM study_groups WHERE id=NEW.group_id;
  NEW.generation=gen_random_uuid();
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS phase27_group_membership_epoch ON study_group_memberships;
CREATE TRIGGER phase27_group_membership_epoch BEFORE INSERT OR UPDATE OF status ON study_group_memberships FOR EACH ROW EXECUTE FUNCTION phase27_group_membership_epoch();
CREATE OR REPLACE FUNCTION phase27_group_membership_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role THEN
  UPDATE study_groups SET change_version=change_version+1 WHERE id=NEW.group_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS phase27_group_membership_version ON study_group_memberships;
CREATE TRIGGER phase27_group_membership_version AFTER INSERT OR UPDATE OF status,role ON study_group_memberships FOR EACH ROW EXECUTE FUNCTION phase27_group_membership_version();
CREATE OR REPLACE FUNCTION phase27_group_hide_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.hidden_at IS DISTINCT FROM OLD.hidden_at THEN UPDATE study_groups SET change_version=change_version+1 WHERE id=NEW.group_id; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS phase27_group_hide_version ON study_group_texts;
CREATE TRIGGER phase27_group_hide_version AFTER UPDATE OF hidden_at ON study_group_texts FOR EACH ROW EXECUTE FUNCTION phase27_group_hide_version();
CREATE OR REPLACE FUNCTION phase27_group_text_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE study_groups SET text_sequence=text_sequence+1,change_version=change_version+1 WHERE id=NEW.group_id RETURNING text_sequence INTO NEW.sequence;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS phase27_group_text_sequence ON study_group_texts;
CREATE TRIGGER phase27_group_text_sequence BEFORE INSERT ON study_group_texts FOR EACH ROW EXECUTE FUNCTION phase27_group_text_sequence();
-- PHASE27_SHARED_LEASE_ADAPTATION
-- Required in real targets: no silent skip of the accepted Phase26 lease table.
ALTER TABLE direct_message_stream_leases ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE direct_message_stream_leases ADD COLUMN group_id uuid REFERENCES study_groups(id) ON DELETE CASCADE;
ALTER TABLE direct_message_stream_leases ADD CONSTRAINT communication_stream_target_xor CHECK((conversation_id IS NOT NULL)::int+(group_id IS NOT NULL)::int=1);
