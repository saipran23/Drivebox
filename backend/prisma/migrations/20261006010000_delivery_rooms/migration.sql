-- DropIndex
DROP INDEX `files_provider_file_id_idx` ON `files`;

-- AlterTable
ALTER TABLE `files` ADD COLUMN `delivery_room_id` CHAR(36) NULL,
    MODIFY `provider_file_id` TEXT NOT NULL;

-- CreateTable
CREATE TABLE `delivery_rooms` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `token_encrypted` TEXT NOT NULL,
    `password_hash` VARCHAR(255) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `expires_at` DATETIME(3) NOT NULL,
    `max_files` INTEGER NOT NULL,
    `max_bytes` BIGINT NOT NULL,
    `uploaded_files` INTEGER NOT NULL DEFAULT 0,
    `uploaded_bytes` BIGINT NOT NULL DEFAULT 0,
    `auth_window_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `auth_attempts` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `delivery_rooms_token_hash_key`(`token_hash`),
    INDEX `delivery_rooms_user_id_status_created_at_idx`(`user_id`, `status`, `created_at`),
    INDEX `delivery_rooms_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `delivery_uploads` (
    `id` CHAR(36) NOT NULL,
    `room_id` CHAR(36) NOT NULL,
    `request_key` CHAR(36) NOT NULL,
    `provider_file_id` TEXT NULL,
    `cleanup_next_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(191) NOT NULL,
    `size_bytes` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'uploading',
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `delivery_uploads_room_id_status_expires_at_idx`(`room_id`, `status`, `expires_at`),
    INDEX `delivery_uploads_status_cleanup_next_at_idx`(`status`, `cleanup_next_at`),
    UNIQUE INDEX `delivery_uploads_room_id_request_key_key`(`room_id`, `request_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `files_delivery_room_id_created_at_idx` ON `files`(`delivery_room_id`, `created_at`);

-- CreateIndex
CREATE INDEX `files_provider_file_id_idx` ON `files`(`provider_file_id`(191));

-- AddForeignKey
ALTER TABLE `files` ADD CONSTRAINT `files_delivery_room_id_fkey` FOREIGN KEY (`delivery_room_id`) REFERENCES `delivery_rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_rooms` ADD CONSTRAINT `delivery_rooms_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_uploads` ADD CONSTRAINT `delivery_uploads_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `delivery_rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

