-- Additive, default-disabled attachment foundation. Never execute against production.
-- Restrictive FKs deliberately fail hard deletion until durable cleanup is complete.
ALTER TABLE community_posts ADD CONSTRAINT phase30_post_author_language UNIQUE(id,author_user_id,target_language_id);
ALTER TABLE study_group_texts ADD CONSTRAINT phase30_text_group_author UNIQUE(group_id,id,author_user_id);
ALTER TABLE direct_messages ADD CONSTRAINT phase30_message_conversation_author UNIQUE(conversation_id,id,sender_user_id);
CREATE TABLE attachments (
 id uuid PRIMARY KEY,
 uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 scope text NOT NULL CHECK(scope IN ('COMMUNITY','STUDY_GROUP','DIRECT_MESSAGE')),
 scope_id uuid NOT NULL,
 language_id uuid REFERENCES languages(id) ON DELETE RESTRICT,
 group_id uuid REFERENCES study_groups(id) ON DELETE RESTRICT,
 conversation_id uuid REFERENCES direct_conversations(id) ON DELETE RESTRICT,
 scope_generation uuid,
 community_post_type text,
 community_visibility text,
 client_upload_id uuid NOT NULL,
 init_fingerprint text NOT NULL CHECK(init_fingerprint ~ '^[a-f0-9]{64}$'),
 format text NOT NULL CHECK(format IN ('IMAGE','VIDEO','TEXT')),
 declared_mime text NOT NULL,
 expected_bytes bigint NOT NULL,
 display_filename text NOT NULL CHECK(char_length(display_filename) BETWEEN 1 AND 180 AND octet_length(display_filename)<=720),
 caption text NOT NULL DEFAULT '' CHECK(char_length(caption)<=500),
 alt text NOT NULL DEFAULT '' CHECK(char_length(alt)<=300),
 metadata_version bigint NOT NULL DEFAULT 0 CHECK(metadata_version>=0),
 state text NOT NULL DEFAULT 'TEMPORARY' CHECK(state IN ('TEMPORARY','UPLOADING','PENDING','READY','REJECTED','DELETED')),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes>=expected_bytes AND reserved_bytes<=8650752),
 upload_slot_held boolean NOT NULL DEFAULT false,
 pending_slot_held boolean NOT NULL DEFAULT false,
 first_bound_at timestamptz,
 lease_owner uuid,
 lease_expires_at timestamptz,
 rejection_code text CHECK(rejection_code IS NULL OR rejection_code ~ '^[A-Z_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 deleted_at timestamptz,
 physical_cleanup_at timestamptz,
 UNIQUE(uploader_id,client_upload_id),
 UNIQUE(id,uploader_id,client_upload_id,init_fingerprint),
 UNIQUE(id,uploader_id,scope,scope_id),
 CHECK((scope='COMMUNITY' AND language_id=scope_id AND language_id IS NOT NULL AND group_id IS NULL AND conversation_id IS NULL AND scope_generation IS NULL AND community_post_type IN ('DISCUSSION','QUESTION','RESOURCE','LEARNING_JOURNAL','CULTURE','PRONUNCIATION_REQUEST','CORRECTION_REQUEST','CHALLENGE') AND community_visibility IN ('PUBLIC','PRIVATE') AND community_post_type IS NOT NULL AND community_visibility IS NOT NULL)
  OR (scope='STUDY_GROUP' AND group_id=scope_id AND group_id IS NOT NULL AND language_id IS NULL AND conversation_id IS NULL AND scope_generation IS NOT NULL AND community_post_type IS NULL AND community_visibility IS NULL)
  OR (scope='DIRECT_MESSAGE' AND conversation_id=scope_id AND conversation_id IS NOT NULL AND language_id IS NULL AND group_id IS NULL AND scope_generation IS NOT NULL AND community_post_type IS NULL AND community_visibility IS NULL)),
 CHECK((format='IMAGE' AND declared_mime IN ('image/jpeg','image/png','image/webp') AND expected_bytes BETWEEN 1 AND 4194304)
  OR (format='VIDEO' AND declared_mime='video/mp4' AND expected_bytes BETWEEN 1 AND 3145728)
  OR (format='TEXT' AND declared_mime='text/plain' AND expected_bytes BETWEEN 1 AND 65536)),
 CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)),
 CHECK(state<>'UPLOADING' OR lease_owner IS NOT NULL),
 CHECK((state='DELETED')=(deleted_at IS NOT NULL)),
 CHECK(physical_cleanup_at IS NULL OR state IN ('REJECTED','DELETED')),
 CHECK(expires_at>created_at)
);
CREATE INDEX attachments_expiry_idx ON attachments(expires_at,id) WHERE state<>'DELETED';
CREATE INDEX attachments_actor_idx ON attachments(uploader_id,state,id);
-- A completed-body replay has its own intake fence; processing may run in parallel.
-- Expiry is diagnostic only. No lease can be stolen or purged before actual intake quiescence.
CREATE TABLE attachment_upload_replay_leases (
 attachment_id uuid PRIMARY KEY REFERENCES attachments(id) ON DELETE RESTRICT,
 owner uuid NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE attachment_bindings (
 attachment_id uuid PRIMARY KEY,
 uploader_id uuid NOT NULL,
 scope text NOT NULL,
 scope_id uuid NOT NULL,
 community_post_id uuid,
 group_text_id uuid,
 direct_message_id uuid,
 position smallint NOT NULL CHECK(position BETWEEN 0 AND 3),
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 removed_at timestamptz,
 FOREIGN KEY(attachment_id,uploader_id,scope,scope_id) REFERENCES attachments(id,uploader_id,scope,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(community_post_id,uploader_id,scope_id) REFERENCES community_posts(id,author_user_id,target_language_id) ON DELETE RESTRICT,
 FOREIGN KEY(scope_id,group_text_id,uploader_id) REFERENCES study_group_texts(group_id,id,author_user_id) ON DELETE RESTRICT,
 FOREIGN KEY(scope_id,direct_message_id,uploader_id) REFERENCES direct_messages(conversation_id,id,sender_user_id) ON DELETE RESTRICT,
 CHECK((scope='COMMUNITY' AND community_post_id IS NOT NULL AND group_text_id IS NULL AND direct_message_id IS NULL)
  OR (scope='STUDY_GROUP' AND group_text_id IS NOT NULL AND community_post_id IS NULL AND direct_message_id IS NULL)
  OR (scope='DIRECT_MESSAGE' AND direct_message_id IS NOT NULL AND community_post_id IS NULL AND group_text_id IS NULL))
);
CREATE UNIQUE INDEX attachment_post_position ON attachment_bindings(community_post_id,position) WHERE removed_at IS NULL AND community_post_id IS NOT NULL;
CREATE UNIQUE INDEX attachment_group_position ON attachment_bindings(scope_id,group_text_id,position) WHERE removed_at IS NULL AND group_text_id IS NOT NULL;
CREATE UNIQUE INDEX attachment_message_position ON attachment_bindings(scope_id,direct_message_id,position) WHERE removed_at IS NULL AND direct_message_id IS NOT NULL;
-- Ownership survives deletion and provider failures; no cascade may erase these facts.
CREATE TABLE attachment_objects (
 id uuid PRIMARY KEY,
 attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
 attempt_id uuid NOT NULL,
 variant text NOT NULL CHECK(variant IN ('source','normalized','thumbnail')),
 object_version bigint NOT NULL DEFAULT 0 CHECK(object_version>=0),
 put_claim uuid,
 put_claimed_at timestamptz,
 put_settled_at timestamptz,
 put_supervision_id uuid UNIQUE,
 put_abandoned_at timestamptz,
 put_uncertain boolean NOT NULL DEFAULT false,
 object_key text GENERATED ALWAYS AS ('attachments/test/v1/' || attachment_id::text || '/' || attempt_id::text || '/' || variant || '/' || id::text) STORED UNIQUE,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_count bigint NOT NULL CHECK(byte_count BETWEEN 1 AND 4194304),
 content_type text NOT NULL CHECK(content_type IN ('application/octet-stream','image/webp','image/jpeg','video/mp4')),
 etag text CHECK(etag IS NULL OR (octet_length(etag) BETWEEN 1 AND 256 AND etag !~ '[^!-~]')),
 status text NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','WRITTEN','DELETE_PENDING','DELETED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz,
 UNIQUE(id,attachment_id),
 UNIQUE(attachment_id,attempt_id,variant),
 CHECK((status='DELETED')=(deleted_at IS NOT NULL)),
 CHECK(status<>'WRITTEN' OR (etag IS NOT NULL AND put_settled_at IS NOT NULL)),
 CHECK((put_claim IS NULL)=(put_claimed_at IS NULL)),
 CHECK(put_claim IS NOT NULL OR (put_settled_at IS NULL AND put_abandoned_at IS NULL AND put_supervision_id IS NULL AND NOT put_uncertain)),
 CHECK(put_settled_at IS NULL OR (NOT put_uncertain AND etag IS NOT NULL)),
 CHECK(put_claim IS NULL OR put_uncertain=(put_settled_at IS NULL AND put_abandoned_at IS NULL)),
 CHECK(put_abandoned_at IS NULL OR (put_supervision_id IS NOT NULL AND put_settled_at IS NULL AND etag IS NULL AND NOT put_uncertain AND status IN ('DELETE_PENDING','DELETED'))),
 CHECK(status<>'DELETED' OR NOT put_uncertain)
);
-- Exact artifact selection survives physical deletion and retained retry history.
ALTER TABLE attachments ADD COLUMN source_object_id uuid;
ALTER TABLE attachments ADD COLUMN normalized_object_id uuid;
ALTER TABLE attachments ADD COLUMN thumbnail_object_id uuid;
ALTER TABLE attachments ADD CONSTRAINT phase30_source_identity FOREIGN KEY(source_object_id,id) REFERENCES attachment_objects(id,attachment_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE attachments ADD CONSTRAINT phase30_normalized_identity FOREIGN KEY(normalized_object_id,id) REFERENCES attachment_objects(id,attachment_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE attachments ADD CONSTRAINT phase30_thumbnail_identity FOREIGN KEY(thumbnail_object_id,id) REFERENCES attachment_objects(id,attachment_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE TABLE attachment_cleanup_jobs (
 id uuid PRIMARY KEY,
 attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
 object_id uuid,
 FOREIGN KEY(object_id,attachment_id) REFERENCES attachment_objects(id,attachment_id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text NOT NULL CHECK(reason IN ('EXPIRED','INTERRUPTED','REJECTED','REMOVED','MISSING','ORPHAN','LATE_WRITE')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_owner uuid,
 lease_expires_at timestamptz,
 last_error_code text CHECK(last_error_code IS NULL OR last_error_code ~ '^[A-Z_]{1,64}$'),
 completed_at timestamptz,
 CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX attachment_cleanup_object_active ON attachment_cleanup_jobs(object_id) WHERE completed_at IS NULL;
CREATE INDEX attachment_cleanup_due_idx ON attachment_cleanup_jobs(next_attempt_at,id) WHERE completed_at IS NULL AND attempts<10;
CREATE TABLE attachment_quota_counters (
 kind text NOT NULL CHECK(kind IN ('ACTOR','IP','DEPLOYMENT')),
 subject text NOT NULL CHECK(octet_length(subject) BETWEEN 1 AND 128),
 action text NOT NULL CHECK(action IN ('bytes','metadata','upload','pending','initiate','source','read','upload_attempt','ingress')),
 window_start timestamptz NOT NULL,
 used bigint NOT NULL DEFAULT 0,
 ceiling bigint NOT NULL CHECK(ceiling>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(kind,subject,action,window_start),
 CHECK(used>=0 AND used<=ceiling)
);
CREATE TABLE attachment_processing_lease (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 owner uuid,
 attachment_id uuid REFERENCES attachments(id) ON DELETE RESTRICT,
 expires_at timestamptz,
 CHECK((owner IS NULL)=(expires_at IS NULL))
);
INSERT INTO attachment_processing_lease(singleton) VALUES(true);
CREATE FUNCTION phase30_attachment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Metadata CAS is independent of producer/state fencing: a caption edit must
 -- not cancel an in-flight physical PUT. Every other column stays identical.
 IF NEW.version<>OLD.version+1 AND NOT (
  NEW.version=OLD.version AND OLD.first_bound_at IS NULL AND OLD.state<>'DELETED'
  AND NEW.metadata_version=OLD.metadata_version+1
  AND (to_jsonb(NEW)-ARRAY['caption','alt','metadata_version','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['caption','alt','metadata_version','updated_at'])
 ) THEN RAISE EXCEPTION 'Attachment version conflict' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.uploader_id,NEW.scope,NEW.scope_id,NEW.language_id,NEW.group_id,NEW.conversation_id,NEW.scope_generation,NEW.community_post_type,NEW.community_visibility,NEW.client_upload_id,NEW.init_fingerprint,NEW.format,NEW.declared_mime,NEW.expected_bytes,NEW.display_filename,NEW.created_at,NEW.expires_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.uploader_id,OLD.scope,OLD.scope_id,OLD.language_id,OLD.group_id,OLD.conversation_id,OLD.scope_generation,OLD.community_post_type,OLD.community_visibility,OLD.client_upload_id,OLD.init_fingerprint,OLD.format,OLD.declared_mime,OLD.expected_bytes,OLD.display_filename,OLD.created_at,OLD.expires_at)
 THEN RAISE EXCEPTION 'Immutable attachment intent' USING ERRCODE='23514'; END IF;
 IF (OLD.source_object_id IS NOT NULL AND NEW.source_object_id IS DISTINCT FROM OLD.source_object_id)
  OR (OLD.normalized_object_id IS NOT NULL AND NEW.normalized_object_id IS DISTINCT FROM OLD.normalized_object_id)
  OR (OLD.thumbnail_object_id IS NOT NULL AND NEW.thumbnail_object_id IS DISTINCT FROM OLD.thumbnail_object_id)
 THEN RAISE EXCEPTION 'Immutable selected attachment object' USING ERRCODE='23514'; END IF;
 IF OLD.first_bound_at IS NOT NULL AND NEW.first_bound_at IS DISTINCT FROM OLD.first_bound_at THEN RAISE EXCEPTION 'Attachment cannot be rebound' USING ERRCODE='23514'; END IF;
 IF NEW.state<>OLD.state AND NOT (
  (NEW.state='DELETED' AND OLD.state<>'DELETED') OR
  (OLD.state='TEMPORARY' AND NEW.state='UPLOADING') OR
  (OLD.state='UPLOADING' AND NEW.state='PENDING') OR
  (OLD.state='PENDING' AND NEW.state IN ('READY','REJECTED')))
 THEN RAISE EXCEPTION 'Invalid attachment transition' USING ERRCODE='23514'; END IF;
 IF OLD.state='DELETED' AND (NEW.state<>'DELETED' OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN RAISE EXCEPTION 'Deleted attachment is terminal' USING ERRCODE='23514'; END IF;
 IF NEW.physical_cleanup_at IS NOT NULL AND NEW.physical_cleanup_at IS DISTINCT FROM OLD.physical_cleanup_at AND (
  NEW.lease_owner IS NOT NULL OR NEW.upload_slot_held OR NEW.pending_slot_held
  OR EXISTS(SELECT 1 FROM attachment_upload_replay_leases r WHERE r.attachment_id=OLD.id)
  OR EXISTS(SELECT 1 FROM attachment_objects o WHERE o.attachment_id=OLD.id AND (o.status<>'DELETED' OR o.put_uncertain))
  OR EXISTS(SELECT 1 FROM attachment_cleanup_jobs j WHERE j.attachment_id=OLD.id AND j.completed_at IS NULL)
  OR EXISTS(SELECT 1 FROM attachment_processing_lease l WHERE l.attachment_id=OLD.id AND l.owner IS NOT NULL))
 THEN RAISE EXCEPTION 'Unresolved attachment cleanup debt' USING ERRCODE='23514'; END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER phase30_attachment_guard BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION phase30_attachment_guard();
CREATE FUNCTION phase30_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate attachments%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.removed_at IS NULL OR OLD.removed_at>clock_timestamp()-interval '7 days' OR NOT phase30_terminal_purge_eligible(OLD.attachment_id) THEN RAISE EXCEPTION 'Binding retention required' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO candidate FROM attachments WHERE id=NEW.attachment_id FOR UPDATE;
  IF NOT FOUND OR candidate.state<>'READY' OR candidate.first_bound_at IS NOT NULL OR candidate.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Attachment cannot bind' USING ERRCODE='23514'; END IF;
  UPDATE attachments SET first_bound_at=NEW.bound_at,version=version+1 WHERE id=NEW.attachment_id;
 ELSE
  IF ROW(NEW.attachment_id,NEW.uploader_id,NEW.scope,NEW.scope_id,NEW.community_post_id,NEW.group_text_id,NEW.direct_message_id,NEW.bound_at)
   IS DISTINCT FROM ROW(OLD.attachment_id,OLD.uploader_id,OLD.scope,OLD.scope_id,OLD.community_post_id,OLD.group_text_id,OLD.direct_message_id,OLD.bound_at)
   OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at)
   OR (OLD.scope<>'COMMUNITY' AND NEW.position<>OLD.position)
  THEN RAISE EXCEPTION 'Immutable attachment binding' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase30_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON attachment_bindings FOR EACH ROW EXECUTE FUNCTION phase30_binding_guard();

-- Defense in depth for durable ownership. Repository mutations still acquire
-- domain -> attachment -> object -> cleanup locks, never the reverse.
CREATE FUNCTION phase30_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.put_uncertain OR OLD.status<>'DELETED' OR OLD.deleted_at IS NULL OR OLD.deleted_at>clock_timestamp()-interval '7 days'
   OR EXISTS(SELECT 1 FROM attachments a WHERE a.id=OLD.attachment_id AND (a.lease_owner IS NOT NULL OR a.physical_cleanup_at IS NULL OR a.physical_cleanup_at>clock_timestamp()-interval '7 days'))
   OR EXISTS(SELECT 1 FROM attachment_processing_lease l WHERE l.attachment_id=OLD.attachment_id AND l.owner IS NOT NULL)
  THEN RAISE EXCEPTION 'Storage ownership retention required' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.object_version<>OLD.object_version+1 THEN RAISE EXCEPTION 'Object version conflict' USING ERRCODE='23514'; END IF;
 IF (OLD.put_claim IS NOT NULL AND ROW(NEW.put_claim,NEW.put_claimed_at) IS DISTINCT FROM ROW(OLD.put_claim,OLD.put_claimed_at))
  OR (OLD.put_claim IS NULL AND NEW.put_claim IS NOT NULL AND (OLD.status<>'RESERVED' OR NOT NEW.put_uncertain OR NEW.put_settled_at IS NOT NULL))
  OR (OLD.put_settled_at IS NOT NULL AND ROW(NEW.put_settled_at,NEW.put_uncertain) IS DISTINCT FROM ROW(OLD.put_settled_at,OLD.put_uncertain))
  OR (OLD.put_supervision_id IS NOT NULL AND NEW.put_supervision_id IS DISTINCT FROM OLD.put_supervision_id)
  OR (OLD.put_supervision_id IS NULL AND NEW.put_supervision_id IS NOT NULL AND (OLD.put_claim IS NULL OR NOT OLD.put_uncertain OR OLD.put_settled_at IS NOT NULL OR OLD.put_abandoned_at IS NOT NULL))
  OR (OLD.put_abandoned_at IS NOT NULL AND ROW(NEW.put_abandoned_at,NEW.put_uncertain,NEW.put_settled_at,NEW.etag) IS DISTINCT FROM ROW(OLD.put_abandoned_at,OLD.put_uncertain,OLD.put_settled_at,OLD.etag))
  OR (OLD.put_abandoned_at IS NULL AND NEW.put_abandoned_at IS NOT NULL AND (OLD.put_supervision_id IS NULL OR NOT EXISTS(SELECT 1 FROM attachments a WHERE a.id=OLD.attachment_id AND a.state IN ('REJECTED','DELETED'))))
 THEN RAISE EXCEPTION 'Physical PUT claim is single use' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.attachment_id,NEW.attempt_id,NEW.variant,NEW.sha256,NEW.byte_count,NEW.content_type,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.attachment_id,OLD.attempt_id,OLD.variant,OLD.sha256,OLD.byte_count,OLD.content_type,OLD.created_at)
  OR (OLD.etag IS NOT NULL AND NEW.etag IS DISTINCT FROM OLD.etag)
 THEN RAISE EXCEPTION 'Immutable storage ownership' USING ERRCODE='23514'; END IF;
 IF NEW.status<>OLD.status AND NOT (
  (OLD.status='RESERVED' AND NEW.status IN ('WRITTEN','DELETE_PENDING')) OR
  (OLD.status='WRITTEN' AND NEW.status='DELETE_PENDING') OR
  (OLD.status='DELETE_PENDING' AND NEW.status='DELETED') OR
  (OLD.status='DELETED' AND NEW.status='DELETE_PENDING' AND EXISTS(SELECT 1 FROM attachment_cleanup_jobs j WHERE j.object_id=OLD.id AND j.attachment_id=OLD.attachment_id AND j.reason='LATE_WRITE' AND j.completed_at IS NULL)))
 THEN RAISE EXCEPTION 'Invalid storage lifecycle' USING ERRCODE='23514'; END IF;
 IF OLD.status='DELETED' AND NEW.status='DELETED' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RAISE EXCEPTION 'Immutable deletion observation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase30_object_guard BEFORE UPDATE OR DELETE ON attachment_objects FOR EACH ROW EXECUTE FUNCTION phase30_object_guard();
CREATE FUNCTION phase30_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.completed_at IS NULL OR OLD.completed_at>clock_timestamp()-interval '7 days' OR OLD.lease_owner IS NOT NULL THEN RAISE EXCEPTION 'Cleanup history retention required' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.id,NEW.attachment_id,NEW.object_id,NEW.reason,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.attachment_id,OLD.object_id,OLD.reason,OLD.created_at)
  OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  OR NEW.attempts<OLD.attempts
 THEN RAISE EXCEPTION 'Immutable cleanup ownership' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase30_cleanup_guard BEFORE UPDATE OR DELETE ON attachment_cleanup_jobs FOR EACH ROW EXECUTE FUNCTION phase30_cleanup_guard();
CREATE FUNCTION phase30_attachment_purge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT phase30_terminal_purge_eligible(OLD.id) OR OLD.state<>'DELETED' OR OLD.physical_cleanup_at IS NULL OR OLD.physical_cleanup_at>clock_timestamp()-interval '7 days'
  OR OLD.created_at>clock_timestamp()-interval '24 hours' OR OLD.lease_owner IS NOT NULL
  OR EXISTS(SELECT 1 FROM attachment_upload_replay_leases r WHERE r.attachment_id=OLD.id)
 THEN RAISE EXCEPTION 'Attachment tombstone retention required' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER phase30_attachment_purge_guard BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION phase30_attachment_purge_guard();

-- Rate-only admission retains immutable charge-once facts before domain work.
CREATE TABLE attachment_initiation_admissions (
 uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 client_upload_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 source_bytes bigint NOT NULL CHECK(source_bytes BETWEEN 1 AND 4194304),
 format text NOT NULL CHECK(format IN ('IMAGE','VIDEO','TEXT')),
 status text NOT NULL DEFAULT 'ADMITTED' CHECK(status IN ('ADMITTED','REJECTED','CREATED')),
 attachment_id uuid UNIQUE,
 FOREIGN KEY(attachment_id,uploader_id,client_upload_id,fingerprint) REFERENCES attachments(id,uploader_id,client_upload_id,init_fingerprint) ON DELETE RESTRICT,
 failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 PRIMARY KEY(uploader_id,client_upload_id),
 CHECK(expires_at>=created_at+interval '24 hours'),
 CHECK((status='CREATED')=(attachment_id IS NOT NULL)),
 CHECK((status='REJECTED')=(failure_code IS NOT NULL)),
 CHECK((format='IMAGE' AND source_bytes<=4194304) OR (format='VIDEO' AND source_bytes<=3145728) OR (format='TEXT' AND source_bytes<=65536))
);
CREATE FUNCTION phase30_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.expires_at>clock_timestamp() OR OLD.created_at>clock_timestamp()-interval '24 hours'
   OR (OLD.attachment_id IS NOT NULL AND (OLD.status<>'CREATED' OR NOT phase30_terminal_purge_eligible(OLD.attachment_id)))
  THEN RAISE EXCEPTION 'Admission retention required' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.uploader_id,NEW.client_upload_id,NEW.fingerprint,NEW.source_bytes,NEW.format,NEW.created_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.uploader_id,OLD.client_upload_id,OLD.fingerprint,OLD.source_bytes,OLD.format,OLD.created_at,OLD.expires_at)
  OR (OLD.status<>'ADMITTED' AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'Immutable initiation admission' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase30_admission_guard BEFORE UPDATE OR DELETE ON attachment_initiation_admissions FOR EACH ROW EXECUTE FUNCTION phase30_admission_guard();

-- Read-only eligibility shared by narrow DELETE guards. This grants no bypass:
-- internal callers still take ordered domain/parent/child locks and commit the
-- complete graph atomically; no capacity or provider operation is performed.
CREATE FUNCTION phase30_terminal_purge_eligible(target uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM attachments a WHERE a.id=target AND a.state='DELETED'
  AND EXISTS(SELECT 1 FROM attachment_processing_lease l WHERE l.singleton)
  AND a.physical_cleanup_at<=clock_timestamp()-interval '7 days'
  AND a.created_at<=clock_timestamp()-interval '24 hours'
  AND a.lease_owner IS NULL AND NOT a.upload_slot_held AND NOT a.pending_slot_held
  AND NOT EXISTS(SELECT 1 FROM attachment_upload_replay_leases r WHERE r.attachment_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM attachment_processing_lease l WHERE l.attachment_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM attachment_objects o WHERE o.attachment_id=a.id AND
   (o.status<>'DELETED' OR o.put_uncertain OR o.deleted_at IS NULL OR o.deleted_at>clock_timestamp()-interval '7 days'
    OR (o.put_claim IS NOT NULL AND o.put_settled_at IS NULL AND o.put_abandoned_at IS NULL)))
  AND NOT EXISTS(SELECT 1 FROM attachment_cleanup_jobs j WHERE j.attachment_id=a.id AND
   (j.completed_at IS NULL OR j.completed_at>clock_timestamp()-interval '7 days' OR j.lease_owner IS NOT NULL))
  AND NOT EXISTS(SELECT 1 FROM attachment_bindings b WHERE b.attachment_id=a.id AND
   (b.removed_at IS NULL OR b.removed_at>clock_timestamp()-interval '7 days'))
  AND NOT EXISTS(SELECT 1 FROM attachment_initiation_admissions i WHERE i.attachment_id=a.id AND
   (i.status<>'CREATED' OR i.expires_at>clock_timestamp() OR i.created_at>clock_timestamp()-interval '24 hours'))
 );
$$;
