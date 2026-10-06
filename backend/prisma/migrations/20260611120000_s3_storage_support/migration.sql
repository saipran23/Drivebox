ALTER TABLE `connected_accounts` MODIFY `access_token_encrypted` TEXT NULL;
ALTER TABLE `connected_accounts` MODIFY `refresh_token_encrypted` TEXT NULL;
ALTER TABLE `connected_accounts` MODIFY `token_expires_at` DATETIME(3) NULL;
ALTER TABLE `connected_accounts` MODIFY `provider_config_id` CHAR(36) NULL;

CREATE TABLE `s3_storage_configs` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `connected_account_id` CHAR(36) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `bucket` VARCHAR(191) NOT NULL,
  `region` VARCHAR(191) NOT NULL,
  `endpoint` TEXT NULL,
  `access_key_id_encrypted` TEXT NOT NULL,
  `secret_access_key_encrypted` TEXT NOT NULL,
  `force_path_style` BOOLEAN NOT NULL DEFAULT false,
  `prefix` VARCHAR(191) NOT NULL DEFAULT '9drive',
  `quota_bytes` BIGINT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `s3_storage_configs_connected_account_id_key` ON `s3_storage_configs`(`connected_account_id`);
CREATE INDEX `s3_storage_configs_user_id_idx` ON `s3_storage_configs`(`user_id`);
CREATE INDEX `s3_storage_configs_user_id_status_idx` ON `s3_storage_configs`(`user_id`, `status`);

ALTER TABLE `s3_storage_configs` ADD CONSTRAINT `s3_storage_configs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `s3_storage_configs` ADD CONSTRAINT `s3_storage_configs_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
