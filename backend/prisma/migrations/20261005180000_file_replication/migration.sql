ALTER TABLE `files`
  ADD COLUMN `replication_copies` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `replication_next_at` DATETIME(3) NULL,
  ADD COLUMN `replication_error` VARCHAR(255) NULL,
  ADD COLUMN `replication_lock_token` CHAR(36) NULL,
  ADD COLUMN `replication_lock_until` DATETIME(3) NULL;
CREATE INDEX `files_status_replication_next_at_replication_lock_until_idx` ON `files`(`status`, `replication_next_at`, `replication_lock_until`);
CREATE TABLE `replication_policies` (
  `user_id` CHAR(36) NOT NULL,
  `copies` INTEGER NOT NULL DEFAULT 1,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `file_replicas` (
  `id` CHAR(36) NOT NULL,
  `file_id` CHAR(36) NOT NULL,
  `connected_account_id` CHAR(36) NOT NULL,
  `provider` VARCHAR(32) NOT NULL,
  `provider_file_id` TEXT NULL,
  `s3_upload_id` TEXT NULL,
  `is_primary` BOOLEAN NOT NULL DEFAULT false,
  `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  `size_bytes` BIGINT NOT NULL,
  `quota_accounted` BOOLEAN NOT NULL DEFAULT false,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `last_error` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `file_replicas_file_id_connected_account_id_key` (`file_id`, `connected_account_id`),
  INDEX `file_replicas_connected_account_id_status_quota_accounted_idx` (`connected_account_id`, `status`, `quota_accounted`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `replication_policies` ADD CONSTRAINT `replication_policies_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `file_replicas` ADD CONSTRAINT `file_replicas_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `file_replicas` ADD CONSTRAINT `file_replicas_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
-- Preserve every legacy logical file and register its existing physical copy.
INSERT INTO `file_replicas` (`id`, `file_id`, `connected_account_id`, `provider`, `provider_file_id`, `is_primary`, `status`, `size_bytes`, `quota_accounted`, `created_at`, `updated_at`)
SELECT `id`, `id`, `connected_account_id`, `provider`, `provider_file_id`, true, 'AVAILABLE', `size_bytes`, true, `created_at`, `updated_at` FROM `files`;
