-- AlterTable
ALTER TABLE `files` ADD COLUMN `folder_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `folders` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NULL,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'google_drive',
    `provider_folder_id` VARCHAR(191) NULL,
    `name` VARCHAR(255) NOT NULL,
    `color` VARCHAR(64) NOT NULL DEFAULT 'text-blue-500',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `folders_user_id_idx`(`user_id`),
    INDEX `folders_connected_account_id_idx`(`connected_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `files_folder_id_idx` ON `files`(`folder_id`);

-- AddForeignKey
ALTER TABLE `files` ADD CONSTRAINT `files_folder_id_fkey` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `folders` ADD CONSTRAINT `folders_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `folders` ADD CONSTRAINT `folders_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
