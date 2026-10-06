-- DropForeignKey
ALTER TABLE `provider_configs` DROP FOREIGN KEY `provider_configs_user_id_fkey`;

-- AlterTable
ALTER TABLE `provider_configs` MODIFY `user_id` CHAR(36) NULL;

-- AddForeignKey
ALTER TABLE `provider_configs` ADD CONSTRAINT `provider_configs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
