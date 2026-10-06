-- AlterTable
ALTER TABLE `oauth_states` ADD COLUMN `flow` VARCHAR(32) NOT NULL DEFAULT 'connect';

-- AlterTable
ALTER TABLE `oauth_states` MODIFY `user_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `auth_handoffs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `auth_handoffs_token_hash_key`(`token_hash`),
    INDEX `auth_handoffs_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_handoffs` ADD CONSTRAINT `auth_handoffs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
