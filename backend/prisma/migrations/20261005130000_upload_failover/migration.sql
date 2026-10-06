ALTER TABLE `upload_sessions`
 ADD COLUMN `generation` INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN `original_account_id` CHAR(36) NULL,
 ADD COLUMN `last_failure_code` VARCHAR(64) NULL;
CREATE TABLE `upload_attempts` (
 `id` CHAR(36) NOT NULL,
 `session_id` CHAR(36) NOT NULL,
 `generation` INTEGER NOT NULL,
 `account_id` CHAR(36) NOT NULL,
 `provider` VARCHAR(32) NOT NULL,
 `s3_upload_id` TEXT NULL,
 `s3_object_key` TEXT NULL,
 `google_session_uri` TEXT NULL,
 `failure_recorded` BOOLEAN NOT NULL DEFAULT false,
 `cleanup_pending` BOOLEAN NOT NULL DEFAULT false,
 `next_cleanup_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY (`id`),
 UNIQUE INDEX `upload_attempts_session_id_generation_key` (`session_id`, `generation`),
 INDEX `upload_attempts_session_id_account_id_idx` (`session_id`, `account_id`),
 INDEX `upload_attempts_cleanup_pending_next_cleanup_at_idx` (`cleanup_pending`, `next_cleanup_at`),
 CONSTRAINT `upload_attempts_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `upload_sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
