BEGIN;

DROP TABLE IF EXISTS speaking_room_chat_messages;
DROP TABLE IF EXISTS speaking_room_reports;
DROP TABLE IF EXISTS speaking_room_participant_blocks;
DROP TABLE IF EXISTS speaking_room_participant_moderation_state;
DROP TABLE IF EXISTS speaking_room_moderation_actions;
DROP TABLE IF EXISTS speaking_room_queue_actions;
DROP TABLE IF EXISTS speaking_room_queue_entries;

DROP TYPE IF EXISTS speaking_room_report_state;
DROP TYPE IF EXISTS speaking_room_report_category;
DROP TYPE IF EXISTS speaking_room_moderation_action;
DROP TYPE IF EXISTS speaking_room_queue_action;
DROP TYPE IF EXISTS speaking_room_queue_state;

COMMIT;
