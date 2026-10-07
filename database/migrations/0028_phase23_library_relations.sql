CREATE TABLE library_resource_relations (
  anchor_resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE CASCADE,
  target_resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE CASCADE,
  relation_type text NOT NULL CHECK (relation_type IN ('SAME_CONCEPT','PREREQUISITE','FOLLOW_UP','DIRECT_TRANSLATION','COLLECTION_MEMBER')),
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL CHECK (isfinite(reviewed_at)),
  evidence_reference varchar(500) NOT NULL CHECK (evidence_reference=btrim(evidence_reference) AND char_length(evidence_reference) BETWEEN 1 AND 500),
  anchor_snapshot text NOT NULL CHECK (anchor_snapshot ~ '^[a-f0-9]{64}$'),
  target_snapshot text NOT NULL CHECK (target_snapshot ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  PRIMARY KEY(anchor_resource_id,target_resource_id,relation_type),
  CHECK(anchor_resource_id <> target_resource_id)
);
CREATE INDEX library_resource_relations_anchor_order_idx ON library_resource_relations(anchor_resource_id,target_resource_id,relation_type) WHERE status='ACTIVE';
CREATE INDEX library_resource_relations_target_idx ON library_resource_relations(target_resource_id,anchor_resource_id);
