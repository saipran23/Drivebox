CREATE TABLE `api_keys` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `key_prefix` VARCHAR(32) NOT NULL,
  `key_hash` VARCHAR(255) NOT NULL,
  `scopes` JSON NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `last_used_at` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `api_keys_key_hash_key`(`key_hash`),
  INDEX `api_keys_user_id_idx`(`user_id`),
  INDEX `api_keys_user_id_status_created_at_idx`(`user_id`, `status`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
