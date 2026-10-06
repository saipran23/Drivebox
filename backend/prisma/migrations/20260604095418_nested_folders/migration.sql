-- AlterTable
ALTER TABLE `folders` ADD COLUMN `parent_id` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `folders_parent_id_idx` ON `folders`(`parent_id`);

-- AddForeignKey
ALTER TABLE `folders` ADD CONSTRAINT `folders_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `folders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
