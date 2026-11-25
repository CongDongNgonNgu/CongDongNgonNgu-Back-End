/** Explicit tooling DDL only; install only within separately reviewed owned-schema
 * proof/setup. No import-time connection, installer, activation or product migration. */
export const ACTIVATION_CONTROL_DDL = `
CREATE TABLE phase30_test_execution.activation_controls (
 run_id uuid PRIMARY KEY REFERENCES phase30_test_execution.runs(run_id),
 activation_id uuid NOT NULL,
 source_sha text NOT NULL CHECK(source_sha ~ '^[a-f0-9]{40}$'),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 service_id text NOT NULL CHECK(service_id='srv-dahnerh594qs73fp3420'), branch text NOT NULL CHECK(branch='dev'),
 deployment_id text NOT NULL CHECK(deployment_id ~ '^dep-[a-z0-9-]{1,80}$'),
 boot_id uuid NOT NULL UNIQUE CHECK(boot_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 not_before timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 armed_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 state text NOT NULL DEFAULT 'ARMED' CHECK(state IN ('ARMED','RECEIPT_STORED')),
 receipt jsonb, receipt_stored_at timestamptz,
 CHECK((state='ARMED' AND receipt IS NULL AND receipt_stored_at IS NULL) OR
  (state='RECEIPT_STORED' AND receipt IS NOT NULL AND receipt_stored_at IS NOT NULL)),
 CHECK(expires_at>not_before AND expires_at<=not_before+interval '10 minutes')
);
CREATE FUNCTION phase30_test_execution.guard_activation_control() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent phase30_test_execution.runs%ROWTYPE; now_at timestamptz; observed timestamptz; observed_text text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END IF;
 SELECT * INTO parent FROM phase30_test_execution.runs WHERE run_id=NEW.run_id FOR UPDATE;
 now_at:=clock_timestamp();
 IF NOT FOUND OR NOT parent.activation_control_required OR NOT parent.preparation_sealed OR parent.state<>'PREPARED'
  OR now_at>=parent.expires_at
  OR ROW(NEW.run_id,NEW.activation_id,NEW.source_sha,NEW.manifest_sha256,NEW.service_id,NEW.not_before,NEW.expires_at)
   IS DISTINCT FROM ROW(parent.run_id,parent.activation_id,parent.source_sha,parent.manifest_sha256,parent.service_id,parent.not_before,parent.expires_at)
  OR NEW.branch<>'dev' OR NEW.deployment_id !~ '^dep-[a-z0-9-]{1,80}$'
  OR NEW.not_before<>date_trunc('milliseconds',NEW.not_before) OR NEW.expires_at<>date_trunc('milliseconds',NEW.expires_at)
 THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'ARMED' OR NEW.receipt IS NOT NULL OR NEW.receipt_stored_at IS NOT NULL THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END IF;
  NEW.armed_at:=date_trunc('milliseconds',now_at);
 ELSE
  IF ROW(NEW.run_id,NEW.activation_id,NEW.source_sha,NEW.manifest_sha256,NEW.service_id,NEW.branch,NEW.deployment_id,NEW.boot_id,NEW.not_before,NEW.expires_at,NEW.armed_at)
   IS DISTINCT FROM ROW(OLD.run_id,OLD.activation_id,OLD.source_sha,OLD.manifest_sha256,OLD.service_id,OLD.branch,OLD.deployment_id,OLD.boot_id,OLD.not_before,OLD.expires_at,OLD.armed_at)
   OR OLD.state<>'ARMED' OR NEW.state<>'RECEIPT_STORED' OR NEW.receipt_stored_at IS NOT NULL
   OR jsonb_typeof(NEW.receipt) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.receipt))<>10
   OR NOT (NEW.receipt ?& ARRAY['service','branch','sha','manifestSha256','deploymentId','bootId','observedAt','liveObserved','originalDisabledCommandObserved','allFourFlagsFalseObserved'])
   OR NEW.receipt->'service' IS DISTINCT FROM to_jsonb(NEW.service_id)
   OR NEW.receipt->'branch' IS DISTINCT FROM to_jsonb(NEW.branch)
   OR NEW.receipt->'sha' IS DISTINCT FROM to_jsonb(NEW.source_sha)
   OR NEW.receipt->'manifestSha256' IS DISTINCT FROM to_jsonb(NEW.manifest_sha256)
   OR NEW.receipt->'deploymentId' IS DISTINCT FROM to_jsonb(NEW.deployment_id)
   OR NEW.receipt->'bootId' IS DISTINCT FROM to_jsonb(NEW.boot_id::text)
   OR NEW.receipt->'liveObserved' IS DISTINCT FROM 'true'::jsonb
   OR NEW.receipt->'originalDisabledCommandObserved' IS DISTINCT FROM 'true'::jsonb
   OR NEW.receipt->'allFourFlagsFalseObserved' IS DISTINCT FROM 'true'::jsonb
   OR jsonb_typeof(NEW.receipt->'observedAt') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END IF;
  observed_text:=NEW.receipt->>'observedAt';
  IF observed_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
   THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END IF;
  BEGIN observed:=observed_text::timestamptz; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END;
  IF to_char(observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>observed_text
   OR observed<NEW.armed_at OR observed>now_at OR now_at-observed>interval '5 minutes'
  THEN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END IF;
  NEW.receipt_stored_at:=date_trunc('milliseconds',now_at);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_activation_control BEFORE INSERT OR UPDATE OR DELETE ON phase30_test_execution.activation_controls
 FOR EACH ROW EXECUTE FUNCTION phase30_test_execution.guard_activation_control();
CREATE FUNCTION phase30_test_execution.refuse_activation_control_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'TEST_ACTIVATION_CONTROL'; END $$;
CREATE TRIGGER refuse_activation_control_truncate BEFORE TRUNCATE ON phase30_test_execution.activation_controls
 FOR EACH STATEMENT EXECUTE FUNCTION phase30_test_execution.refuse_activation_control_truncate();
`;
