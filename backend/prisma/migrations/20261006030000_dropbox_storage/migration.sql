ALTER TABLE `upload_sessions` ADD COLUMN `dropbox_session_id` TEXT NULL, ADD COLUMN `dropbox_path` TEXT NULL, ADD COLUMN `dropbox_offset` BIGINT NOT NULL DEFAULT 0;
ALTER TABLE `upload_attempts` ADD COLUMN `dropbox_path` TEXT NULL;
