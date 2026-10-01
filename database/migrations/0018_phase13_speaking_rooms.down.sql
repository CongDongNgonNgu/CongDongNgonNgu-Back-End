BEGIN;

DROP TABLE IF EXISTS speaking_room_moderators;
DROP TABLE IF EXISTS speaking_rooms;
DROP TYPE IF EXISTS speaking_room_lifecycle;
DROP TYPE IF EXISTS speaking_room_visibility;

COMMIT;
