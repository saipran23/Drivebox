ALTER TABLE `upload_sessions`
 ADD COLUMN `s3_upload_id` TEXT NULL,
 ADD COLUMN `s3_object_key` TEXT NULL,
 ADD COLUMN `chunk_size_bytes` INTEGER NOT NULL DEFAULT 5242880,
 ADD COLUMN `expires_at` DATETIME(3) NULL,
 ADD COLUMN `lock_token` CHAR(36) NULL,
 ADD COLUMN `lock_expires_at` DATETIME(3) NULL;
CREATE INDEX `upload_sessions_status_expires_at_idx` ON `upload_sessions`(`status`, `expires_at`);
