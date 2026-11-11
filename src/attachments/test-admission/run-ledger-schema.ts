/** Inert, explicit tooling DDL only. Requires an already reviewed, owned schema.
 * NOT a product migration, installer, startup hook or permission grant. */
export const RUN_LIMITS = Object.freeze({authenticatedRequests:120,anonymousRequests:20,
 ingressBytes:33554432,authenticatedEgressBytes:67108864,anonymousEgressBytes:16777216,processingAttempts:4});
export const SLOT_ROLES = ['ATTACHMENT','UPLOAD_OWNER','REPLAY_OWNER','SOURCE_OBJECT','SOURCE_ATTEMPT',
 'PUT_CLAIM','PROCESSING_OWNER','DERIVATIVE_ATTEMPT','NORMALIZED_OBJECT','THUMBNAIL_OBJECT',
 'CLEANUP_JOB','CLEANUP_OWNER','PUT_SUPERVISION'] as const;
const names=Object.keys(RUN_LIMITS);
const zero=JSON.stringify(Object.fromEntries(names.map(k=>[k,0])));
const maximum=JSON.stringify(RUN_LIMITS);
export const RUN_LEDGER_DDL = `
CREATE TABLE phase30_test_execution.runs (
 run_id uuid PRIMARY KEY CHECK(run_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 activation_id uuid NOT NULL UNIQUE CHECK(activation_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 manifest_sha256 text NOT NULL UNIQUE CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 source_sha text NOT NULL CHECK(source_sha ~ '^[a-f0-9]{40}$'),
 service_id text NOT NULL CHECK(service_id='srv-dahnerh594qs73fp3420'),
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(), not_before timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, activated_at timestamptz, boot_id uuid,
 state text NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','ACTIVE','CLOSED','EXPIRED')),
 slot_count integer NOT NULL CHECK(slot_count BETWEEN 1 AND 256),
 candidate_count integer NOT NULL DEFAULT 0 CHECK(candidate_count BETWEEN 0 AND 140),
 request_count integer NOT NULL DEFAULT 0 CHECK(request_count BETWEEN 0 AND 140), preparation_sealed boolean NOT NULL DEFAULT false,
 CHECK((candidate_count=0)=(request_count=0)),
 limits jsonb NOT NULL, counters jsonb NOT NULL DEFAULT '${zero}'::jsonb,
 recovery_debt boolean NOT NULL DEFAULT false,
 CHECK(expires_at>not_before AND expires_at<=not_before+interval '10 minutes'),
 CHECK(expires_at>issued_at AND not_before<=issued_at+interval '10 minutes'),
 CHECK((state='PREPARED' AND boot_id IS NULL AND activated_at IS NULL) OR
       (state<>'PREPARED' AND boot_id IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE TABLE phase30_test_execution.slots (
 run_id uuid NOT NULL REFERENCES phase30_test_execution.runs(run_id),
 slot_key text NOT NULL CHECK(slot_key ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
 operation_key text NOT NULL CHECK(operation_key ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
 role text NOT NULL CHECK(role IN (${SLOT_ROLES.map(x=>"'"+x+"'").join(',')})),
 id uuid NOT NULL UNIQUE CHECK(id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'), attachment_id uuid,
 state text NOT NULL DEFAULT 'AVAILABLE' CHECK(state IN ('AVAILABLE','BURNED','UNCERTAIN','SETTLED')),
 reserved_at timestamptz, PRIMARY KEY(run_id,slot_key),
 CHECK((state='AVAILABLE')=(reserved_at IS NULL))
);

CREATE TABLE phase30_test_execution.request_candidates (
 run_id uuid NOT NULL REFERENCES phase30_test_execution.runs(run_id),
 candidate_key text NOT NULL CHECK(candidate_key ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
 method text NOT NULL CHECK(method IN ('GET','HEAD','POST','PUT','PATCH','DELETE')),
 path text NOT NULL CHECK(length(path)<=160 AND path ~ '^/api/v1/attachments(/[a-f0-9-]{36}(/(content|preview|finalize|metadata))?)?$'),
 auth_class text NOT NULL CHECK(auth_class IN ('AUTH','ANON')),
 ingress_bytes bigint NOT NULL CHECK(ingress_bytes BETWEEN 0 AND 33554432),
 egress_bytes bigint NOT NULL CHECK(egress_bytes BETWEEN 0 AND 67108864),
 CHECK(auth_class<>'ANON' OR (ingress_bytes=0 AND egress_bytes<=16777216 AND method IN ('GET','HEAD') AND path ~ '/(content|preview)$')),
 PRIMARY KEY(run_id,candidate_key), UNIQUE(run_id,method,path,auth_class)
);
CREATE TABLE phase30_test_execution.request_attempts (
 run_id uuid NOT NULL REFERENCES phase30_test_execution.runs(run_id),
 attempt_key text NOT NULL CHECK(attempt_key ~ '^[a-z0-9][a-z0-9._-]{0,79}$'), candidate_key text NOT NULL,
 state text NOT NULL DEFAULT 'AVAILABLE' CHECK(state IN ('AVAILABLE','RESERVED')), reserved_at timestamptz, boot_id uuid,
 CHECK((state='AVAILABLE' AND reserved_at IS NULL AND boot_id IS NULL) OR (state='RESERVED' AND reserved_at IS NOT NULL AND boot_id IS NOT NULL)),
 PRIMARY KEY(run_id,attempt_key), FOREIGN KEY(run_id,candidate_key) REFERENCES phase30_test_execution.request_candidates(run_id,candidate_key)
);
CREATE FUNCTION phase30_test_execution.request_totals(target uuid, reserved_only boolean) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('authenticatedRequests',count(*) FILTER(WHERE c.auth_class='AUTH'),'anonymousRequests',count(*) FILTER(WHERE c.auth_class='ANON'),
 'ingressBytes',COALESCE(sum(c.ingress_bytes),0),'authenticatedEgressBytes',COALESCE(sum(c.egress_bytes) FILTER(WHERE c.auth_class='AUTH'),0),
 'anonymousEgressBytes',COALESCE(sum(c.egress_bytes) FILTER(WHERE c.auth_class='ANON'),0),'processingAttempts',0)
 FROM phase30_test_execution.request_attempts a JOIN phase30_test_execution.request_candidates c USING(run_id,candidate_key)
 WHERE a.run_id=target AND (NOT reserved_only OR a.state='RESERVED')
$$;

CREATE FUNCTION phase30_test_execution.guard_run() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE k text; maximum jsonb := '${maximum}'::jsonb; now_at timestamptz := clock_timestamp(); planned jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  -- No proof-backed settlement/purge interface exists in this inert slice.
  RAISE EXCEPTION 'TEST_ADMISSION_LEDGER';
 END IF;
 IF jsonb_typeof(NEW.limits)<>'object' OR jsonb_typeof(NEW.counters)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(NEW.limits))<>6
  OR (SELECT count(*) FROM jsonb_object_keys(NEW.counters))<>6 THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 FOR k IN SELECT jsonb_object_keys(maximum) LOOP
  IF NOT (NEW.limits ? k AND NEW.counters ? k)
   OR jsonb_typeof(NEW.limits->k)<>'number' OR jsonb_typeof(NEW.counters->k)<>'number'
   OR NEW.limits->>k !~ '^[0-9]+$' OR NEW.counters->>k !~ '^[0-9]+$'
   OR (NEW.limits->>k)::numeric<1 OR (NEW.limits->>k)::numeric>(maximum->>k)::numeric
   OR (NEW.counters->>k)::numeric>(NEW.limits->>k)::numeric THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 END LOOP;
 IF TG_OP='INSERT' THEN
  NEW.issued_at:=now_at;
  IF NEW.state<>'PREPARED' OR NEW.preparation_sealed OR NEW.counters<>'${zero}'::jsonb OR NEW.recovery_debt THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 ELSE
  IF ROW(NEW.run_id,NEW.activation_id,NEW.manifest_sha256,NEW.source_sha,NEW.service_id,NEW.issued_at,NEW.not_before,NEW.expires_at,NEW.limits,NEW.slot_count,NEW.candidate_count,NEW.request_count)
   IS DISTINCT FROM ROW(OLD.run_id,OLD.activation_id,OLD.manifest_sha256,OLD.source_sha,OLD.service_id,OLD.issued_at,OLD.not_before,OLD.expires_at,OLD.limits,OLD.slot_count,OLD.candidate_count,OLD.request_count)
   OR (OLD.recovery_debt AND NOT NEW.recovery_debt) THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  FOR k IN SELECT jsonb_object_keys(maximum) LOOP
   IF (NEW.counters->>k)::numeric<(OLD.counters->>k)::numeric THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  END LOOP;

  IF OLD.preparation_sealed AND NOT NEW.preparation_sealed THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  IF NEW.preparation_sealed<>OLD.preparation_sealed THEN
   IF OLD.state<>'PREPARED' OR NEW.state<>'PREPARED'
    OR (SELECT count(*) FROM phase30_test_execution.slots WHERE run_id=NEW.run_id)<>NEW.slot_count
    OR (SELECT count(*) FROM phase30_test_execution.request_candidates WHERE run_id=NEW.run_id)<>NEW.candidate_count
    OR (SELECT count(*) FROM phase30_test_execution.request_attempts WHERE run_id=NEW.run_id)<>NEW.request_count
    OR EXISTS(SELECT 1 FROM phase30_test_execution.request_candidates c WHERE c.run_id=NEW.run_id AND NOT EXISTS(SELECT 1 FROM phase30_test_execution.request_attempts a WHERE a.run_id=c.run_id AND a.candidate_key=c.candidate_key))
   THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
   planned:=phase30_test_execution.request_totals(NEW.run_id,false);
   FOR k IN SELECT jsonb_object_keys(maximum) LOOP
    IF (planned->>k)::numeric>(NEW.limits->>k)::numeric THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
   END LOOP;
  END IF;
  IF NEW.request_count>0 AND NEW.counters<>phase30_test_execution.request_totals(NEW.run_id,true) THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;

  IF OLD.state='PREPARED' AND NEW.state='ACTIVE' THEN
   IF NOT NEW.preparation_sealed OR now_at<NEW.not_before OR now_at>=NEW.expires_at OR NEW.boot_id IS NULL
    OR (SELECT count(*) FROM phase30_test_execution.slots WHERE run_id=NEW.run_id)<>NEW.slot_count THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
   NEW.activated_at:=now_at;
  ELSE
   IF ROW(NEW.boot_id,NEW.activated_at) IS DISTINCT FROM ROW(OLD.boot_id,OLD.activated_at)
    OR NOT (NEW.state=OLD.state OR (OLD.state='ACTIVE' AND NEW.state IN ('CLOSED','EXPIRED')))
    OR (NEW.state='EXPIRED' AND now_at<NEW.expires_at) THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  END IF;
  IF NEW.counters<>OLD.counters AND (OLD.state<>'ACTIVE' OR NEW.state<>'ACTIVE' OR now_at<NEW.not_before OR now_at>=NEW.expires_at) THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_run BEFORE INSERT OR UPDATE OR DELETE ON phase30_test_execution.runs
 FOR EACH ROW EXECUTE FUNCTION phase30_test_execution.guard_run();
CREATE FUNCTION phase30_test_execution.guard_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent phase30_test_execution.runs%ROWTYPE; now_at timestamptz:=clock_timestamp();
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 SELECT * INTO parent FROM phase30_test_execution.runs WHERE run_id=NEW.run_id FOR UPDATE;
 now_at:=clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 IF TG_OP='INSERT' THEN
  IF parent.state<>'PREPARED' OR parent.preparation_sealed OR now_at>=parent.expires_at OR NEW.state<>'AVAILABLE' OR NEW.reserved_at IS NOT NULL
   OR (SELECT count(*) FROM phase30_test_execution.slots WHERE run_id=NEW.run_id)>=parent.slot_count THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 ELSE
  IF ROW(NEW.run_id,NEW.slot_key,NEW.operation_key,NEW.role,NEW.id,NEW.attachment_id)
   IS DISTINCT FROM ROW(OLD.run_id,OLD.slot_key,OLD.operation_key,OLD.role,OLD.id,OLD.attachment_id)
   OR NOT (OLD.state='AVAILABLE' AND NEW.state='BURNED') OR parent.request_count>0 OR parent.state<>'ACTIVE'
   OR now_at<parent.not_before OR now_at>=parent.expires_at THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  NEW.reserved_at:=now_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_slot BEFORE INSERT OR UPDATE OR DELETE ON phase30_test_execution.slots
 FOR EACH ROW EXECUTE FUNCTION phase30_test_execution.guard_slot();
CREATE FUNCTION phase30_test_execution.refuse_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END $$;
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON phase30_test_execution.runs
 FOR EACH STATEMENT EXECUTE FUNCTION phase30_test_execution.refuse_truncate();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON phase30_test_execution.slots
 FOR EACH STATEMENT EXECUTE FUNCTION phase30_test_execution.refuse_truncate();

CREATE FUNCTION phase30_test_execution.guard_request_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent phase30_test_execution.runs%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 SELECT * INTO parent FROM phase30_test_execution.runs WHERE run_id=NEW.run_id FOR UPDATE;
 IF NOT FOUND OR parent.state<>'PREPARED' OR parent.preparation_sealed OR clock_timestamp()>=parent.expires_at
  OR (SELECT count(*) FROM phase30_test_execution.request_candidates WHERE run_id=NEW.run_id)>=parent.candidate_count
 THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_request_candidate BEFORE INSERT OR UPDATE OR DELETE ON phase30_test_execution.request_candidates
 FOR EACH ROW EXECUTE FUNCTION phase30_test_execution.guard_request_candidate();
CREATE FUNCTION phase30_test_execution.guard_request_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent phase30_test_execution.runs%ROWTYPE; now_at timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 SELECT * INTO parent FROM phase30_test_execution.runs WHERE run_id=NEW.run_id FOR UPDATE;
 now_at:=clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 IF TG_OP='INSERT' THEN
  IF parent.state<>'PREPARED' OR parent.preparation_sealed OR now_at>=parent.expires_at OR NEW.state<>'AVAILABLE' OR NEW.reserved_at IS NOT NULL OR NEW.boot_id IS NOT NULL
   OR (SELECT count(*) FROM phase30_test_execution.request_attempts WHERE run_id=NEW.run_id)>=parent.request_count THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 ELSE
  IF ROW(NEW.run_id,NEW.attempt_key,NEW.candidate_key) IS DISTINCT FROM ROW(OLD.run_id,OLD.attempt_key,OLD.candidate_key)
   OR OLD.state<>'AVAILABLE' OR NEW.state<>'RESERVED' OR NEW.boot_id IS DISTINCT FROM parent.boot_id
   OR parent.state<>'ACTIVE' OR NOT parent.preparation_sealed OR now_at<parent.not_before OR now_at>=parent.expires_at THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  NEW.reserved_at:=now_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_request_attempt BEFORE INSERT OR UPDATE OR DELETE ON phase30_test_execution.request_attempts
 FOR EACH ROW EXECUTE FUNCTION phase30_test_execution.guard_request_attempt();
CREATE FUNCTION phase30_test_execution.charge_request_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 UPDATE phase30_test_execution.runs SET counters=phase30_test_execution.request_totals(NEW.run_id,true) WHERE run_id=NEW.run_id;
 RETURN NEW;
END $$;
CREATE TRIGGER charge_request_attempt AFTER UPDATE ON phase30_test_execution.request_attempts
 FOR EACH ROW EXECUTE FUNCTION phase30_test_execution.charge_request_attempt();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON phase30_test_execution.request_candidates
 FOR EACH STATEMENT EXECUTE FUNCTION phase30_test_execution.refuse_truncate();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON phase30_test_execution.request_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION phase30_test_execution.refuse_truncate();
`;
