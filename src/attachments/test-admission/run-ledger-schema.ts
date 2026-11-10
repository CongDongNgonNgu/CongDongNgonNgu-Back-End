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
CREATE FUNCTION phase30_test_execution.guard_run() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE k text; maximum jsonb := '${maximum}'::jsonb; now_at timestamptz := clock_timestamp();
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
  IF NEW.state<>'PREPARED' OR NEW.counters<>'${zero}'::jsonb OR NEW.recovery_debt THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 ELSE
  IF ROW(NEW.run_id,NEW.activation_id,NEW.manifest_sha256,NEW.source_sha,NEW.service_id,NEW.issued_at,NEW.not_before,NEW.expires_at,NEW.limits,NEW.slot_count)
   IS DISTINCT FROM ROW(OLD.run_id,OLD.activation_id,OLD.manifest_sha256,OLD.source_sha,OLD.service_id,OLD.issued_at,OLD.not_before,OLD.expires_at,OLD.limits,OLD.slot_count)
   OR (OLD.recovery_debt AND NOT NEW.recovery_debt) THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  FOR k IN SELECT jsonb_object_keys(maximum) LOOP
   IF (NEW.counters->>k)::numeric<(OLD.counters->>k)::numeric THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
  END LOOP;
  IF OLD.state='PREPARED' AND NEW.state='ACTIVE' THEN
   IF now_at<NEW.not_before OR now_at>=NEW.expires_at OR NEW.boot_id IS NULL
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
  IF parent.state<>'PREPARED' OR now_at>=parent.expires_at OR NEW.state<>'AVAILABLE' OR NEW.reserved_at IS NOT NULL
   OR (SELECT count(*) FROM phase30_test_execution.slots WHERE run_id=NEW.run_id)>=parent.slot_count THEN RAISE EXCEPTION 'TEST_ADMISSION_LEDGER'; END IF;
 ELSE
  IF ROW(NEW.run_id,NEW.slot_key,NEW.operation_key,NEW.role,NEW.id,NEW.attachment_id)
   IS DISTINCT FROM ROW(OLD.run_id,OLD.slot_key,OLD.operation_key,OLD.role,OLD.id,OLD.attachment_id)
   OR NOT (OLD.state='AVAILABLE' AND NEW.state='BURNED') OR parent.state<>'ACTIVE'
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
`;
